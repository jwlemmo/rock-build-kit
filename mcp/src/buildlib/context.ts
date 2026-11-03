/**
 * createBuildContext() — the buildlib entry point. See index.ts for the module overview.
 *
 * Every write method below follows the SAME dry-run gate: when ctx.go is false (the
 * default), the method logs the exact operation it WOULD perform and returns
 * `{ dryRun: true, op, detail }` WITHOUT calling client or the ledger. This mirrors the
 * corpora's `--go` convention (13-cleanup-test-data.mjs:16 `GO = process.argv.includes
 * ('--go')`; deploy.mjs:14-19,245,261 `writes` gate) — a build script is safe to run
 * with no arguments and see exactly what it intends to do.
 *
 * REST writes use normalized singular entity types in the audit ledger. The restore
 * planner accepts both current singular and legacy plural records.
 */

import { RockClient, createRockClient } from '../rock-client.js';
import { validateWrite } from '../sql-write-validator.js';
import {
  resolveGitIdentity,
  appendAudit,
  writeSnapshotFile,
  recordCreated,
  captureRestSnapshot,
  normalizeEntityType,
  type GitIdentity,
} from '../safety/index.js';
import { esc, bit, sqlVal, localISO, nowIso, shortHash, newIdFrom, skip, ok } from './helpers.js';
import type {
  BuildContextOptions,
  CreateResult,
  PatchResult,
  EnsureResult,
  UpsertAttributeValueResult,
  TouchAndFlushResult,
  UpdateBlockContentResult,
  LockToGroupsResult,
  WidenAccessResult,
  CreateWorkflowActionResult,
  DryRunResult,
} from './types.js';

function dryRun(op: string, detail: Record<string, unknown>): DryRunResult {
  console.log(`[dry-run] would ${op}:`, JSON.stringify(detail));
  return { dryRun: true, op, detail };
}

export interface BuildContext {
  readonly projectSlug: string;
  readonly client: RockClient;
  readonly go: boolean;
  readonly operator: GitIdentity;

  create(
    controller: string,
    body: Record<string, unknown>,
    opts?: { tag?: boolean; manifestKey?: string; label?: string }
  ): Promise<CreateResult | DryRunResult>;

  patch(
    controller: string,
    id: string | number,
    body: Record<string, unknown>,
    opts?: { label?: string }
  ): Promise<PatchResult | DryRunResult>;

  ensure(
    controller: string,
    filter: string,
    createBody: Record<string, unknown>,
    opts?: { tag?: boolean; manifestKey?: string; label?: string; select?: string }
  ): Promise<EnsureResult | DryRunResult>;

  findByForeignKey(controller: string, foreignKey?: string): Promise<unknown[]>;

  upsertAttributeValue(
    attributeId: number,
    entityId: number,
    value: string,
    opts?: { label?: string }
  ): Promise<UpsertAttributeValueResult | DryRunResult>;

  touchAndFlush(kind: 'htmlcontent' | 'workflowtype', id: number): Promise<TouchAndFlushResult | DryRunResult>;

  updateBlockContent(
    blockId: number,
    content: string,
    opts?: { entityValue?: string; label?: string }
  ): Promise<UpdateBlockContentResult | DryRunResult>;

  lockToGroups(
    entityTypeId: number,
    entityId: number,
    groupIds: number[],
    action?: string
  ): Promise<LockToGroupsResult | DryRunResult>;

  widenAccess(
    entityTypeId: number,
    entityId: number,
    target: { groupId?: number; personAliasId?: number },
    action?: string
  ): Promise<WidenAccessResult | DryRunResult>;

  createWorkflowAction(
    activityTypeId: number,
    opts: {
      name: string;
      component: number;
      order: number;
      workflowFormId?: number | null;
      completedOnSuccess?: boolean;
      completesActivity?: boolean;
      criteria?: { attrGuid?: string; comparison?: number; value?: string };
      completedIfCriteriaUnmet?: boolean;
      label?: string;
    }
  ): Promise<CreateWorkflowActionResult | DryRunResult>;

  writeRunSummary(path: string, obj: Record<string, unknown>): Promise<void>;
}

