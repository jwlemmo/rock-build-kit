/**
 * Workflows Tools for Rock RMS.
 *
 * Rock Workflows automate processes (visitor follow-up, baptism scheduling, ministry
 * sign-ups, etc.). Each WorkflowType is a template; launching one creates a Workflow
 * instance that runs the activities.
 *
 * Tools:
 *   - list_workflow_types — search workflow templates
 *   - launch_workflow — create + process a Workflow instance via v1 WorkflowEntry
 */

import { RockClient } from '../rock-client.js';

function lq(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function whereAnd(clauses: Array<string | undefined>): string | undefined {
  const kept = clauses.filter((c): c is string => !!c && c.length > 0);
  return kept.length === 0 ? undefined : kept.join(' && ');
}

// ---------------- list_workflow_types ----------------

export interface ListWorkflowTypesParams {
  name?: string;
  isActive?: boolean;
  categoryId?: number;
  limit?: number;
}

export const listWorkflowTypesSchema = {
  name: 'list_workflow_types',
  description: 'List WorkflowTypes (workflow templates). Filter by name, active status, or category.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Workflow type name substring' },
      isActive: { type: 'boolean', description: 'Filter by active status' },
      categoryId: { type: 'number', description: 'Restrict to a Category Id' },
      limit: { type: 'number', description: 'Max results (default 50)' },
    },
  },
};

export async function listWorkflowTypes(
  client: RockClient,
  params: ListWorkflowTypesParams
): Promise<unknown> {
  const where = whereAnd([
    params.name ? `Name.Contains(${lq(params.name)})` : undefined,
    params.isActive !== undefined ? `IsActive == ${params.isActive ? 'true' : 'false'}` : undefined,
    params.categoryId !== undefined ? `CategoryId == ${params.categoryId}` : undefined,
  ]);
  return client.v2Search('workflowTypes', {
    where,
    sort: 'Order, Name',
    limit: params.limit ?? 50,
  });
}

// ---------------- launch_workflow ----------------

export interface LaunchWorkflowParams {
  workflowTypeId: number;
  name?: string;
  attributeValues?: Record<string, string | number | boolean>;
}

export const launchWorkflowSchema = {
  name: 'launch_workflow',
  description:
    'Create, process, and report on a Workflow instance — synchronously, via the v1 ' +
    'WorkflowEntry endpoint. (The raw api/Workflows entity POST hangs on this instance; the ' +
    'v2 launch action crashes with KeyNotFoundException until v18.2 — Rock#6604.) ' +
    'attributeValues are validated against the type\'s workflow attributes BEFORE launching ' +
    '(unknown keys fail fast, because Rock silently ignores them) and ride the query string, ' +
    'so they are set before processing starts — keep values short and non-sensitive. ' +
    'A form-gated intake does NOT hang: it processes up to the form, reports Status "Active", ' +
    'and (if the type persists instances) remains in Rock waiting for the form — complete or ' +
    'clean it up in the UI. Always confirm with the user before calling.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      workflowTypeId: { type: 'number', description: 'The WorkflowType Id (use list_workflow_types to find)' },
      name: { type: 'string', description: 'Workflow name (WorkflowEntry defaults it to "Workflow From REST"; when the instance persists, the tool renames it via PATCH)' },
      attributeValues: {
        type: 'object',
        description: 'Attribute initial values keyed by Attribute Key (validated against the type before launch; set before processing begins)',
      },
    },
    required: ['workflowTypeId'],
  },
};

/** Rock v1 POST responses are inconsistent (bare number, {Id}, or the entity) — normalize. */
function parseId(res: unknown): number | null {
  if (typeof res === 'number' && Number.isFinite(res)) return res;
  if (typeof res === 'string' && /^\d+$/.test(res.trim())) return Number(res.trim());
  if (res && typeof res === 'object') {
    const cand = (res as Record<string, unknown>).Id ?? (res as Record<string, unknown>).id;
    if (typeof cand === 'number' && Number.isFinite(cand)) return cand;
    if (typeof cand === 'string' && /^\d+$/.test(cand)) return Number(cand);
  }
  return null;
}

/**
 * Build the WorkflowEntry path with attribute values as query-string params.
 * WorkflowEntry copies every query param into a matching workflow attribute at
 * creation time — before processing — which is the only way values are visible
 * to the actions that run. Exported for tests.
 */
