/**
 * Impact analysis — before any edit/delete of an existing object, find what references or
 * depends on it ("changing this attribute may break X report on Y page"). All queries are
 * READ-ONLY SELECTs run through the existing SELECT-only executeSql path, so impact analysis
 * itself can never write. When no catalog entry exists for an entity type, `ran` is false and
 * the caller surfaces "review manually".
 *
 * Schema note: these use Rock's SQL Server table/column names (Attribute, AttributeValue,
 * Block, Page, PageRoute, Report, DataView, Workflow, DefinedValue, [Group], Auth, …).
 */

import { RockClient } from '../rock-client.js';
import type { ImpactResult, ImpactReference } from './types.js';

export interface ImpactTarget {
  entityType: string; // normalized singular, e.g. "Attribute", "Page", "Block"
  id?: string | number;
  guid?: string;
  key?: string;
  table?: string; // raw SQL table name (sql-mode writes), for audit/reference
}

// ---- literal helpers (the Lava {% sql %} path inlines values; no bound params) ----
function sqlStr(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}
function asInt(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}
function isGuid(s: string | undefined): s is string {
  return !!s && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
}
function isKey(s: string | undefined): s is string {
  return !!s && /^[A-Za-z0-9_.\-]+$/.test(s);
}
function firstCount(rows: unknown): number {
  if (Array.isArray(rows) && rows.length && rows[0] && typeof rows[0] === 'object') {
    const v = Object.values(rows[0] as Record<string, unknown>)[0];
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
function rowCount(rows: unknown): number {
  return Array.isArray(rows) ? rows.length : 0;
}

/** Map a REST controller or SQL table to a catalog key (singular entity type). */
export function normalizeEntityType(controllerOrTable: string): string {
  const raw = controllerOrTable.trim().replace(/^\/+|\/+$/g, '');
  const irregular: Record<string, string> = {
    People: 'Person',
    Pages: 'Page',
    Blocks: 'Block',
    Attributes: 'Attribute',
    AttributeValues: 'AttributeValue',
    WorkflowTypes: 'WorkflowType',
    WorkflowActionTypes: 'WorkflowActionType',
    WorkflowActivityTypes: 'WorkflowActivityType',
    DefinedValues: 'DefinedValue',
    DefinedTypes: 'DefinedType',
    Groups: 'Group',
    Categories: 'Category',
    PageRoutes: 'PageRoute',
  };
  if (irregular[raw]) return irregular[raw];
  // Generic singularize for the common cases.
  return raw.replace(/ies$/, 'y').replace(/s$/, '');
}

type RunQuery = (sql: string) => Promise<unknown>;
type Handler = (client: RockClient, t: ImpactTarget, q: RunQuery) => Promise<ImpactReference[]>;

const CATALOG: Record<string, Handler> = {
  // ------------------------------------------------------------------ Attribute
  async Attribute(_client, t, q) {
    const refs: ImpactReference[] = [];
    const byGuid = isGuid(t.guid);
    const byKey = isKey(t.key);
    if (!byGuid && !byKey) return refs;
    const guidLit = byGuid ? sqlStr(t.guid as string) : undefined;
    const keyLit = byKey ? sqlStr(t.key as string) : undefined;
    const idMatch = byGuid ? `a.Guid = ${guidLit}` : `a.[Key] = ${keyLit}`;

    // How much data would be affected (existing AttributeValues).
    const vc = await q(
      `SELECT COUNT(*) AS C FROM AttributeValue av JOIN Attribute a ON a.Id = av.AttributeId WHERE ${idMatch}`
    );
    refs.push({ kind: 'AttributeValue', count: firstCount(vc), detail: 'stored values that use this attribute' });

    // Blocks whose settings reference this attribute (by Guid or Key) — likely UI/report impact.
    const likeTerm = byGuid ? guidLit : keyLit;
    const blocks = await q(
      `SELECT TOP 25 b.Id AS BlockId, b.Name AS BlockName, p.InternalName AS Page
       FROM AttributeValue av
       JOIN Attribute ba ON ba.Id = av.AttributeId
       JOIN EntityType bet ON bet.Id = ba.EntityTypeId AND bet.Name = 'Rock.Model.Block'
       JOIN Block b ON b.Id = av.EntityId
       LEFT JOIN Page p ON p.Id = b.PageId
       WHERE av.Value LIKE '%' + ${likeTerm} + '%'`
    );
    if (rowCount(blocks)) {
      refs.push({ kind: 'Block', count: rowCount(blocks), items: blocks as unknown[], detail: 'blocks whose settings reference this attribute' });
    }

    // Reports/DataViews that surface it (by Guid).
    if (byGuid) {
      const reports = await q(
        `SELECT TOP 25 r.Id AS ReportId, r.Name AS ReportName
         FROM ReportField rf JOIN Report r ON r.Id = rf.ReportId
         WHERE rf.Selection LIKE '%' + ${guidLit} + '%'`
      );
      if (rowCount(reports)) {
        refs.push({ kind: 'Report', count: rowCount(reports), items: reports as unknown[], detail: 'reports using this attribute as a field' });
      }
    }
    return refs;
  },

  // ------------------------------------------------------------------ Page
  async Page(_client, t, q) {
    const refs: ImpactReference[] = [];
    const id = asInt(t.id);
    if (id === undefined) return refs;
    const children = await q(`SELECT COUNT(*) AS C FROM Page WHERE ParentPageId = ${id}`);
    refs.push({ kind: 'ChildPage', count: firstCount(children), detail: 'child pages under this page' });

    const blocks = await q(
      `SELECT TOP 50 b.Id AS BlockId, b.Name, bt.Name AS BlockType, b.Zone
       FROM Block b LEFT JOIN BlockType bt ON bt.Id = b.BlockTypeId
       WHERE b.PageId = ${id} ORDER BY b.Zone, b.[Order]`
    );
    refs.push({ kind: 'BlockOnPage', count: rowCount(blocks), items: blocks as unknown[], detail: 'blocks hosted on this page' });

    const routes = await q(`SELECT Id, Route FROM PageRoute WHERE PageId = ${id}`);
    if (rowCount(routes)) refs.push({ kind: 'PageRoute', count: rowCount(routes), items: routes as unknown[], detail: 'routes for this page' });

    const linkers = await q(
      `SELECT TOP 25 b.Id AS BlockId, b.Name, p.InternalName AS OnPage
       FROM AttributeValue av JOIN Block b ON b.Id = av.EntityId
       JOIN Attribute a ON a.Id = av.AttributeId
       JOIN EntityType e ON e.Id = a.EntityTypeId AND e.Name = 'Rock.Model.Block'
       LEFT JOIN Page p ON p.Id = b.PageId
       WHERE av.Value LIKE '%/page/${id}%' OR av.Value LIKE '%"PageId":${id}%'`
    );
    if (rowCount(linkers)) refs.push({ kind: 'LinkingBlock', count: rowCount(linkers), items: linkers as unknown[], detail: 'blocks that link to this page' });
    return refs;
  },

  // ------------------------------------------------------------------ Block
  async Block(_client, t, q) {
    const refs: ImpactReference[] = [];
    const id = asInt(t.id);
    if (id === undefined) return refs;
    const host = await q(
      `SELECT b.Id, b.Name, b.Zone, p.Id AS PageId, p.InternalName AS Page, bt.Name AS BlockType
       FROM Block b LEFT JOIN BlockType bt ON bt.Id = b.BlockTypeId
       LEFT JOIN Page p ON p.Id = b.PageId WHERE b.Id = ${id}`
    );
    if (rowCount(host)) refs.push({ kind: 'HostPage', items: host as unknown[], detail: 'the page hosting this block' });

    const settings = await q(
      `SELECT COUNT(*) AS C FROM AttributeValue av
       JOIN Attribute a ON a.Id = av.AttributeId
       JOIN EntityType e ON e.Id = a.EntityTypeId AND e.Name = 'Rock.Model.Block'
       WHERE av.EntityId = ${id}`
    );
    refs.push({ kind: 'BlockSetting', count: firstCount(settings), detail: 'configured settings on this block' });
    return refs;
  },

  // ------------------------------------------------------------------ WorkflowType
  async WorkflowType(_client, t, q) {
    const refs: ImpactReference[] = [];
    const id = asInt(t.id);
    if (id === undefined) return refs;
    const active = await q(
      `SELECT COUNT(*) AS C FROM Workflow WHERE WorkflowTypeId = ${id} AND CompletedDateTime IS NULL`
    );
    refs.push({
      kind: 'ActiveWorkflowInstance',
      count: firstCount(active),
      detail: 'in-flight instances (these froze their actions at creation — type edits will NOT reach them)',
    });
    const structure = await q(
      `SELECT at.Id AS ActivityTypeId, at.Name, COUNT(act.Id) AS ActionCount
       FROM WorkflowActivityType at
       LEFT JOIN WorkflowActionType act ON act.ActivityTypeId = at.Id
       WHERE at.WorkflowTypeId = ${id} GROUP BY at.Id, at.Name`
    );
    if (rowCount(structure)) refs.push({ kind: 'Activity', count: rowCount(structure), items: structure as unknown[], detail: 'activities under this workflow type' });
    return refs;
  },

  // ------------------------------------------------------------------ Group
  async Group(_client, t, q) {
    const refs: ImpactReference[] = [];
    const id = asInt(t.id);
    if (id === undefined) return refs;
    const members = await q(`SELECT COUNT(*) AS C FROM GroupMember WHERE GroupId = ${id}`);
    refs.push({ kind: 'GroupMember', count: firstCount(members), detail: 'members of this group' });
    const children = await q(`SELECT COUNT(*) AS C FROM [Group] WHERE ParentGroupId = ${id}`);
    refs.push({ kind: 'ChildGroup', count: firstCount(children), detail: 'child groups' });
    const auths = await q(
      `SELECT TOP 50 a.Id, et.Name AS EntityType, a.EntityId, a.[Action], a.AllowOrDeny
       FROM Auth a JOIN EntityType et ON et.Id = a.EntityTypeId WHERE a.GroupId = ${id}`
    );
    if (rowCount(auths)) {
      refs.push({ kind: 'SecurityGrant', count: rowCount(auths), items: auths as unknown[], detail: 'things this group authorizes (security role)' });
    }
    return refs;
  },

  // ------------------------------------------------------------------ DefinedValue
  async DefinedValue(_client, t, q) {
    const refs: ImpactReference[] = [];
    if (!isGuid(t.guid)) return refs;
    const g = sqlStr(t.guid);
    const av = await q(`SELECT COUNT(*) AS C FROM AttributeValue WHERE Value LIKE '%' + ${g} + '%'`);
    refs.push({ kind: 'AttributeValueRef', count: firstCount(av), detail: 'attribute values referencing this defined value' });
    return refs;
  },

  // ------------------------------------------------------------------ Metric
  async Metric(_client, t, q) {
    const refs: ImpactReference[] = [];
    const id = asInt(t.id);
    if (id === undefined) return refs;

    const values = await q(`SELECT COUNT(*) AS C FROM MetricValue WHERE MetricId = ${id}`);
    refs.push({
      kind: 'MetricValue',
      count: firstCount(values),
      detail: 'stored values on this metric — a SourceSql/partition edit silently changes what future values MEAN vs these',
    });

    const partitions = await q(`SELECT Id, Label, EntityTypeId FROM MetricPartition WHERE MetricId = ${id}`);
    if (rowCount(partitions)) {
      refs.push({ kind: 'MetricPartition', count: rowCount(partitions), items: partitions as unknown[], detail: 'partitions on this metric' });
    }

    // Dashboards / HTML blocks that render it: by Guid when known, plus the two precise
    // id-bearing patterns dashboards actually use (metricdisplaypanel shortcode, {% sql %} filter).
    const patterns = [
      `hc.Content LIKE '%metricid:''${id}''%'`,
      `hc.Content LIKE '%MetricId = ${id}%'`,
    ];
    if (isGuid(t.guid)) patterns.push(`hc.Content LIKE '%' + ${sqlStr(t.guid)} + '%'`);
    const content = await q(
      `SELECT TOP 25 hc.Id AS HtmlContentId, hc.BlockId, p.InternalName AS Page
       FROM HtmlContent hc JOIN Block b ON b.Id = hc.BlockId LEFT JOIN Page p ON p.Id = b.PageId
       WHERE ${patterns.join(' OR ')}`
    );
    if (rowCount(content)) {
      refs.push({ kind: 'DashboardContent', count: rowCount(content), items: content as unknown[], detail: 'HTML/Lava content (dashboards) that renders this metric' });
    }
    return refs;
  },

  // ------------------------------------------------------------------ Category
  async Category(_client, t, q) {
    const refs: ImpactReference[] = [];
    const id = asInt(t.id);
    if (id === undefined) return refs;
    const children = await q(`SELECT COUNT(*) AS C FROM Category WHERE ParentCategoryId = ${id}`);
    refs.push({ kind: 'ChildCategory', count: firstCount(children), detail: 'child categories' });
    const wf = await q(`SELECT COUNT(*) AS C FROM WorkflowType WHERE CategoryId = ${id}`);
    refs.push({ kind: 'WorkflowTypeInCategory', count: firstCount(wf), detail: 'workflow types filed under this category' });
    return refs;
  },
};

/** Run the reference-finding catalog for an edit/delete target. Resilient to per-query errors. */
export async function runImpact(client: RockClient, target: ImpactTarget): Promise<ImpactResult> {
  const handler = CATALOG[target.entityType];
  if (!handler) {
    return {
      ran: false,
      summary: `No automatic reference analysis for ${target.entityType} — review manually before editing/deleting.`,
      references: [],
      queriesRun: [],
    };
  }

  const queriesRun: string[] = [];
  let errored = false;
  const q: RunQuery = async (sql: string) => {
    const compact = sql.replace(/\s+/g, ' ').trim();
    queriesRun.push(compact);
    try {
      return await client.executeSql<unknown>(compact);
    } catch {
      errored = true;
      return [];
    }
  };

  const references = await handler(client, target, q);
  const parts = references.map((r) => (r.count !== undefined ? `${r.count} ${r.kind}` : r.kind));
  const summary =
    (references.length ? parts.join('; ') : 'No dependents found by the available checks.') +
    (errored ? ' (note: one or more checks errored — review manually)' : '');

  return { ran: true, summary, references, queriesRun };
}