/**
 * Build a BuildContext bound to a Rock project. See the file header + index.ts for the
 * dry-run contract; each method's doc comment cites its corpus source line-for-line.
 */
export function createBuildContext(opts: BuildContextOptions): BuildContext {
  const projectSlug = opts.projectSlug;
  const client = opts.client ?? createRockClient();
  const go = opts.go ?? false;
  const defaultLabel = opts.label;
  const operator = resolveGitIdentity();
  const tool = `build-script:${projectSlug}`;

  // ---------------------------------------------------------------- create()
  // Generalizes new-hire-onboarding/build/test-person.mjs:12-41 (ForeignKey-tagging a
  // created row so it's identifiable/cleanable) plus rock.mjs's recordId manifest idiom
  // (rock.mjs:202-208) — folded into the guarded ledger write path used by rock_create
  // (rock-write.ts rockCreate) so build-script writes land in the SAME ledger as MCP writes.
  async function create(
    controller: string,
    body: Record<string, unknown>,
    createOpts: { tag?: boolean; manifestKey?: string; label?: string } = {}
  ): Promise<CreateResult | DryRunResult> {
    const tag = createOpts.tag !== false;
    const finalBody: Record<string, unknown> = { ...body };
    if (tag && finalBody.ForeignKey === undefined) {
      finalBody.ForeignKey = projectSlug;
    }

    if (!go) {
      return dryRun('POST (create)', { controller, body: finalBody, manifestKey: createOpts.manifestKey });
    }

    const ts = nowIso();
    const res = await client.v1Post<unknown>(controller, finalBody);
    const newId = newIdFrom(res);
    if (newId != null) {
      recordCreated(projectSlug, createOpts.manifestKey ?? `${controller}-${newId}`, newId);
    }
    const auditId = shortHash(`create|rest|${controller}|${JSON.stringify(finalBody)}|${ts}`);
    await appendAudit({
      auditId,
      ts,
      phase: 'create',
      operator,
      tool,
      verb: 'create',
      mode: 'rest',
      // Singular, normalized entityType (NOT the raw plural controller) — see the file-header
      // "DEVIATION from rock_create" note: this is what classifyRestore's undo-create path
      // (controllerFromEntityType) actually expects to round-trip correctly.
      target: { entityType: normalizeEntityType(controller) },
      payload: { label: createOpts.label ?? defaultLabel, body: finalBody },
      result: { success: true, newId: newId ?? undefined },
    });
    if (newId == null) {
      // Ledger-then-throw. The POST returned 2xx, so the row very likely EXISTS in Rock —
      // that fact belongs on the ledger (result.success stays true: the POST itself landed;
      // newId stays undefined: we could not identify the row). But for the CALLER a create
      // whose row we cannot identify is a FAILED create: returning a sentinel id would
      // propagate silently (e.g. updateBlockContent would compute Number('') = 0 and PATCH
      // HtmlContents/0; lockToGroups would report phantom rows). No manifest entry is
      // recorded — the manifest maps keys to KNOWN ids only.
      const fkHint =
        typeof finalBody.ForeignKey === 'string'
          ? `The row was tagged ForeignKey='${finalBody.ForeignKey}' — locate it via ` +
            `findByForeignKey('${controller}'${finalBody.ForeignKey === projectSlug ? '' : `, '${finalBody.ForeignKey}'`}).`
          : 'The row was NOT ForeignKey-tagged (tag:false and no ForeignKey in the body) — ' +
            'locate it manually (e.g. by Guid if the body carried one).';
      throw new Error(
        `create(${controller}): POST succeeded but the response carried no parseable Id ` +
          `(ledgered as auditId ${auditId} with result.newId undefined). The row may exist in ` +
          `Rock without a known Id — do NOT blindly retry (that could duplicate it). ${fkHint}`
      );
    }
    ok(`created ${controller} → Id ${newId}`);
    return { id: newId, auditId };
  }

  // ---------------------------------------------------------------- patch()
  // Captures a before-snapshot via captureRestSnapshot + writeSnapshotFile, then PATCHes —
  // EXACTLY the shape rock_edit writes (rock-write.ts rockEdit, phase 'executed', payload
  // { label, body }) so rock_restore's classifyRestore patch-back path (case c) can undo a
  // build script's PATCH the same way it undoes an MCP rock_edit. See the restore-compat
  // test in test/verify-buildlib.mjs.
  async function patch(
    controller: string,
    id: string | number,
    body: Record<string, unknown>,
    patchOpts: { label?: string } = {}
  ): Promise<PatchResult | DryRunResult> {
    if (!go) {
      return dryRun('PATCH (edit)', { controller, id, body });
    }

    const ts = nowIso();
    const snap = await captureRestSnapshot(client, controller, id, ts);
    const auditId = shortHash(`patch|rest|${controller}|${id}|${JSON.stringify(body)}|${ts}`);
    const snapshotRef = await writeSnapshotFile(`${auditId}-before`, snap.data);
    await client.v1Patch(`${controller}/${id}`, body);
    await appendAudit({
      auditId,
      ts,
      phase: 'executed',
      operator,
      tool,
      verb: 'edit',
      mode: 'rest',
      // Normalized singular entityType — matches rockEdit's convention exactly (rock-write.ts
      // rockEdit: target.entityType: normalizeEntityType(params.controller)), which is what
      // classifyRestore's controllerFromEntityType round-trips back to the correct controller.
      target: { entityType: normalizeEntityType(controller), id },
      snapshotRef,
      payload: { label: patchOpts.label ?? defaultLabel, body },
      result: { success: true },
    });
    ok(`patched ${controller}/${id}`);
    return { auditId, snapshotRef };
  }

  // ---------------------------------------------------------------- ensure()
  // The "OData $filter probe → reuse or create" idiom repeated across every batch script:
  // 01-category-and-role.mjs:26-99 (ensureCategory/ensureRoleGroup/ensureMember) and
  // 02-workflow-type-and-attributes.mjs:26-108 (ensureWorkflowType/ensureAttribute) both
  // GET with a $filter, reuse existing.Id and log "• already exists" if found, else POST
  // and log "✓ created". This collapses that duplicated shape into one call.
  async function ensure(
    controller: string,
    filter: string,
    createBody: Record<string, unknown>,
    ensureOpts: { tag?: boolean; manifestKey?: string; label?: string; select?: string } = {}
  ): Promise<EnsureResult | DryRunResult> {
    if (!go) {
      // Even in dry-run we still need to know whether it would create or reuse, so the
      // probe GET always runs (it's read-only) — only the create() branch is gated.
      const found = await client.v1Get<Array<Record<string, unknown>>>(controller, {
        $filter: filter,
        $select: ensureOpts.select ?? 'Id',
      });
      const existing = Array.isArray(found) ? found[0] : undefined;
      if (existing && existing.Id != null) {
        skip(`${controller} matching "${filter}" exists → Id ${existing.Id} (would reuse)`);
        return { id: existing.Id as number | string, created: false };
      }
      return dryRun('ensure → POST (create, no existing match)', { controller, filter, createBody });
    }

    const found = await client.v1Get<Array<Record<string, unknown>>>(controller, {
      $filter: filter,
      $select: ensureOpts.select ?? 'Id',
    });
    const existing = Array.isArray(found) ? found[0] : undefined;
    if (existing && existing.Id != null) {
      skip(`${controller} matching "${filter}" exists → Id ${existing.Id} (reusing)`);
      return { id: existing.Id as number | string, created: false };
    }

    const created = await create(controller, createBody, ensureOpts);
    if ('dryRun' in created) return created; // unreachable (go is true here), kept for type-narrowing
    return { id: created.id, created: true, auditId: created.auditId };
  }

  // ---------------------------------------------------------------- findByForeignKey()
  async function findByForeignKey(controller: string, foreignKey?: string): Promise<unknown[]> {
    const fk = foreignKey ?? projectSlug;
    const rows = await client.v1Get<unknown[]>(controller, {
      $filter: `ForeignKey eq '${fk.replace(/'/g, "''")}'`,
    });
    return Array.isArray(rows) ? rows : [];
  }

  // ---------------------------------------------------------------- upsertAttributeValue()
  // The 5-file idiom (r2-01-launch-recipients.mjs:31-43, and the same SELECT-then-PATCH-or-
  // POST shape in r2-02/r2-04/r3-01/r3-03): SQL-probe `AttributeValue WHERE AttributeId=X
  // AND EntityId=Y` (read-only, via executeSql — never a SQL WRITE for AttributeValue),
  // then PATCH the existing row's Value or POST a brand-new AttributeValue via create().
  async function upsertAttributeValue(
    attributeId: number,
    entityId: number,
    value: string,
    upsertOpts: { label?: string } = {}
  ): Promise<UpsertAttributeValueResult | DryRunResult> {
    const rows = await client.executeSql<Array<{ Id: number; Value: string | null }>>(
      `SELECT Id, Value FROM AttributeValue WHERE AttributeId = ${Math.trunc(attributeId)} AND EntityId = ${Math.trunc(
        entityId
      )}`
    );
    const existing = Array.isArray(rows) ? rows[0] : undefined;

    if (existing) {
      if (existing.Value === value) {
        skip(`AttributeValue (Attr ${attributeId}, Entity ${entityId}) already = "${value}" — no change`);
        if (!go) return dryRun('no-op (value already matches)', { attributeId, entityId, value });
        // Still record a no-op the same way the corpora do ("already correct — no change"),
        // without a ledger write — nothing changed, so nothing to ledger.
        return { id: existing.Id, created: false, auditId: '' };
      }
      const result = await patch('AttributeValues', existing.Id, { Value: value }, { label: upsertOpts.label });
      if ('dryRun' in result) return result;
      return { id: existing.Id, created: false, auditId: result.auditId };
    }

    const result = await create(
      'AttributeValues',
      { AttributeId: attributeId, EntityId: entityId, Value: value, IsSystem: false },
      { label: upsertOpts.label }
    );
    if ('dryRun' in result) return result;
    return { id: result.id, created: true, auditId: result.auditId };
  }

  // ---------------------------------------------------------------- touchAndFlush()
  // deploy.mjs:206-217 (updateBlockContent's ApprovedDateTime PATCH) generalized to a
  // standalone cache-bust primitive, plus wf.mjs:166-168 (flushWorkflowTypeCache's
  // ModifiedDateTime PATCH). Field mapping matches src/tools/cache.ts's flush_cache tool:
  // htmlcontent → HtmlContents/{id} ApprovedDateTime; workflowtype → WorkflowTypes/{id}
  // ModifiedDateTime. Ledgered as a patch, but payload.benign:true marks it as a cache-bust,
  // not a content edit — classifyRestore still treats it as an ordinary patch-back (the
  // restore key set comes from payload.body, which here is just the one touched field), so
  // undo just re-touches the same field; that's fine because a cache bust is idempotent.
  async function touchAndFlush(kind: 'htmlcontent' | 'workflowtype', id: number): Promise<TouchAndFlushResult | DryRunResult> {
    const field = kind === 'htmlcontent' ? 'ApprovedDateTime' : 'ModifiedDateTime';
    const controller = kind === 'htmlcontent' ? 'HtmlContents' : 'WorkflowTypes';

    if (!go) {
      return dryRun(`PATCH (cache-bust ${field})`, { kind, controller, id, field });
    }

    const ts = nowIso();
    const stamp = localISO(new Date()); // Rock datetime columns are server-local — see helpers.ts
    const snap = await captureRestSnapshot(client, controller, id, ts);
    const auditId = shortHash(`touch|${kind}|${id}|${ts}`);
    const snapshotRef = await writeSnapshotFile(`${auditId}-before`, snap.data);
    await client.v1Patch(`${controller}/${id}`, { [field]: stamp });
    await appendAudit({
      auditId,
      ts,
      phase: 'executed',
      operator,
      tool,
      verb: 'edit',
      mode: 'rest',
      // Normalized singular entityType — see patch()'s comment above for why.
      target: { entityType: normalizeEntityType(controller), id },
      snapshotRef,
      payload: { label: defaultLabel, body: { [field]: stamp }, benign: true },
      result: { success: true },
    });
    ok(`touched ${controller}/${id} (${field}) — cache flushed`);
    return { auditId, kind, id };
  }

  // ---------------------------------------------------------------- updateBlockContent()
  // room-calendar/build/deploy.mjs:206-217 VERBATIM in semantics: GET the block's
  // HtmlContent rows, compute maxVersion+1, POST a NEW row { BlockId, Content,
  // EntityValue:'', Version, IsApproved:true } via create() (so it's ledgered as a create
  // with a manifest entry), then PATCH ApprovedDateTime on THAT NEW row (not the old one) —
  // deploy.mjs's comment explains why: a raw POST writes the row but does not itself fire
  // FlushCachedContent; only a PATCH runs the model-save pipeline that broadcasts the flush
  // to every front-end on this multi-front-end instance.
  async function updateBlockContent(
    blockId: number,
    content: string,
    ubcOpts: { entityValue?: string; label?: string } = {}
  ): Promise<UpdateBlockContentResult | DryRunResult> {
    const rows = await client.v1Get<Array<{ Id: number; Version?: number }>>('HtmlContents', {
      $filter: `BlockId eq ${Math.trunc(blockId)}`,
    });
    const maxVersion = (Array.isArray(rows) ? rows : []).reduce((m, r) => Math.max(m, r.Version ?? 0), 0);
    const nextVersion = maxVersion + 1;

    if (!go) {
      return dryRun('POST new HtmlContent version + PATCH ApprovedDateTime (cache flush)', {
        blockId,
        nextVersion,
        contentLength: content.length,
      });
    }

    const created = await create(
      'HtmlContents',
      {
        BlockId: blockId,
        Content: content,
        EntityValue: ubcOpts.entityValue ?? '',
        Version: nextVersion,
        IsApproved: true,
      },
      { label: ubcOpts.label ?? defaultLabel, tag: false } // HtmlContent has no ForeignKey column of interest here
    );
    if ('dryRun' in created) return created; // unreachable (go is true), kept for type-narrowing

    const flush = await touchAndFlush('htmlcontent', Number(created.id));
    if ('dryRun' in flush) {
      // unreachable (go is true) — but satisfies the type checker without an unsafe cast.
      throw new Error('updateBlockContent: unexpected dry-run result from touchAndFlush while go=true.');
    }
    ok(`block ${blockId}: new HtmlContent ${created.id} → v${nextVersion}, cache flushed`);
    return {
      newHtmlContentId: created.id,
      version: nextVersion,
      createAuditId: created.auditId,
      flushAuditId: flush.auditId,
    };
  }

  // ---------------------------------------------------------------- lockToGroups()
  // deploy.mjs:236-238 (deployAdmin's Auth rows) = new-hire-onboarding/build/
  // 04-entry-page.mjs:39-42 (lockToAdmins) — the SAME two-row shape in both corpora:
  // one Allow row per group (Order 0..n-1, SpecialRole:0, AllowOrDeny:'A'), then exactly
  // ONE Deny-all row LAST (SpecialRole:1, AllowOrDeny:'D', Order n) so the specific Allows
  // are evaluated before the catch-all Deny.
  async function lockToGroups(
    entityTypeId: number,
    entityId: number,
    groupIds: number[],
    action = 'View'
  ): Promise<LockToGroupsResult | DryRunResult> {
    if (!go) {
      return dryRun('POST Auths (allow groups, then deny-all last)', { entityTypeId, entityId, groupIds, action });
    }

    const rows: Array<{ id: number | string; auditId: string }> = [];
    let order = 0;
    for (const groupId of groupIds) {
      const res = await create(
        'Auths',
        {
          EntityTypeId: entityTypeId,
          EntityId: entityId,
          Action: action,
          AllowOrDeny: 'A',
          SpecialRole: 0,
          GroupId: groupId,
          Order: order++,
        },
        { tag: false }
      );
      if ('dryRun' in res) throw new Error('lockToGroups: unexpected dry-run result while go=true.');
      rows.push(res);
    }
    const denyRes = await create(
      'Auths',
      {
        EntityTypeId: entityTypeId,
        EntityId: entityId,
        Action: action,
        AllowOrDeny: 'D',
        SpecialRole: 1,
        Order: order,
      },
      { tag: false }
    );
    if ('dryRun' in denyRes) throw new Error('lockToGroups: unexpected dry-run result while go=true.');
    rows.push(denyRes);
    ok(`locked entity ${entityId} (type ${entityTypeId}) to ${groupIds.length} group(s), Deny-all last`);
    return { rows };
  }

  // ---------------------------------------------------------------- widenAccess()
  // ensureGroupAuth (05-dashboard.mjs:67-76): SQL-probe for an existing Allow row for this
  // exact group+action (idempotent — skip if present), else SELECT MAX(Order)+1 and POST
  // the new Allow at the bottom. Combined with 07-go-live.mjs:38-83's deny-pushdown
  // maneuver: when an existing SpecialRole:1 Deny-all row is present (the admin-locked
  // pattern lockToGroups just wrote), push IT down FIRST so the new Allow still gets
  // evaluated before the catch-all Deny (Rock walks Auth rows in ascending Order,
  // first match wins).
  //
  // DEVIATION (fix) from the corpus: 07-go-live.mjs:66 pushed the deny to the LITERAL
  // Order 50 — a latent security-ordering flaw: when MAX(Order) is already >= 50, the new
  // Allow (MAX+1 = 51+) lands BELOW the pushed deny, and first-match-wins means the grant
  // silently never applies. Here allowOrder = MAX(Order)+1 exactly as in the corpus, but
  // the deny goes to Math.max(50, allowOrder + 1) — 50 preserved as the corpus floor for
  // the common low-Order case, while the deny is ALWAYS strictly below the new Allow.
  // Both computed numbers are reported: result.order / result.movedDenyToBottom.newOrder
  // (go mode) and detail.allowOrder / detail.wouldPushDeny.to (dry-run).
  async function widenAccess(
    entityTypeId: number,
    entityId: number,
    target: { groupId?: number; personAliasId?: number },
    action = 'View'
  ): Promise<WidenAccessResult | DryRunResult> {
    if (!target.groupId && !target.personAliasId) {
      throw new Error('widenAccess: requires target.groupId or target.personAliasId.');
    }
    const targetClause = target.groupId
      ? `GroupId = ${Math.trunc(target.groupId)}`
      : `PersonAliasId = ${Math.trunc(target.personAliasId as number)}`;

    // Idempotency probe — read-only, safe in dry-run too.
    const existingRows = await client.executeSql<Array<{ Id: number }>>(
      `SELECT Id FROM Auth WHERE EntityTypeId = ${Math.trunc(entityTypeId)} AND EntityId = ${Math.trunc(
        entityId
      )} AND [Action] = '${esc(action)}' AND AllowOrDeny = 'A' AND ${targetClause}`
    );
    if (Array.isArray(existingRows) && existingRows.length > 0) {
      skip(`auth ${action} for ${target.groupId ? `group ${target.groupId}` : `personAlias ${target.personAliasId}`} already present (Auth ${existingRows[0].Id})`);
      if (!go) return dryRun('no-op (auth already present)', { entityTypeId, entityId, action, target });
      return { auditId: '', id: existingRows[0].Id, order: -1 };
    }

    // Deny-pushdown: an existing SpecialRole:1 Deny-all row for this action must move to
    // the bottom BEFORE we place the new Allow, so evaluation order stays Allow-then-Deny.
    const denyRows = await client.executeSql<Array<{ Id: number; Order: number }>>(
      `SELECT Id, [Order] FROM Auth WHERE EntityTypeId = ${Math.trunc(entityTypeId)} AND EntityId = ${Math.trunc(
        entityId
      )} AND [Action] = '${esc(action)}' AND AllowOrDeny = 'D' AND SpecialRole = 1`
    );
    const deny = Array.isArray(denyRows) ? denyRows[0] : undefined;

    const maxOrdRows = await client.executeSql<Array<{ M: number | null }>>(
      `SELECT ISNULL(MAX([Order]),-1) AS M FROM Auth WHERE EntityTypeId = ${Math.trunc(entityTypeId)} AND EntityId = ${Math.trunc(
        entityId
      )} AND [Action] = '${esc(action)}'`
    );
    const maxOrder = Array.isArray(maxOrdRows) && maxOrdRows[0] ? maxOrdRows[0].M ?? -1 : -1;
    // allowOrder first, THEN the deny destination derived from it — never a literal 50
    // alone (see the DEVIATION note above): the deny must be strictly below the new Allow.
    const allowOrder = maxOrder + 1;
    const denyPush = deny
      ? { authId: deny.Id, from: deny.Order, to: Math.max(50, allowOrder + 1) }
      : undefined;

    if (!go) {
      return dryRun('POST Auth (allow) at MAX(Order)+1, pushing deny-all below it first if present', {
        entityTypeId,
        entityId,
        action,
        target,
        allowOrder,
        wouldPushDeny: denyPush,
      });
    }

    let movedDenyToBottom: { authId: number | string; newOrder: number } | undefined;
    if (denyPush) {
      const pushed = await patch('Auths', denyPush.authId, { Order: denyPush.to }, { label: `push deny-all below new allow for ${action}` });
      if ('dryRun' in pushed) throw new Error('widenAccess: unexpected dry-run result while go=true.');
      movedDenyToBottom = { authId: denyPush.authId, newOrder: denyPush.to };
    }

    const body: Record<string, unknown> = {
      EntityTypeId: entityTypeId,
      EntityId: entityId,
      Action: action,
      AllowOrDeny: 'A',
      SpecialRole: 0,
      Order: allowOrder,
    };
    if (target.groupId) body.GroupId = target.groupId;
    if (target.personAliasId) body.PersonAliasId = target.personAliasId;
    const created = await create('Auths', body, { tag: false });
    if ('dryRun' in created) throw new Error('widenAccess: unexpected dry-run result while go=true.');
    ok(`granted ${action} on entity ${entityId} to ${target.groupId ? `group ${target.groupId}` : `personAlias ${target.personAliasId}`} (order ${allowOrder}${movedDenyToBottom ? `, deny-all pushed to ${movedDenyToBottom.newOrder}` : ''})`);
    return { auditId: created.auditId, id: created.id, order: allowOrder, movedDenyToBottom };
  }

  // ---------------------------------------------------------------- createWorkflowAction()
  // wf.mjs:132-163 (createAction) — the WorkflowActionType REST-POST-hangs workaround:
  // build an INSERT with esc/bit/sqlVal, run it through client.executeSqlCommand (NOT REST),
  // then read the Id back by Guid (verify — throw on miss, wf.mjs:159-160). Hardened here
  // vs. the corpus: the INSERT is routed through validateWrite(sql,'create') FIRST — the
  // corpus's raw sqlCommand() has no such gate (it's an unguarded helper trusted only by
  // hand-reviewed batch scripts); this library must not reopen that hole for callers who
  // didn't get that review. Ledgered with mode:'sql', phase 'create', result.newId set (same
  // shape rock_create's mode:"sql" path writes — see rock-write.ts rockCreate) so
  // classifyRestore's SQL-create undo path (case f) applies unchanged.
  async function createWorkflowAction(
    activityTypeId: number,
    actionOpts: {
      name: string;
      component: number;
      order: number;
      workflowFormId?: number | null;
      completedOnSuccess?: boolean;
      completesActivity?: boolean;
      criteria?: { attrGuid?: string; comparison?: number; value?: string };
      completedIfCriteriaUnmet?: boolean;
      label?: string;
    }
  ): Promise<CreateWorkflowActionResult | DryRunResult> {
    const guid = randomGuid();
    const cr = actionOpts.criteria ?? {};
    const cols = [
      'ActivityTypeId',
      'Name',
      '[Order]',
      'EntityTypeId',
      'IsActionCompletedOnSuccess',
      'IsActivityCompletedOnSuccess',
      'WorkflowFormId',
      'CriteriaAttributeGuid',
      'CriteriaComparisonType',
      'CriteriaValue',
      'IsActionCompletedIfCriteriaUnmet',
      'Guid',
    ];
    const vals = [
      String(Math.trunc(activityTypeId)),
      sqlVal(actionOpts.name),
      String(Math.trunc(actionOpts.order)),
      String(Math.trunc(actionOpts.component)),
      String(bit(actionOpts.completedOnSuccess !== false)),
      String(bit(!!actionOpts.completesActivity)),
      actionOpts.workflowFormId == null ? 'NULL' : String(Math.trunc(actionOpts.workflowFormId)),
      cr.attrGuid == null ? 'NULL' : `'${esc(cr.attrGuid)}'`,
      String(cr.comparison ?? 0),
      sqlVal(cr.value ?? null),
      String(bit(!!actionOpts.completedIfCriteriaUnmet)),
      `'${esc(guid)}'`,
    ];
    const insertSql = `INSERT INTO WorkflowActionType (${cols.join(',')}) VALUES (${vals.join(',')})`;

    const v = validateWrite(insertSql, 'create');
    if (!v.valid) throw new Error(`createWorkflowAction: SQL write rejected: ${v.error}`);

    if (!go) {
      return dryRun('INSERT WorkflowActionType via executeSqlCommand (validated) + verify by Guid', {
        activityTypeId,
        name: actionOpts.name,
        component: actionOpts.component,
        guid,
      });
    }

    const ts = nowIso();
    await client.executeSqlCommand(insertSql);
    const rows = await client.executeSql<Array<{ Id: number }>>(`SELECT Id FROM WorkflowActionType WHERE Guid = '${esc(guid)}'`);
    const id = Array.isArray(rows) && rows[0] ? rows[0].Id : undefined;
    if (id == null) {
      throw new Error(`createWorkflowAction: insert verify failed for "${actionOpts.name}" (Guid ${guid} not found after insert).`);
    }

    const auditId = shortHash(`create|sql|${insertSql}|${ts}`);
    await appendAudit({
      auditId,
      ts,
      phase: 'create',
      operator,
      tool,
      verb: 'create',
      mode: 'sql',
      // Matches rockCreate's SQL-mode convention exactly (rock-write.ts: target.entityType:
      // normalizeEntityType(table)) — WorkflowActionType is already singular, so this is a
      // no-op normalization, kept for consistency/defensiveness rather than a literal.
      target: { entityType: normalizeEntityType('WorkflowActionType'), table: 'WorkflowActionType' },
      payload: { label: actionOpts.label ?? defaultLabel, sql: insertSql },
      result: { success: true, newId: id },
    });
    ok(`created WorkflowActionType "${actionOpts.name}" → Id ${id}`);
    return {
      id,
      guid,
      auditId,
      reminder:
        'This WorkflowActionType was inserted via SQL — call touchAndFlush(\'workflowtype\', <the WorkflowType Id>) ' +
        'next so Rock rebuilds its WorkflowTypeCache and picks up the new action row.',
    };
  }

  // ---------------------------------------------------------------- writeRunSummary()
  // deploy.mjs:263-283's deploy-result.json convention: merge into whatever JSON already
  // exists at `path` (so repeated runs accumulate fields like `result.userPageId =
  // CFG.userPageId; result.deployedAt = ...`) rather than clobbering the whole file.
  async function writeRunSummary(path: string, obj: Record<string, unknown>): Promise<void> {
    const { readFile, writeFile } = await import('node:fs/promises');
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      // no existing file (or unreadable) — start fresh, mirrors deploy.mjs:263's `'{}'` fallback
    }
    const merged = { ...existing, ...obj };
    await writeFile(path, JSON.stringify(merged, null, 2) + '\n');
  }

  return {
    projectSlug,
    client,
    go,
    operator,
    create,
    patch,
    ensure,
    findByForeignKey,
    upsertAttributeValue,
    touchAndFlush,
    updateBlockContent,
    lockToGroups,
    widenAccess,
    createWorkflowAction,
    writeRunSummary,
  };
}

// randomUUID import kept local to avoid pulling node:crypto's randomUUID into helpers.ts,
// which is meant to stay dependency-light (pure functions only).
import { randomUUID } from 'node:crypto';
function randomGuid(): string {
  return randomUUID();
}
