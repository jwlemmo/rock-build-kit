/**
 * Cache-flush tool — bust Rock's server cache after a direct SQL/REST write so the change
 * goes live without a browser trip to Cache Manager.
 *
 * The reliable mechanism is a metadata PATCH that runs the model-save pipeline: PATCHing an
 * HtmlContent row's ApprovedDateTime fires FlushCachedContent, and a ModifiedDateTime PATCH
 * rebuilds WorkflowType / Page / Block caches. Since v18 (and now v19), Cache Manager
 * "Clear Cache" reaches EVERY web server, so a full clear-all (headless, no permission
 * needed) is `node ~/rock-build-kit/tools/rock-ui/rock-ui.mjs [--prod] cache clear`.
 * A PageRoute PATCH does NOT register a REST-created route — use
 * `rock-ui route save <PageRouteId>` instead; Auth rows written by REST/SQL need
 * `rock-ui security resave <type> <id>` or `rock-ui cache clear`.
 *
 * ApprovedDateTime is stored/compared in UTC, and Rock's active-version pick favors the row
 * with the LATEST ApprovedDateTime. Stamping every version on a block with the SAME timestamp
 * lets that pick tie-break to the WRONG (oldest) version — this served a stale dashboard on
 * 7/12/26. target:"block" therefore stamps the newest row (highest Id) strictly LAST/later so
 * it deterministically stays the active version.
 */
import { RockClient } from '../rock-client.js';

export interface FlushCacheParams {
  target: 'htmlcontent' | 'block' | 'workflowtype' | 'page' | 'blocksettings';
  id: number;
}

const VALID_TARGETS = ['htmlcontent', 'block', 'workflowtype', 'page', 'blocksettings'] as const;
type ValidTarget = (typeof VALID_TARGETS)[number];

const VALID_SHAPES_HELP =
  'Valid shapes (target + id are BOTH required, nothing else):\n' +
  '  { target: "htmlcontent", id: <HtmlContentId> }\n' +
  '  { target: "block", id: <BlockId> }\n' +
  '  { target: "workflowtype", id: <WorkflowTypeId> }\n' +
  '  { target: "page", id: <PageId> }\n' +
  '  { target: "blocksettings", id: <BlockId> }\n' +
  'target must be exactly one of "htmlcontent" | "block" | "workflowtype" | "page" | ' +
  '"blocksettings"; id must be a whole ' +
  'number. NOT valid: {}, {scope:"all"}, {target:"all"}, {cache_type, entity_id} — none of ' +
  'those are recognized param names, and a missing/undefined id used to silently become ' +
  '`WHERE BlockId = NaN` (Math.trunc(undefined)) instead of failing loudly.';

/**
 * Validate flush_cache's arguments BEFORE any SQL/REST call is built from them.
 *
 * The tool's inputSchema (below) declares target/id as required, but the MCP SDK does not
 * enforce a tool's inputSchema against the arguments a client actually sends — arguments
 * arrive as untyped JSON and are cast straight to FlushCacheParams (see index.ts's dispatch:
 * `args as unknown as FlushCacheParams`). That cast is the actual hole: it compiles, but
 * performs no runtime check, so `{}` or `{cache_type, entity_id}` sailed straight through to
 * `Math.trunc(params.id)` → NaN → `WHERE BlockId = NaN`, which one session mistook for a
 * broken server (see reference/ mining report, L2). This function is the runtime check the
 * type cast can't provide.
 */
export function validateFlushCacheParams(params: unknown): { target: ValidTarget; id: number } {
  const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>;
  const { target, id } = p;

  if (typeof target !== 'string' || !VALID_TARGETS.includes(target as ValidTarget)) {
    throw new Error(
      `flush_cache: invalid or missing "target" (got ${JSON.stringify(target)}). ${VALID_SHAPES_HELP}`
    );
  }
  if (typeof id !== 'number' || !Number.isFinite(id)) {
    throw new Error(
      `flush_cache: invalid or missing "id" for target "${target}" (got ${JSON.stringify(id)}). ${VALID_SHAPES_HELP}`
    );
  }

  return { target: target as ValidTarget, id: Math.trunc(id) };
}

