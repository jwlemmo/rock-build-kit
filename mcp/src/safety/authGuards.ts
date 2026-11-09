/**
 * Guards for raw-SQL writes to Rock's Auth table (rock_create/edit/delete, mode:"sql").
 *
 * Rock core has no self-lockout protection (Spark's notes): a raw INSERT/UPDATE/DELETE on Auth
 * can remove the administrators' own access, or deny the person whose API key is in use. This
 * module only acts when the statement writes Auth; anything else returns ok with no messages.
 *
 * Errors (the write is refused):
 *   - deleting or changing an Auth row of the "RSR - Rock Administration" role that is an Allow
 *     row or an Administrate row (we refuse both readings of "Allow/Administrate");
 *   - adding (or updating a row into) a Deny Administrate that could cover that role or the
 *     API key's own person: the role itself, All Users / All Authenticated Users, any group the
 *     key's person is an active member of, the key person's aliases, or a value we cannot read.
 * Warnings:
 *   - a person-level rule (PersonAliasId set) with Order >= 0 — person rules should sort low or
 *     negative so they beat the stock role rules;
 *   - EntityId = 0 (the entity-type default row, which affects every entity of that type) unless
 *     the entity type is RestController (our documented controller grants);
 *   - a record-level INSERT with no NOT EXISTS guard on ANY existing Auth row for that
 *     EntityTypeId + EntityId + Action (the first explicit row on an entity stops it inheriting
 *     from its parent, so everyone not named loses access).
 *
 * Parsing is token-level. It fails SAFE: when a destructive Administrate change cannot be ruled
 * out it is an error, and anything else it cannot read is a warning — never a silent ok.
 */

import type { RockClient } from '../rock-client.js';
import { removeComments, validateSelectOnly } from '../sql-validator.js';
import {
  maskLiterals,
  parseInsert,
  parseLiteral,
  splitTopLevel,
  findTopLevelKeyword,
  normalizeIdent,
  writeVerb,
  type Literal,
} from './sqlPreflight.js';

export interface AuthGuardContext {
  client: RockClient;
}

export interface AuthGuardResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Stock Guid of the "RSR - Rock Administration" security role. */
const ADMIN_ROLE_GUID = '628C51A8-4613-43ED-A18D-4A6FB999273E';
const ADMIN_ROLE_NAME = 'RSR - Rock Administration';

// SpecialRole enum: 0 None, 1 All Users, 2 All Authenticated Users, 3 All Un-Authenticated Users.
const SPECIAL_ROLES_COVERING_ADMINS = new Set([1, 2]);

const AUTH_REF = String.raw`(?:\[?dbo\]?\.)?\[?Auth\]?(?![\w\]])`;

/** True when the statement's write target is the Auth table (directly or via an alias). */
export function writesAuthTable(sql: string): boolean {
  const s = removeComments(sql).replace(/\s+/g, ' ').trim();
  const masked = maskLiterals(s);
  if (new RegExp(`^INSERT\\s+(?:INTO\\s+)?${AUTH_REF}`, 'i').test(masked)) return true;
  if (new RegExp(`^UPDATE\\s+(?:TOP\\s*\\(\\s*\\d+\\s*\\)\\s*)?${AUTH_REF}`, 'i').test(masked)) return true;
  if (new RegExp(`^DELETE\\s+(?:TOP\\s*\\(\\s*\\d+\\s*\\)\\s*)?(?:FROM\\s+)?${AUTH_REF}`, 'i').test(masked)) return true;
  // UPDATE a SET … FROM Auth a … / DELETE a FROM Auth a …
  const alias = masked.match(/^(?:UPDATE|DELETE)\s+(?:TOP\s*\(\s*\d+\s*\)\s*)?\[?(\w+)\]?\s+(?:SET|FROM)\b/i)?.[1];
  if (alias) {
    const m = masked.match(new RegExp(`\\b(?:FROM|JOIN)\\s+${AUTH_REF}\\s+(?:AS\\s+)?\\[?${alias}\\]?(?![\\w\\]])`, 'i'));
    if (m) return true;
  }
  return false;
}

