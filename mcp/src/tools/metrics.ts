/**
 * Metrics Tools for Rock RMS — v2 endpoints (Linq.Dynamic where expressions) for reads,
 * plus a guarded upsert that collapses the create-MetricValue-then-N-partition-rows dance.
 */

import { createHash } from 'node:crypto';
import { RockClient } from '../rock-client.js';
import {
  resolveGitIdentity,
  appendAudit,
  writeSnapshotFile,
  deriveToken,
  validateToken,
  type WriteOp,
} from '../safety/index.js';

export interface GetMetricsParams {
  metricId: number;
  startDate?: string;
  endDate?: string;
  entityId?: number;
  limit?: number;
}

export interface ListMetricCategoriesParams {
  categoryId?: number;
  limit?: number;
}

export const getMetricsSchema = {
  name: 'get_metrics',
  description:
    'Get raw MetricValue rows for a metric, optionally filtered by date range and entity ' +
    '(default cap 500 rows). For multi-week windows or campus/service-partitioned metrics, ' +
    'prefer execute_sql to aggregate server-side — a partitioned metric returns many rows per ' +
    'week (one per campus × service) and can overflow.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      metricId: { type: 'number', description: 'The Metric ID to retrieve values for' },
      startDate: { type: 'string', description: 'Start date for date range filter (YYYY-MM-DD or ISO 8601)' },
      endDate: { type: 'string', description: 'End date for date range filter (YYYY-MM-DD or ISO 8601)' },
      entityId: { type: 'number', description: 'Filter by entity ID (e.g., Campus ID)' },
      limit: { type: 'number', description: 'Max rows to return (default 500).' },
    },
    required: ['metricId'],
  },
};

export const listMetricCategoriesSchema = {
  name: 'list_metric_categories',
  description: 'List available metrics and their categories',
  inputSchema: {
    type: 'object' as const,
    properties: {
      categoryId: { type: 'number', description: 'Filter by category ID' },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 100)' },
    },
  },
};

function dt(iso: string): string {
  return `DateTime("${iso}")`;
}

const ISO_DATEISH = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