export function buildWorkflowEntryPath(
  workflowTypeId: number,
  attributeValues?: Record<string, string | number | boolean>
): string {
  const qs: string[] = [];
  for (const [k, v] of Object.entries(attributeValues ?? {})) {
    const valueStr = typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v);
    qs.push(`${encodeURIComponent(k)}=${encodeURIComponent(valueStr)}`);
  }
  return `Workflows/WorkflowEntry/${workflowTypeId}${qs.length ? `?${qs.join('&')}` : ''}`;
}

export async function launchWorkflow(
  client: RockClient,
  params: LaunchWorkflowParams
): Promise<unknown> {
  const wt = await client.v2Get<{ name: string; isActive?: boolean }>(
    `workflowTypes/${params.workflowTypeId}`
  );
  if (wt.isActive === false) {
    throw new Error(
      `WorkflowType ${params.workflowTypeId} ("${wt.name}") is inactive — Rock will not launch instances of it.`
    );
  }

  // Validate attribute keys BEFORE creating an instance: WorkflowEntry silently ignores
  // unknown keys, which would launch a workflow missing the data it was supposed to carry.
  const requestedKeys = Object.keys(params.attributeValues ?? {});
  let canonical: Record<string, string | number | boolean> | undefined;
  let attributeValidation = 'none requested';
  if (requestedKeys.length > 0) {
    try {
      const attrs = (await client.v2Search('attributes', {
        where: `EntityTypeQualifierColumn == "WorkflowTypeId" && EntityTypeQualifierValue == "${params.workflowTypeId}"`,
        limit: 200,
      })) as Array<{ key?: string }>;
      const byLower = new Map(
        (Array.isArray(attrs) ? attrs : [])
          .filter((a): a is { key: string } => typeof a?.key === 'string')
          .map((a) => [a.key.toLowerCase(), a.key])
      );
      const unknown: string[] = [];
      canonical = {};
      for (const k of requestedKeys) {
        const actual = byLower.get(k.toLowerCase());
        if (actual) canonical[actual] = params.attributeValues![k];
        else unknown.push(k);
      }
      if (unknown.length) {
        throw new Error(
          `launch_workflow: WorkflowType ${params.workflowTypeId} has no workflow attribute(s) ` +
            `${unknown.join(', ')} — Rock would silently ignore them, so the launch was NOT attempted. ` +
            `Available keys: ${[...byLower.values()].join(', ') || '(none)'}.`
        );
      }
      attributeValidation = `validated ${requestedKeys.length} key(s)`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('launch_workflow:')) throw e; // our own unknown-key rejection
      // The attribute lookup itself failed (endpoint hiccup) — launch anyway rather than
      // block a valid launch, but say so.
      canonical = params.attributeValues;
      attributeValidation = `skipped (attribute lookup failed: ${msg.slice(0, 160)})`;
    }
  }

  // WorkflowEntry instantiates AND processes in one synchronous call.
  const wf = await client.v1Post<Record<string, unknown>>(
    buildWorkflowEntryPath(params.workflowTypeId, canonical),
    {}
  );

  const activities = Array.isArray(wf.Activities)
    ? (wf.Activities as Array<Record<string, unknown>>)
    : [];
  const workflowId = parseId(wf) ?? parseId(activities[0]?.WorkflowId);
  const status = typeof wf.Status === 'string' ? wf.Status : 'Unknown';
  const persisted = wf.IsPersisted === true;
  const completed = status === 'Completed';

  // Optional rename — WorkflowEntry hardcodes the name "Workflow From REST".
  let nameApplied = false;
  let nameError: string | undefined;
  if (params.name && workflowId != null && persisted) {
    try {
      await client.v1Patch(`Workflows/${workflowId}`, { Name: params.name });
      nameApplied = true;
    } catch (e) {
      nameError = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    success: completed,
    workflowId,
    workflowTypeId: params.workflowTypeId,
    workflowTypeName: wt.name,
    name: nameApplied ? params.name : typeof wf.Name === 'string' ? wf.Name : undefined,
    nameError,
    status,
    persisted,
    completedDateTime:
      typeof wf.CompletedDateTime === 'string' ? wf.CompletedDateTime : undefined,
    attributeValidation,
    attributesSet: requestedKeys.length,
    message: completed
      ? `Launched and completed Workflow ${workflowId} from type ${params.workflowTypeId} ("${wt.name}").`
      : `Workflow ${workflowId ?? '(id unknown)'} was created and processed but finished with ` +
        `Status "${status}" — it is waiting on something (usually a user-entry form or a ` +
        `delayed/async action). ` +
        (persisted
          ? 'A waiting instance now exists in Rock — complete it in the UI or clean it up.'
          : 'The type does not persist instances, so nothing lingers.'),
  };
}