interface Who {
  adminGroupId?: number;
  keyPersonId?: number;
  keyAliasIds: number[];
  lookupErrors: string[];
}

async function lookupWho(client: RockClient): Promise<Who> {
  const who: Who = { keyAliasIds: [], lookupErrors: [] };
  try {
    const rows = await client.executeSql<Array<Record<string, unknown>>>(
      `SELECT TOP 1 Id FROM [Group] WHERE IsSecurityRole = 1 AND (Guid = '${ADMIN_ROLE_GUID}' OR Name = '${ADMIN_ROLE_NAME}') ORDER BY CASE WHEN Guid = '${ADMIN_ROLE_GUID}' THEN 0 ELSE 1 END`
    );
    const id = Number(Array.isArray(rows) && rows[0] ? rows[0].Id : NaN);
    if (Number.isInteger(id) && id > 0) who.adminGroupId = id;
    else who.lookupErrors.push(`could not find the "${ADMIN_ROLE_NAME}" role`);
  } catch (err) {
    who.lookupErrors.push(`admin role lookup failed (${err instanceof Error ? err.message : String(err)})`);
  }
  try {
    const me = await client.v1Get<Record<string, unknown>>('People/GetCurrentPerson');
    const pid = Number(me?.Id);
    if (Number.isInteger(pid) && pid > 0) {
      who.keyPersonId = pid;
      const rows = await client.executeSql<Array<Record<string, unknown>>>(`SELECT Id FROM PersonAlias WHERE PersonId = ${pid}`);
      who.keyAliasIds = (Array.isArray(rows) ? rows : []).map((r) => Number(r.Id)).filter((n) => Number.isInteger(n));
      const primary = Number(me?.PrimaryAliasId);
      if (Number.isInteger(primary) && !who.keyAliasIds.includes(primary)) who.keyAliasIds.push(primary);
    } else {
      who.lookupErrors.push("could not identify the API key's person");
    }
  } catch (err) {
    who.lookupErrors.push(`API key person lookup failed (${err instanceof Error ? err.message : String(err)})`);
  }
  return who;
}

async function keyPersonInGroup(client: RockClient, who: Who, groupId: number): Promise<boolean | undefined> {
  if (who.keyPersonId === undefined) return undefined;
  try {
    const rows = await client.executeSql<Array<Record<string, unknown>>>(
      `SELECT COUNT(*) AS N FROM GroupMember WHERE GroupId = ${groupId} AND PersonId = ${who.keyPersonId} AND IsArchived = 0 AND GroupMemberStatus = 1`
    );
    return Number(Array.isArray(rows) && rows[0] ? rows[0].N : NaN) > 0;
  } catch {
    return undefined;
  }
}

/** One Auth row as far as we can read it. Missing key = column not supplied (NULL / default). */
type AuthRow = Partial<Record<'entitytypeid' | 'entityid' | 'order' | 'action' | 'allowordeny' | 'specialrole' | 'groupid' | 'personaliasid', Literal>>;

const isUnknown = (l: Literal | undefined) => l?.kind === 'unknown';
const num = (l: Literal | undefined) => (l?.kind === 'number' ? l.value : undefined);
const str = (l: Literal | undefined) => (l?.kind === 'string' ? l.value.trim().toLowerCase() : undefined);

/**
 * Could this row be a Deny Administrate covering the admin role or the key person?
 * Returns a reason string if so (or if it cannot be ruled out), else undefined.
 */