export const flushCacheSchema = {
  name: 'flush_cache',
  description:
    'Bust Rock\'s server cache after a direct SQL/REST write so the change goes live. ' +
    'target:"htmlcontent" + the HtmlContent row Id → PATCHes ApprovedDateTime (fires ' +
    'FlushCachedContent). target:"block" + a Block Id → flushes every ' +
    'HtmlContent row on that block, stamping the newest row (highest Id) with a strictly later ' +
    'ApprovedDateTime so Rock\'s latest-ApprovedDateTime active-version pick cannot tie-break ' +
    'to an older version (timestamps compare in UTC). target:"workflowtype" + a WorkflowType Id → PATCHes ' +
    'ModifiedDateTime to rebuild the workflow cache after inserting action rows via mode:"sql". ' +
    'target:"page" + a Page Id → PATCHes ModifiedDateTime, refreshing the page\'s cached ' +
    'properties AND its cached block list (new blocks render after this). target:"blocksettings" ' +
    '+ a Block Id → PATCHes ModifiedDateTime, refreshing the block\'s own cached record after ' +
    'changing its settings/PreHtml/PostHtml by SQL or REST (does not re-approve HtmlContent — ' +
    'use "block" for that). ' +
    'Not covered: route registration → rock-ui route save <PageRouteId>; Auth → rock-ui security ' +
    'resave or rock-ui cache clear; anything else → rock-ui cache clear. ' +
    'Re-approving an HtmlContent row that ' +
    'holds unapproved draft content will PUBLISH it, so target the row you intend to go live. ' +
    'STRICT SHAPE: exactly target + id, nothing else — {}, {scope:"all"}, {target:"all"}, and ' +
    '{cache_type, entity_id} are all rejected up front with the valid-shapes list, not silently ' +
    'run as a broken query.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      target: {
        type: 'string',
        enum: ['htmlcontent', 'block', 'workflowtype', 'page', 'blocksettings'],
        description: 'What to flush — exactly one of these five values, no others accepted',
      },
      id: {
        type: 'number',
        description: 'HtmlContent Id, Block Id, WorkflowType Id, Page Id, or Block Id (for blocksettings) — matching target, required whole number',
      },
    },
    required: ['target', 'id'],
  },
};

export async function flushCache(client: RockClient, rawParams: unknown): Promise<unknown> {
  const params = validateFlushCacheParams(rawParams);
  const now = new Date().toISOString();
  const id = params.id;

  if (params.target === 'workflowtype') {
    await client.v1Patch(`WorkflowTypes/${id}`, { ModifiedDateTime: now });
    return { flushed: true, target: 'workflowtype', id, via: 'ModifiedDateTime PATCH' };
  }

  if (params.target === 'page') {
    await client.v1Patch(`Pages/${id}`, { ModifiedDateTime: now });
    return { flushed: true, target: 'page', id, via: 'ModifiedDateTime PATCH' };
  }

  if (params.target === 'blocksettings') {
    await client.v1Patch(`Blocks/${id}`, { ModifiedDateTime: now });
    return { flushed: true, target: 'blocksettings', id, via: 'ModifiedDateTime PATCH' };
  }

  // htmlcontent | block → resolve the HtmlContent row Ids to re-approve.
  let htmlContentIds: number[];
  if (params.target === 'htmlcontent') {
    htmlContentIds = [id];
  } else {
    const rows = (await client.executeSql(
      `SELECT Id FROM HtmlContent WHERE BlockId = ${id}`
    )) as Array<{ Id: number }>;
    htmlContentIds = Array.isArray(rows) ? rows.map((r) => r.Id) : [];
    if (htmlContentIds.length === 0) {
      return { flushed: false, target: 'block', id, message: `No HtmlContent rows found on block ${id}.` };
    }
  }

  // Patch non-winning rows first, then stamp the newest row (highest Id) with a strictly
  // later timestamp — identical timestamps let Rock's active-version pick (latest
  // ApprovedDateTime, UTC) tie-break to the oldest version.
  const activeHtmlContentId = Math.max(...htmlContentIds);
  const later = new Date(Date.parse(now) + 2000).toISOString();
  for (const hcId of htmlContentIds) {
    if (hcId !== activeHtmlContentId) {
      await client.v1Patch(`HtmlContents/${hcId}`, { ApprovedDateTime: now });
    }
  }
  await client.v1Patch(`HtmlContents/${activeHtmlContentId}`, { ApprovedDateTime: later });
  return {
    flushed: true,
    target: params.target,
    id,
    htmlContentIds,
    activeHtmlContentId,
    via: 'ApprovedDateTime PATCH (newest row stamped last so it stays the active version)',
  };
}