export async function getMetrics(client: RockClient, params: GetMetricsParams): Promise<unknown> {
  const metricId = Math.trunc(params.metricId);
  if (!Number.isFinite(metricId)) throw new Error('get_metrics: metricId must be a number.');
  for (const [name, v] of [['startDate', params.startDate], ['endDate', params.endDate]] as const) {
    if (v !== undefined && !ISO_DATEISH.test(v)) {
      throw new Error(`get_metrics: ${name} "${v}" must be YYYY-MM-DD or an ISO datetime.`);
    }
  }
  const start = params.startDate && (params.startDate.includes('T') ? params.startDate : `${params.startDate}T00:00:00`);
  const end = params.endDate && (params.endDate.includes('T') ? params.endDate : `${params.endDate}T23:59:59`);
  const limit = Math.min(Math.trunc(params.limit ?? 500), 5000);

  const parts: string[] = [`MetricId == ${metricId}`];
  if (start) parts.push(`MetricValueDateTime >= ${dt(start)}`);
  if (end) parts.push(`MetricValueDateTime <= ${dt(end)}`);
  if (params.entityId !== undefined) {
    parts.push(`MetricValuePartitions.Any(p => p.EntityId == ${Math.trunc(params.entityId)})`);
  }

  try {
    return await client.v2Search('metricvalues', {
      where: parts.join(' && '),
      sort: 'MetricValueDateTime descending',
      limit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Rock v18.2 regression: v2 metricvalues/search 500s on EVERY query shape (verified
    // 2026-07-19 on rockdev incl. bare limit-1, while other v2 searches work). Degrade to
    // SQL, which expresses the same filters on every Rock version.
    if (!/→\s*5\d\d/.test(msg)) throw err;
    const clauses = [`mv.MetricId = ${metricId}`];
    if (start) clauses.push(`mv.MetricValueDateTime >= '${start}'`);
    if (end) clauses.push(`mv.MetricValueDateTime <= '${end}'`);
    if (params.entityId !== undefined) {
      clauses.push(
        `EXISTS (SELECT 1 FROM MetricValuePartition mvp WHERE mvp.MetricValueId = mv.Id AND mvp.EntityId = ${Math.trunc(params.entityId)})`
      );
    }
    const rows = await client.executeSql(
      `SELECT TOP ${limit} mv.Id, mv.MetricId, mv.MetricValueType, mv.YValue, mv.XValue, mv.MetricValueDateTime, mv.Note ` +
        `FROM MetricValue mv WHERE ${clauses.join(' AND ')} ORDER BY mv.MetricValueDateTime DESC`
    );
    return {
      via: 'sql-fallback (this Rock build 500s on v2 metricvalues/search — Rock v18.2 regression)',
      rows,
    };
  }
}

export async function listMetricCategories(
  client: RockClient,
  params: ListMetricCategoriesParams
): Promise<unknown> {
  return client.v2Search('metrics', {
    where:
      params.categoryId !== undefined
        ? `MetricCategories.Any(c => c.CategoryId == ${params.categoryId})`
        : undefined,
    limit: params.limit ?? 100,
  });
}

// ---------------- upsert_metric_value (CAP-2) ----------------

export interface UpsertMetricValueParams {
  metricId: number;
  date: string;
  value: number;
  partitions?: Record<string, number>;
  metricValueType?: number; // 0 = Measure (default), 1 = Goal
  note?: string;
  confirmation_token?: string;
  session_tag?: string;
}

export const upsertMetricValueSchema = {
  name: 'upsert_metric_value',
  description:
    'Create or update ONE MetricValue with its partition rows in a single call (replaces the ' +
    'manual create-MetricValue-then-one-row-per-partition dance). Looks up the existing value ' +
    'by metric + date + exact partition set. If none exists it CREATES immediately ' +
    '("create = light", audit-ledgered). If one exists, the first call returns a PREVIEW with ' +
    'the current value and a confirmation_token — STOP, show the user, and only re-call with ' +
    'the token to update ("edit = stop"). Refuses when multiple existing rows match (duplicate ' +
    'rows need manual cleanup first). date "YYYY-MM-DD" matches any time that day and creates ' +
    'at T00:00:00; a full ISO datetime matches/creates exactly. partitions maps a ' +
    'MetricPartition Label (or its numeric Id as a string key) to an EntityId, e.g. ' +
    '{"Campus": 2}; required partitions must be provided, and the metric\'s default unlabeled ' +
    'partition is handled automatically. Warns when the metric is SQL-sourced (the Calculate ' +
    'Metrics job may overwrite or duplicate manual values — when backfilling a converted ' +
    'metric, exclude the current in-progress period). Dashboard blocks may need a cache flush ' +
    'to show the change.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      metricId: { type: 'number', description: 'The Metric Id' },
      date: {
        type: 'string',
        description:
          'YYYY-MM-DD (matches any time that day; creates at T00:00:00) or full ISO datetime (exact)',
      },
      value: { type: 'number', description: 'The YValue to set' },
      partitions: {
        type: 'object',
        description:
          'MetricPartition Label (or numeric Id as key) → EntityId, e.g. {"Campus": 2}. ' +
          'Omit for unpartitioned metrics; the default unlabeled partition is automatic.',
      },
      metricValueType: { type: 'number', description: '0 = Measure (default), 1 = Goal' },
      note: { type: 'string', description: 'Optional MetricValue.Note' },
      confirmation_token: {
        type: 'string',
        description:
          'Omit on the first call. If an existing value matches you get a preview + token; ' +
          're-call with the SAME arguments plus the token to execute the update.',
      },
      session_tag: {
        type: 'string',
        description:
          'Optional: your Claude session id, recorded on the audit ledger entry alongside the ' +
          'operator\'s git identity, so "did my session touch prod?" is answerable later.',
      },
    },
    required: ['metricId', 'date', 'value'],
  },
};

export interface MetricPartitionRow {
  Id: number;
  Label: string | null;
  EntityTypeId: number | null;
  IsRequired: boolean;
}

export interface ResolvedPartition {
  metricPartitionId: number;
  entityId: number | null;
  label: string;
}

/**
 * Map the caller's { label-or-id: entityId } onto the metric's actual partitions.
 * Pure — exported for tests. Rules:
 *   - a key that parses as an integer is a MetricPartitionId; anything else matches Label
 *     case-insensitively
 *   - every partition of the metric must end up covered: uncovered default (EntityTypeId
 *     null) or optional partitions get EntityId null automatically; uncovered REQUIRED
 *     entity partitions are an error (a value missing one renders wrong in dashboards —
 *     the metricdisplaypanel campus-tab trap)
 */
export function resolvePartitions(
  metricPartitions: MetricPartitionRow[],
  requested: Record<string, number> | undefined
): { resolved: ResolvedPartition[]; problems: string[] } {
  const problems: string[] = [];
  const byId = new Map(metricPartitions.map((p) => [p.Id, p]));
  const byLabel = new Map(
    metricPartitions
      .filter((p): p is MetricPartitionRow & { Label: string } => typeof p.Label === 'string' && p.Label.length > 0)
      .map((p) => [p.Label.toLowerCase(), p])
  );
  const available =
    metricPartitions
      .map((p) => `${p.Label ?? '(default)'} (Id ${p.Id}${p.IsRequired ? ', required' : ''})`)
      .join(', ') || '(none)';

  const covered = new Map<number, ResolvedPartition>();
  for (const [key, entityId] of Object.entries(requested ?? {})) {
    const part = /^\d+$/.test(key.trim()) ? byId.get(Number(key.trim())) : byLabel.get(key.trim().toLowerCase());
    if (!part) {
      problems.push(`this metric has no partition "${key}" — available: ${available}`);
      continue;
    }
    if (typeof entityId !== 'number' || !Number.isFinite(entityId)) {
      problems.push(`partition "${key}" needs a numeric EntityId (got ${JSON.stringify(entityId)})`);
      continue;
    }
    if (covered.has(part.Id)) {
      problems.push(`partition "${part.Label ?? part.Id}" was specified more than once`);
      continue;
    }
    covered.set(part.Id, {
      metricPartitionId: part.Id,
      entityId,
      label: part.Label ?? '(default)',
    });
  }

  for (const p of metricPartitions) {
    if (covered.has(p.Id)) continue;
    if (p.EntityTypeId != null && p.IsRequired) {
      problems.push(
        `partition "${p.Label ?? p.Id}" (Id ${p.Id}) is required — pass partitions: {"${p.Label ?? p.Id}": <EntityId>}`
      );
      continue;
    }
    // Default (unlabeled) or optional partition: a MetricValue still needs its row, with a null EntityId.
    covered.set(p.Id, { metricPartitionId: p.Id, entityId: null, label: p.Label ?? '(default)' });
  }

  return { resolved: [...covered.values()], problems };
}

function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

function parseNewId(res: unknown): number | null {
  if (typeof res === 'number' && Number.isFinite(res)) return res;
  if (typeof res === 'string' && /^\d+$/.test(res.trim())) return Number(res.trim());
  if (res && typeof res === 'object') {
    const cand = (res as Record<string, unknown>).Id ?? (res as Record<string, unknown>).id;
    if (typeof cand === 'number' && Number.isFinite(cand)) return cand;
    if (typeof cand === 'string' && /^\d+$/.test(cand)) return Number(cand);
  }
  return null;
}

// This instance's DefinedValue Id for Metric SourceValueType "SQL" (manual entry = 230).
// Used only to warn — a SQL-sourced metric's values are owned by the Calculate Metrics job.


export async function upsertMetricValue(
  client: RockClient,
  params: UpsertMetricValueParams
): Promise<unknown> {
  const operator = resolveGitIdentity();
  const sessionTag = params.session_tag;
  const ts = new Date().toISOString();

  // ---- validate inputs (these get interpolated into the lookup SQL) ----
  if (!Number.isFinite(params.metricId)) throw new Error('upsert_metric_value: metricId must be a number.');
  if (typeof params.value !== 'number' || !Number.isFinite(params.value)) {
    throw new Error('upsert_metric_value: value must be a finite number.');
  }
  const metricValueType = params.metricValueType ?? 0;
  if (metricValueType !== 0 && metricValueType !== 1) {
    throw new Error('upsert_metric_value: metricValueType must be 0 (Measure) or 1 (Goal).');
  }
  const dateStr = params.date.trim();
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(dateStr)) {
    throw new Error(
      `upsert_metric_value: date "${params.date}" must be YYYY-MM-DD or an ISO datetime (YYYY-MM-DDTHH:mm[:ss]).`
    );
  }
  const dateOnly = !dateStr.includes('T');

  // ---- metric + partitions ----
  const raw = await client.v2Get<{ title?: string; name?: string; sourceValueTypeId?: number }>(
    `metrics/${params.metricId}`
  );
  // The Metric entity's display property is Title (there is no Name column).
  const metric = { name: raw.title ?? raw.name, sourceValueTypeId: raw.sourceValueTypeId };
  const warnings: string[] = [];
  const sourceRows = Number.isSafeInteger(metric.sourceValueTypeId)
    ? await client.executeSql<Array<{ Value: string }>>(`SELECT [Value] FROM DefinedValue WHERE Id = ${metric.sourceValueTypeId}`)
    : [];
  if (sourceRows.some(row => /sql/i.test(row.Value))) {
    warnings.push(
      'This metric is SQL-sourced: the Calculate Metrics job (every 15 min) owns its values and may ' +
        'overwrite or duplicate a manual write. When backfilling, exclude the current in-progress period.'
    );
  }

  const partitionRows = await client.executeSql<MetricPartitionRow[]>(
    `SELECT Id, Label, EntityTypeId, IsRequired FROM MetricPartition WHERE MetricId = ${params.metricId} ORDER BY [Order]`
  );
  const { resolved, problems } = resolvePartitions(
    Array.isArray(partitionRows) ? partitionRows : [],
    params.partitions
  );
  if (problems.length) {
    throw new Error(`upsert_metric_value: ${problems.join('; ')}`);
  }

  // ---- find the existing value (exact partition-set match) ----
  const dateClause = dateOnly
    ? `CAST(mv.MetricValueDateTime AS date) = '${dateStr}'`
    : `mv.MetricValueDateTime = '${dateStr}'`;
  const partitionClauses = resolved
    .map(
      (p) =>
        `AND EXISTS (SELECT 1 FROM MetricValuePartition mvp WHERE mvp.MetricValueId = mv.Id ` +
        `AND mvp.MetricPartitionId = ${p.metricPartitionId} AND ${
          p.entityId == null ? 'mvp.EntityId IS NULL' : `mvp.EntityId = ${p.entityId}`
        })`
    )
    .join(' ');
  const matches = await client.executeSql<
    Array<{ Id: number; YValue: number | null; MetricValueDateTime: string; Note: string | null }>
  >(
    `SELECT mv.Id, mv.YValue, mv.MetricValueDateTime, mv.Note FROM MetricValue mv ` +
      `WHERE mv.MetricId = ${params.metricId} AND mv.MetricValueType = ${metricValueType} ` +
      `AND ${dateClause} ${partitionClauses}`
  );
  const existing = Array.isArray(matches) ? matches : [];

  if (existing.length > 1) {
    throw new Error(
      `upsert_metric_value: ${existing.length} existing MetricValues match metric ${params.metricId} ` +
        `on ${dateStr} with that partition set (Ids ${existing.map((m) => m.Id).join(', ')}) — ` +
        `likely calc-job seam duplicates. Resolve them first (rock_delete), then retry.`
    );
  }

  const partitionSummary = resolved.map((p) => ({ ...p }));

  // ---- CREATE (no match): "create = light" ----
  if (existing.length === 0) {
    if (params.confirmation_token) {
      throw new Error(
        'upsert_metric_value: a confirmation_token was passed but no existing MetricValue matches — ' +
          'the row may have been deleted since the preview. Re-call WITHOUT the token.'
      );
    }
    const metricValueDateTime = dateOnly ? `${dateStr}T00:00:00` : dateStr;
    const createBody: Record<string, unknown> = {
      MetricId: params.metricId,
      MetricValueType: metricValueType,
      YValue: params.value,
      MetricValueDateTime: metricValueDateTime,
    };
    if (params.note) createBody.Note = params.note;
    const created = await client.v1Post<unknown>('MetricValues', createBody);
    const metricValueId = parseNewId(created);
    if (metricValueId == null) {
      throw new Error(
        `upsert_metric_value: MetricValue create returned no usable Id ` +
          `(${JSON.stringify(created).slice(0, 200)}) — verify in Rock before retrying, the row may exist.`
      );
    }

    const partitionErrors: Array<{ partition: string; error: string }> = [];
    for (const p of resolved) {
      try {
        await client.v1Post('MetricValuePartitions', {
          MetricValueId: metricValueId,
          MetricPartitionId: p.metricPartitionId,
          EntityId: p.entityId,
        });
      } catch (e) {
        partitionErrors.push({ partition: p.label, error: e instanceof Error ? e.message : String(e) });
      }
    }

    const auditId = shortHash(`upsert-create|${params.metricId}|${dateStr}|${JSON.stringify(resolved)}|${ts}`);
    const auditLogged = await appendAudit({
      auditId, ts, phase: 'create', operator, sessionTag, tool: 'upsert_metric_value', verb: 'create', mode: 'rest',
      target: { entityType: 'MetricValue', id: metricValueId },
      payload: { metric: metric.name, metricId: params.metricId, date: dateStr, value: params.value, partitions: partitionSummary, note: params.note },
      result: { success: partitionErrors.length === 0, newId: metricValueId },
    });

    return {
      action: 'created',
      success: partitionErrors.length === 0,
      metricValueId,
      metricId: params.metricId,
      metricName: metric.name,
      metricValueDateTime,
      value: params.value,
      partitions: partitionSummary,
      partitionErrors: partitionErrors.length ? partitionErrors : undefined,
      warnings: warnings.length ? warnings : undefined,
      auditId, auditLogged, operator,
      message:
        partitionErrors.length === 0
          ? `Created MetricValue ${metricValueId} (${params.value}) for metric ${params.metricId} on ${metricValueDateTime}.`
          : `MetricValue ${metricValueId} was created but ${partitionErrors.length} partition row(s) FAILED — ` +
            `the value may not display correctly until the partition rows exist. Fix or delete it.`,
    };
  }

  // ---- UPDATE (one match): two-phase "edit = stop" ----
  const row = existing[0];
  const editBody: Record<string, unknown> = { YValue: params.value };
  if (params.note !== undefined) editBody.Note = params.note;
  const op: WriteOp = { verb: 'edit', mode: 'rest', controller: 'MetricValues', id: row.Id, body: editBody };
  const token = deriveToken(op);

  if (params.confirmation_token) {
    if (!validateToken(op, params.confirmation_token)) {
      throw new Error(
        'Confirmation token mismatch — arguments changed since the preview, or the preview was skipped. ' +
          'Re-call upsert_metric_value WITHOUT a token to get a fresh preview.'
      );
    }
    const snapRef = await writeSnapshotFile(`${shortHash(token)}-before`, row);
    await client.v1Patch(`MetricValues/${row.Id}`, editBody);
    const auditId = shortHash(token);
    const auditLogged = await appendAudit({
      auditId, ts, phase: 'executed', operator, sessionTag, tool: 'upsert_metric_value', verb: 'edit', mode: 'rest',
      target: { entityType: 'MetricValue', id: row.Id }, snapshotRef: snapRef,
      payload: { metric: metric.name, metricId: params.metricId, date: dateStr, value: params.value, partitions: partitionSummary, note: params.note },
      confirmationToken: params.confirmation_token,
      result: { success: true },
    });
    return {
      action: 'updated',
      phase: 'executed',
      success: true,
      metricValueId: row.Id,
      metricId: params.metricId,
      metricName: metric.name,
      previousValue: row.YValue,
      newValue: params.value,
      partitions: partitionSummary,
      before_snapshot_ref: snapRef,
      warnings: warnings.length ? warnings : undefined,
      auditId, auditLogged, operator,
      message: `Updated MetricValue ${row.Id}: ${row.YValue} → ${params.value}.`,
    };
  }

  const auditId = shortHash(token);
  await appendAudit({
    auditId, ts, phase: 'preview', operator, sessionTag, tool: 'upsert_metric_value', verb: 'edit', mode: 'rest',
    target: { entityType: 'MetricValue', id: row.Id },
    payload: { metric: metric.name, metricId: params.metricId, date: dateStr, value: params.value, partitions: partitionSummary, note: params.note },
    confirmationToken: token,
    result: { success: true },
  });
  return {
    action: 'update',
    phase: 'preview',
    confirmation_token: token,
    metric: { id: params.metricId, name: metric.name },
    existing: {
      metricValueId: row.Id,
      currentValue: row.YValue,
      metricValueDateTime: row.MetricValueDateTime,
      note: row.Note,
    },
    proposed: { value: params.value, note: params.note },
    partitions: partitionSummary,
    warnings: warnings.length ? warnings : undefined,
    next_step:
      'STOP. A MetricValue already exists for this metric/date/partitions. Show the user the ' +
      'current vs proposed value above; only after they approve, re-call upsert_metric_value ' +
      'with the SAME arguments plus this confirmation_token to execute the update.',
    operator,
  };
}