async function denyAdministrateRisk(row: AuthRow, client: RockClient, who: Who): Promise<string | undefined> {
  const action = str(row.action);
  const allow = str(row.allowordeny);
  const actionMaybeAdmin = action === 'administrate' || (action === undefined && (isUnknown(row.action) || row.action === undefined));
  const denyMaybe = allow === 'd' || (allow === undefined && (isUnknown(row.allowordeny) || row.allowordeny === undefined));
  if (!actionMaybeAdmin || !denyMaybe) return undefined;
  const sure = action === 'administrate' && allow === 'd';
  const label = sure ? 'a Deny Administrate rule' : 'a rule that may be a Deny Administrate (could not read Action/AllowOrDeny)';

  const special = num(row.specialrole);
  if (isUnknown(row.specialrole)) return `${label} with a SpecialRole value that could not be read`;
  if (special !== undefined && SPECIAL_ROLES_COVERING_ADMINS.has(special)) return `${label} for ${special === 1 ? 'All Users' : 'All Authenticated Users'}`;

  if (isUnknown(row.groupid)) return `${label} with a GroupId that could not be read`;
  const gid = num(row.groupid);
  if (gid !== undefined) {
    if (who.adminGroupId === undefined) return `${label} for group ${gid}, and the admin role could not be looked up`;
    if (gid === who.adminGroupId) return `${label} for ${ADMIN_ROLE_NAME}`;
    const member = await keyPersonInGroup(client, who, gid);
    if (member === undefined) return `${label} for group ${gid}, and membership of the API key's person could not be checked`;
    if (member) return `${label} for group ${gid}, which the API key's person belongs to`;
  }

  if (isUnknown(row.personaliasid)) return `${label} with a PersonAliasId that could not be read`;
  const pa = num(row.personaliasid);
  if (pa !== undefined) {
    if (who.keyPersonId === undefined) return `${label} for person alias ${pa}, and the API key's person could not be looked up`;
    if (who.keyAliasIds.includes(pa)) return `${label} for the API key's own person`;
  }
  return undefined;
}

async function isRestControllerType(client: RockClient, sqlText: string, entityTypeId: Literal | undefined): Promise<boolean> {
  if (/'Rock\.Model\.RestController'/i.test(sqlText)) return true;
  const id = num(entityTypeId);
  if (id === undefined) return false;
  try {
    const rows = await client.executeSql<Array<Record<string, unknown>>>(`SELECT Name FROM EntityType WHERE Id = ${id}`);
    return Array.isArray(rows) && rows[0] ? String(rows[0].Name) === 'Rock.Model.RestController' : false;
  } catch {
    return false;
  }
}

/** Does the tail of an INSERT carry NOT EXISTS (… FROM Auth … EntityTypeId … EntityId … Action …)? */
function guardStatus(tail: string): 'any-row' | 'narrowed' | 'none' {
  const masked = maskLiterals(tail);
  const re = /NOT\s+EXISTS\s*\(/gi;
  let best: 'any-row' | 'narrowed' | 'none' = 'none';
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === '(') depth++;
      else if (masked[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
    }
    const body = masked.slice(open, close < 0 ? masked.length : close + 1);
    if (!new RegExp(`\\bFROM\\s+${AUTH_REF}`, 'i').test(body)) continue;
    if (!/\bEntityTypeId\b/i.test(body) || !/\bEntityId\b/i.test(body) || !/\bAction\b/i.test(body)) continue;
    if (/\b(GroupId|PersonAliasId|SpecialRole)\b/i.test(body)) { if (best === 'none') best = 'narrowed'; continue; }
    best = 'any-row';
  }
  return best;
}

export async function checkAuthWrite(sql: string, ctx: AuthGuardContext): Promise<AuthGuardResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const done = (): AuthGuardResult => ({ ok: errors.length === 0, errors, warnings });
  if (!sql || !writesAuthTable(sql)) return done();

  const text = removeComments(sql).replace(/\s+/g, ' ').trim();
  const masked = maskLiterals(text);
  const verb = writeVerb(text);
  const who = await lookupWho(ctx.client);
  const lookupNote = who.lookupErrors.length ? ` (${who.lookupErrors.join('; ')})` : '';
  const mentionsAdministrate = /administrate/i.test(text);

  if (verb === 'INSERT') {
    const parsed = parseInsert(text);
    if ('error' in parsed) {
      (mentionsAdministrate ? errors : warnings).push(`Auth INSERT could not be read (${parsed.error}); lockout checks were not possible.`);
      return done();
    }
    const cols = parsed.columns.map((c) => normalizeIdent(c));
    for (const values of parsed.rows) {
      const row: AuthRow = {};
      cols.forEach((c, i) => { (row as Record<string, Literal>)[c] = parseLiteral(values[i] ?? ''); });

      const risk = await denyAdministrateRisk(row, ctx.client, who);
      if (risk) errors.push(`Refused: this adds ${risk}. That could lock out the Rock administrators or the API key's own person${lookupNote}.`);

      // Person-level rule ordering.
      const pa = row.personaliasid;
      if (pa && pa.kind !== 'null') {
        const order = row.order;
        if (!order || order.kind !== 'number') warnings.push('Person-level Auth rule: could not read [Order]; use a low or negative Order so it sorts before the stock role rules.');
        else if (order.value >= 0) warnings.push(`Person-level Auth rule has Order ${order.value}; use a negative Order so it sorts before the stock role rules.`);
      }

      // Entity-type default row.
      const eid = row.entityid;
      if (eid?.kind === 'number' && eid.value === 0) {
        if (!(await isRestControllerType(ctx.client, text, row.entitytypeid))) {
          warnings.push('EntityId = 0 is the entity-type default row: it applies to EVERY entity of that type, not one record.');
        }
      } else if (eid && eid.kind !== 'null') {
        // Record-level insert (literal id or an expression such as rc.Id).
        const g = guardStatus(parsed.tail);
        if (g !== 'any-row') {
          warnings.push(
            (g === 'narrowed'
              ? 'The NOT EXISTS guard only checks rows for this group/person. '
              : 'Record-level Auth INSERT has no NOT EXISTS guard on existing Auth rows. ') +
              'Guard on ANY existing row for the same EntityTypeId + EntityId + Action: the first explicit row on an entity stops it inheriting from its parent, so everyone not named loses access.'
          );
        }
      }
    }
    return done();
  }

  // UPDATE / DELETE — find the rows it would touch with a read-only SELECT over the same FROM/WHERE.
  let preview: string | undefined;
  let alias = 'Auth';
  let setPairs: Array<{ col: string; value: Literal }> = [];
  if (verb === 'DELETE') {
    const m = text.match(new RegExp(`^DELETE\\s+(?:FROM\\s+)?${AUTH_REF}\\s*(.*)$`, 'i'));
    const am = text.match(/^DELETE\s+\[?(\w+)\]?\s+(FROM\s.*)$/i);
    if (m && !/^\s*FROM\b/i.test(m[1] ?? '')) preview = `FROM Auth ${m[1] ?? ''}`;
    else if (am) { alias = am[1]; preview = am[2]; }
  } else if (verb === 'UPDATE') {
    const setAt = findTopLevelKeyword(masked, /^SET\b/i);
    if (setAt >= 0) {
      // Normalize the target the way writeTable() does: drop TOP (n), a dbo. schema and brackets,
      // so [dbo].[Auth], dbo.Auth, [Auth] and TOP (50) Auth all read as Auth. TOP (n) touches a
      // subset of the rows matched, so previewing every matching row is the conservative reading.
      const target = text
        .slice('UPDATE'.length, setAt)
        .trim()
        .replace(/^TOP\s*\(\s*\d+\s*\)\s*/i, '')
        .replace(/^\[?dbo\]?\s*\.\s*/i, '')
        .replace(/^\[|\]$/g, '');
      const endAt = findTopLevelKeyword(masked, /^(FROM|WHERE|OUTPUT|OPTION)\b/i, setAt + 3);
      const setText = text.slice(setAt + 3, endAt >= 0 ? endAt : text.length);
      setPairs = splitTopLevel(setText, maskLiterals(setText)).map((p) => {
        const eq = p.text.indexOf('=');
        return { col: normalizeIdent(p.text.slice(0, eq)), value: parseLiteral(p.text.slice(eq + 1)) };
      });
      const rest = endAt >= 0 ? text.slice(endAt) : '';
      if (/^Auth$/i.test(target)) preview = /^FROM\b/i.test(rest) ? rest : `FROM Auth ${rest}`;
      else if (/^FROM\b/i.test(rest)) { alias = target; preview = rest; }
    }
  }

  const changesOnlyAuditColumns =
    verb === 'UPDATE' && setPairs.length > 0 && setPairs.every((p) => ['modifieddatetime', 'modifiedbypersonaliasid'].includes(p.col));

  // An UPDATE that sets any column deciding who a rule covers or what it grants could turn an
  // admin Allow row into a Deny (or retarget it); without a preview that cannot be ruled out.
  const setsRuleColumns =
    verb === 'UPDATE' &&
    (setPairs.length === 0 ||
      setPairs.some((p) => ['action', 'allowordeny', 'groupid', 'specialrole', 'personaliasid', 'entitytypeid', 'entityid'].includes(p.col)));

  if (!preview || who.adminGroupId === undefined) {
    const why = !preview ? 'could not work out which Auth rows it touches' : `could not look up the admin role${lookupNote}`;
    if (!changesOnlyAuditColumns && (mentionsAdministrate || !/\bWHERE\b/i.test(masked) || verb === 'DELETE' || setsRuleColumns)) {
      errors.push(`Refused: Auth ${verb} — ${why}, so removing or changing the administrators' access cannot be ruled out. Narrow it to explicit Auth Ids.`);
    } else {
      warnings.push(`Auth ${verb}: ${why}; lockout checks were not run.`);
    }
    return done();
  }

  let rows: Array<Record<string, unknown>>;
  try {
    const sel = `SELECT TOP 500 ${alias}.Id, ${alias}.EntityTypeId, ${alias}.EntityId, ${alias}.[Order], ${alias}.Action, ${alias}.AllowOrDeny, ${alias}.SpecialRole, ${alias}.GroupId, ${alias}.PersonAliasId ${preview}`;
    // The preview reuses the statement's own FROM/WHERE, so hold it to the SELECT-only rules.
    const v = validateSelectOnly(sel);
    if (!v.valid) throw new Error(`preview is not a plain SELECT: ${v.error}`);
    const r = await ctx.client.executeSql<Array<Record<string, unknown>>>(sel);
    rows = Array.isArray(r) ? r : [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (changesOnlyAuditColumns) warnings.push(`Auth ${verb}: preview SELECT failed (${msg}); lockout checks were not run.`);
    else errors.push(`Refused: Auth ${verb} — the read-only preview of the affected rows failed (${msg}), so an administrator lockout cannot be ruled out.`);
    return done();
  }
  if (rows.length >= 500) {
    errors.push(`Refused: Auth ${verb} would touch 500 or more rows; narrow it.`);
    return done();
  }

  const adminRows = rows.filter(
    (r) => Number(r.GroupId) === who.adminGroupId && (String(r.AllowOrDeny).toUpperCase() === 'A' || String(r.Action).toLowerCase() === 'administrate')
  );
  if (adminRows.length && !changesOnlyAuditColumns) {
    errors.push(
      `Refused: this ${verb === 'DELETE' ? 'deletes' : 'changes'} ${adminRows.length} Allow/Administrate Auth row(s) of "${ADMIN_ROLE_NAME}" (Auth Id ${adminRows
        .slice(0, 10)
        .map((r) => r.Id)
        .join(', ')}${adminRows.length > 10 ? ', …' : ''}). Rock has no self-lockout protection.`
    );
  }

  if (verb === 'UPDATE') {
    const touched = new Set(setPairs.map((p) => p.col));
    if (['action', 'allowordeny', 'groupid', 'specialrole', 'personaliasid'].some((c) => touched.has(c))) {
      const toLit = (v: unknown): Literal =>
        v === null || v === undefined ? { kind: 'null' } : typeof v === 'number' ? { kind: 'number', value: v } : { kind: 'string', value: String(v) };
      for (const r of rows) {
        const after: AuthRow = {
          action: toLit(r.Action), allowordeny: toLit(r.AllowOrDeny), specialrole: toLit(r.SpecialRole),
          groupid: toLit(r.GroupId), personaliasid: toLit(r.PersonAliasId),
        };
        for (const p of setPairs) (after as Record<string, Literal>)[p.col] = p.value;
        const risk = await denyAdministrateRisk(after, ctx.client, who);
        if (risk) {
          errors.push(`Refused: after this UPDATE, Auth row ${r.Id} would be ${risk}${lookupNote}.`);
          break;
        }
      }
    }
  }
  return done();
}
