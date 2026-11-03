/**
 * Block Content Tools for Rock RMS — v1 endpoints (OData). get_block_content (read) +
 * edit_block_content (guarded surgical write) over Rock's HtmlContent rows.
 *
 * Rock HTML blocks store their markup/Lava in HtmlContent rows (no v2 controller
 * exists for HtmlContent, so this is v1-only, like Reservations). get_block_content is
 * the trustworthy READ half: it returns the EXACT bytes of a block's content plus a
 * sha256/length reference so a later edit can verify it started from — and is writing
 * back to — the content it thinks it is. Nothing here renders, sanitizes, or otherwise
 * touches Lava delimiters; the content string is passed through byte-for-byte.
 *
 * Active-version rule (mirrors how Rock itself resolves which HtmlContent row to
 * render for a block): among rows with an empty/null EntityValue (the default,
 * non-context-specific rows), Rock picks the row that IsApproved, whose
 * StartDateTime is null-or-past and ExpireDateTime is null-or-future, and — among
 * rows meeting all of that — the row with the HIGHEST Version. Rows with a
 * non-empty EntityValue are context-aware (e.g. keyed to a specific entity like a
 * Person or DefinedValue) and are NEVER chosen as the default; they are only ever
 * listed in `versions` for visibility. If no row satisfies the active-version rule
 * (nothing approved/in-window among default-context rows), the highest-Version
 * default-context row is returned instead with a `warning` explaining it is not the
 * actively-rendered version — or, if only context-specific rows exist at all, the
 * highest-Version row among those, with a warning saying so.
 *
 * Filter syntax is OData with PascalCase field names (v1 REST responses are
 * PascalCase — Id, BlockId, Content, Version, IsApproved, EntityValue, …), matching
 * the convention used throughout this repo's other v1Get callers (reservations.ts,
 * giving.ts).
 *
 * ---------------------------------------------------------------------------------
 * edit_block_content — the "61-byte story": a full-value replace of a big Lava
 * template once lost 61 bytes of trailing whitespace because the MODEL re-transcribed
 * the content by hand. The fix discipline here: the model NEVER retypes content — this
 * tool computes the new content programmatically from the exact bytes it just fetched
 * (split/join for `replace`, straight splice for `insert_before`/`insert_after`), and
 * every write is SHA-256-verified both BEFORE (does the live row still match what the
 * preview saw?) and AFTER (did the write land exactly as computed?) execution.
 *
 * Same two-phase HARD-STOP handshake as rock_edit (see rock-write.ts, safety/confirm.ts):
 * phase 1 (no confirmation_token) fetches the base row, computes the new content, and
 * returns a preview + token WITHOUT writing; phase 2 (token present) re-verifies the
 * base hasn't drifted, rebuilds the identical new content, validates the token, writes,
 * and re-verifies the result.
 *
 * Cache rule (mirrors flush_cache / room-calendar's deploy.mjs updateBlockContent()):
 * a raw HtmlContent Content write does NOT bust Rock's render cache by itself — it is
 * the model-save pipeline (triggered by ANY PATCH to the row) that broadcasts
 * FlushCachedContent to every front-end. This tool
 * PATCHes {Content, ApprovedDateTime} in ONE call: the Content field carries the actual
 * edit, and bumping ApprovedDateTime is the proven, safe field to include so the save
 * pipeline (and its cache flush) always fires even when Content alone might not look
 * "changed enough" to some future Rock version. flush_cache's own htmlcontent path uses
 * this identical ApprovedDateTime-PATCH mechanism on the existing row (not a new version).
 *
 * Scope cuts (v1), so they aren't mistaken for bugs:
 *   - One row per call — no multi-row/context-row batch edits.
 *   - No regex operations — `replace` is a literal split/join; `insert_before`/
 *     `insert_after` require an exact literal anchor match.
 *   - No new-version creation — this edits the targeted HtmlContent row IN PLACE. The
 *     ledger's before-snapshot (captured pre-write) is the rollback source, restorable
 *     via rock_restore's generic patch-back path (case c) — see classifyRestore in
 *     rock-restore.ts, which reads restore keys off payload.body's own key set.
 *   - block_id resolution refuses (does not warn-and-fallback) when the active-version
 *     rule can't select a row — surgical edits must not silently target a row Rock isn't
 *     even rendering. Pass html_content_id explicitly in that case.
 */

import { createHash } from 'node:crypto';
import { RockClient } from '../rock-client.js';
import {
  resolveGitIdentity,
  appendAudit,
  writeSnapshotFile,
  deriveToken,
  validateToken,
  captureRestSnapshot,
  type WriteOp,
} from '../safety/index.js';

// -----------------------------
// Schema
// -----------------------------

export interface GetBlockContentParams {
  block_id?: number;
  html_content_id?: number;
  all_versions?: boolean;
}

export const getBlockContentSchema = {
  name: 'get_block_content',
  description:
    'Read-only. Returns the EXACT bytes of a Rock block\'s HtmlContent — safe for Lava: ' +
    'nothing is rendered, sanitized, or re-transcribed. Pass exactly one of block_id (finds ' +
    'the block\'s HtmlContent rows and selects the actively-rendered version — the row with ' +
    'empty EntityValue, IsApproved, whose StartDateTime is null-or-past and ExpireDateTime is ' +
    'null-or-future, with the HIGHEST Version among those; if none qualifies, the highest-' +
    'Version default row is returned instead with a warning) or html_content_id (returns that ' +
    'exact row directly, no selection logic). Always returns sha256 (hex, over UTF-8 bytes), ' +
    'length_chars, length_bytes, trailing_whitespace_chars, and line_count for the selected ' +
    'content — these are the reference values a later surgical edit tool verifies its read ' +
    'and its write against, so treat them as load-bearing, not informational. Also returns ' +
    '`versions`: metadata (not content) for every HtmlContent row on the block, including ' +
    'context-specific rows (non-empty EntityValue) which are never picked as the default. ' +
    'Pass all_versions:true to include full content for every row instead of only the ' +
    'selected one. Also returns the parent Block\'s name/blockTypeId/pageId/zone for ' +
    'orientation.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      block_id: {
        type: 'number',
        description: 'The Block Id. Selects the actively-rendered HtmlContent version for this block (see tool description for the selection rule). Exactly one of block_id / html_content_id is required.',
      },
      html_content_id: {
        type: 'number',
        description: 'The HtmlContent Id directly — bypasses version selection and returns exactly this row. Exactly one of block_id / html_content_id is required.',
      },
      all_versions: {
        type: 'boolean',
        description: 'When true, include full content (not just metadata) for every HtmlContent row on the block, not only the selected one. Default false.',
      },
    },
  },
};

// -----------------------------
// Types
// -----------------------------

interface HtmlContentRow {
  Id: number;
  BlockId: number;
  Content: string;
  Version: number;
  IsApproved: boolean;
  ApprovedDateTime: string | null;
  ApprovedByPersonAliasId: number | null;
  EntityValue: string | null;
  StartDateTime: string | null;
  ExpireDateTime: string | null;
  Guid: string;
  CreatedDateTime: string | null;
  ModifiedDateTime: string | null;
}

interface BlockRow {
  Id: number;
  Name: string | null;
  BlockTypeId: number | null;
  PageId: number | null;
  Zone: string | null;
}

interface ContentStats {
  content: string;
  sha256: string;
  length_chars: number;
  length_bytes: number;
  trailing_whitespace_chars: number;
  line_count: number;
}

interface VersionMeta {
  id: number;
  version: number;
  isApproved: boolean;
  approvedDateTime: string | null;
  startDateTime: string | null;
  expireDateTime: string | null;
  entityValue: string | null;
  modifiedDateTime: string | null;
  length_chars: number;
  sha256: string;
  content?: string;
}

// -----------------------------
// Helpers
// -----------------------------

function isEmptyEntityValue(v: string | null | undefined): boolean {
  return v === null || v === undefined || v === '';
}

function computeStats(content: string): ContentStats {
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const stripped = content.replace(/[ \t\r\n]+$/, '');
  return {
    content,
    sha256,
    length_chars: content.length,
    length_bytes: Buffer.byteLength(content, 'utf8'),
    trailing_whitespace_chars: content.length - stripped.length,
    line_count: content.split('\n').length,
  };
}

function toVersionMeta(row: HtmlContentRow, includeContent: boolean): VersionMeta {
  const stats = computeStats(row.Content ?? '');
  const meta: VersionMeta = {
    id: row.Id,
    version: row.Version,
    isApproved: row.IsApproved,
    approvedDateTime: row.ApprovedDateTime ?? null,
    startDateTime: row.StartDateTime ?? null,
    expireDateTime: row.ExpireDateTime ?? null,
    entityValue: row.EntityValue ?? null,
    modifiedDateTime: row.ModifiedDateTime ?? null,
    length_chars: stats.length_chars,
    sha256: stats.sha256,
  };
  if (includeContent) meta.content = row.Content ?? '';
  return meta;
}

/**
 * Select the actively-rendered row per the rule in the module header, from the set of
 * default-context (empty EntityValue) rows only. Returns undefined if none qualify.
 */
function selectActiveRow(defaultRows: HtmlContentRow[]): HtmlContentRow | undefined {
  const now = Date.now();
  const eligible = defaultRows.filter((r) => {
    if (!r.IsApproved) return false;
    const start = r.StartDateTime ? Date.parse(r.StartDateTime) : NaN;
    if (!Number.isNaN(start) && start > now) return false;
    const expire = r.ExpireDateTime ? Date.parse(r.ExpireDateTime) : NaN;
    if (!Number.isNaN(expire) && expire < now) return false;
    return true;
  });
  if (eligible.length === 0) return undefined;
  return eligible.reduce((best, r) => (r.Version > best.Version ? r : best));
}

function highestVersion(rows: HtmlContentRow[]): HtmlContentRow | undefined {
  if (rows.length === 0) return undefined;
  return rows.reduce((best, r) => (r.Version > best.Version ? r : best));
}

async function fetchBlockInfo(
  client: RockClient,
  blockId: number
): Promise<{ block?: Record<string, unknown>; warning?: string }> {
  try {
    const block = await client.v1Get<BlockRow>(`Blocks/${blockId}`);
    return {
      block: {
        id: block.Id,
        name: block.Name ?? null,
        blockTypeId: block.BlockTypeId ?? null,
        pageId: block.PageId ?? null,
        zone: block.Zone ?? null,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      warning: `Block ${blockId} could not be loaded (${msg}) — content rows exist but the parent Block row is missing or inaccessible.`,
    };
  }
}

// -----------------------------
// Implementation
// -----------------------------

export async function getBlockContent(
  client: RockClient,
  params: GetBlockContentParams
): Promise<unknown> {
  const hasBlockId = params.block_id !== undefined && params.block_id !== null;
  const hasHtmlContentId = params.html_content_id !== undefined && params.html_content_id !== null;

  if (hasBlockId === hasHtmlContentId) {
    throw new Error(
      'get_block_content requires exactly one of block_id or html_content_id ' +
        (hasBlockId ? '(both were provided)' : '(neither was provided)') +
        '.'
    );
  }

  const allVersions = params.all_versions === true;

  // -----------------------------
  // Direct mode: html_content_id
  // -----------------------------
  if (hasHtmlContentId) {
    const id = params.html_content_id as number;
    if (!Number.isFinite(id)) {
      throw new Error(`get_block_content: html_content_id must be a finite number, got ${JSON.stringify(params.html_content_id)}.`);
    }

    let row: HtmlContentRow;
    try {
      row = await client.v1Get<HtmlContentRow>(`HtmlContents/${id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`get_block_content: no HtmlContent row found for html_content_id ${id} (${msg}). Verify the Id via the block's page in Rock.`);
    }

    const stats = computeStats(row.Content ?? '');
    const warnings: string[] = [];
    if (!isEmptyEntityValue(row.EntityValue)) {
      warnings.push(
        `HtmlContent ${id} has EntityValue "${row.EntityValue}" — this is a context-specific row, not the default-rendered content for the block.`
      );
    }

    // Fetch sibling rows (same block) for `versions`, and the Block row for orientation.
    const siblings = await fetchSiblingRows(client, row.BlockId);
    const blockInfo = await fetchBlockInfo(client, row.BlockId);
    if (blockInfo.warning) warnings.push(blockInfo.warning);

    const versions = buildVersionsList(siblings.length ? siblings : [row], row.Id, allVersions);

    return {
      block_id: row.BlockId,
      html_content_id: row.Id,
      selected: {
        id: row.Id,
        content: stats.content,
        sha256: stats.sha256,
        length_chars: stats.length_chars,
        length_bytes: stats.length_bytes,
        trailing_whitespace_chars: stats.trailing_whitespace_chars,
        line_count: stats.line_count,
        version: row.Version,
        isApproved: row.IsApproved,
        approvedDateTime: row.ApprovedDateTime ?? null,
        entityValue: row.EntityValue ?? null,
        startDateTime: row.StartDateTime ?? null,
        expireDateTime: row.ExpireDateTime ?? null,
        modifiedDateTime: row.ModifiedDateTime ?? null,
      },
      block: blockInfo.block,
      versions,
      ...(warnings.length ? { warning: warnings.join(' ') } : {}),
    };
  }

  // -----------------------------
  // block_id mode: select active version
  // -----------------------------
  const blockId = params.block_id as number;
  if (!Number.isFinite(blockId)) {
    throw new Error(`get_block_content: block_id must be a finite number, got ${JSON.stringify(params.block_id)}.`);
  }

  const rows = await client.v1Get<HtmlContentRow[]>('HtmlContents', {
    $filter: `BlockId eq ${blockId}`,
  });

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(
      `get_block_content: no HtmlContent rows found for block_id ${blockId}. Verify the block id — ` +
        'check the block on its page in Rock (Admin Tools > right-click block > Block Properties, or the ' +
        'page\'s zone layout) to confirm the Id.'
    );
  }

  const defaultRows = rows.filter((r) => isEmptyEntityValue(r.EntityValue));
  const contextRows = rows.filter((r) => !isEmptyEntityValue(r.EntityValue));

  const warnings: string[] = [];
  let selected: HtmlContentRow | undefined;

  if (defaultRows.length > 0) {
    selected = selectActiveRow(defaultRows);
    if (!selected) {
      selected = highestVersion(defaultRows);
      warnings.push(
        `No HtmlContent row for block ${blockId} currently satisfies the active-version rule ` +
          '(approved, in-window). Returning the highest-Version default-context row instead — ' +
          'this is NOT necessarily what Rock is actively rendering right now.'
      );
    }
  } else {
    // Only context-specific rows exist.
    selected = highestVersion(contextRows);
    warnings.push(
      `Block ${blockId} has only context-specific HtmlContent rows (all have a non-empty ` +
        'EntityValue) — there is no default-context row at all. Returning the highest-Version ' +
        `context row (EntityValue "${selected?.EntityValue}") as a fallback; it is not necessarily ` +
        'what any given page context renders.'
    );
  }

  // selected is guaranteed defined here: rows.length > 0 and every row falls into
  // defaultRows or contextRows, both branches above pick from a non-empty array.
  const activeRow = selected as HtmlContentRow;
  const stats = computeStats(activeRow.Content ?? '');

  const blockInfo = await fetchBlockInfo(client, blockId);
  if (blockInfo.warning) warnings.push(blockInfo.warning);

  const versions = buildVersionsList(rows, activeRow.Id, allVersions);

  return {
    block_id: blockId,
    html_content_id: activeRow.Id,
    selected: {
      id: activeRow.Id,
      content: stats.content,
      sha256: stats.sha256,
      length_chars: stats.length_chars,
      length_bytes: stats.length_bytes,
      trailing_whitespace_chars: stats.trailing_whitespace_chars,
      line_count: stats.line_count,
      version: activeRow.Version,
      isApproved: activeRow.IsApproved,
      approvedDateTime: activeRow.ApprovedDateTime ?? null,
      entityValue: activeRow.EntityValue ?? null,
      startDateTime: activeRow.StartDateTime ?? null,
      expireDateTime: activeRow.ExpireDateTime ?? null,
      modifiedDateTime: activeRow.ModifiedDateTime ?? null,
    },
    block: blockInfo.block,
    versions,
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  };
}

/** Build the `versions` array: metadata for every row, content only for the selected row unless allVersions. */
function buildVersionsList(rows: HtmlContentRow[], selectedId: number, allVersions: boolean): VersionMeta[] {
  return rows
    .slice()
    .sort((a, b) => a.Version - b.Version)
    .map((r) => toVersionMeta(r, allVersions || r.Id === selectedId));
}

/** Fetch all HtmlContent rows for a block (used by the html_content_id direct-mode path to populate `versions`). */
async function fetchSiblingRows(client: RockClient, blockId: number): Promise<HtmlContentRow[]> {
  try {
    const rows = await client.v1Get<HtmlContentRow[]>('HtmlContents', {
      $filter: `BlockId eq ${blockId}`,
    });
    return Array.isArray(rows) ? rows : [];
  } catch {
    // Non-fatal — versions list just falls back to the single row the caller already has.
    return [];
  }
}

// =====================================================================================
// edit_block_content — guarded surgical write over HtmlContent.Content
// =====================================================================================

function nowIso(): string {
  return new Date().toISOString();
}
function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}
function shortHash(s: string): string {
  return sha256Hex(s).slice(0, 16);
}

export type EditBlockContentOperation = 'replace' | 'insert_before' | 'insert_after' | 'full_replace';

export interface EditBlockContentParams {
  block_id?: number;
  html_content_id?: number;
  operation: EditBlockContentOperation;
  old_string?: string;
  new_string?: string;
  expected_count?: number;
  anchor?: string;
  text?: string;
  content?: string;
  declared_sha256?: string;
  base_sha256?: string;
  confirmation_token?: string;
  label?: string;
  session_tag?: string;
}

export const editBlockContentSchema = {
  name: 'edit_block_content',
  description:
    'Guarded, byte-exact surgical write to a Rock block\'s HtmlContent.Content — a HARD-STOP, ' +
    'two-phase action (same handshake as rock_edit). The MODEL NEVER retypes content: this tool ' +
    'computes the new content programmatically from the exact bytes get_block_content just ' +
    'returned (split/join for replace, literal splice for insert_before/insert_after), and every ' +
    'write is SHA-256-verified before AND after. Pass exactly one of block_id (must resolve to the ' +
    'actively-rendered version — see get_block_content\'s selection rule; REFUSES if only a ' +
    'warned-fallback row would be selected, since a surgical edit must not silently target a ' +
    'non-rendered version) or html_content_id (edits that exact row directly). ' +
    'Operations: "replace" — old_string must occur exactly expected_count times (default 1) in the ' +
    'CURRENT content, or the call is refused with the actual count; new_string replaces every ' +
    'occurrence (plain split/join, no regex). "insert_before"/"insert_after" — anchor must occur ' +
    'exactly once, or the call is refused with the actual count; text is spliced immediately ' +
    'before/after it. "full_replace" — content AND declared_sha256 are both required; ' +
    'sha256(content) must equal declared_sha256 or the call is refused (this is the one operation ' +
    'where the caller supplies whole new content, so it must prove that content was computed from ' +
    'a local file, not re-transcribed by eye — compute declared_sha256 from the same file you pass ' +
    'as content). ' +
    'Call WITHOUT confirmation_token first: this fetches the base content, computes the new ' +
    'content, and returns a preview (base/new sha256, length before→after, trailing-whitespace ' +
    'delta — flagged when negative, the exact failure mode this tool exists to prevent — up to 3 ' +
    'context excerpts, and a confirmation_token) WITHOUT writing. STOP and show the user the ' +
    'preview; the caller must echo back base_sha256 on the confirm call. Only after they approve, ' +
    're-call with the SAME arguments plus confirmation_token AND base_sha256 to execute: the row is ' +
    're-fetched and refused if it no longer matches base_sha256 (fresher preview needed) BEFORE the ' +
    'token is even checked; otherwise this PATCHes {Content, ApprovedDateTime} in one call (the ' +
    'proven fire-the-cache-flush sequence — ApprovedDateTime PATCH runs Rock\'s model-save pipeline, ' +
    'which broadcasts FlushCachedContent to every front-end on this multi-front-end instance; a raw ' +
    'Content-only write would NOT bust the cache), then re-fetches and verifies sha256(after) === ' +
    'new_sha256 — on mismatch returns success:false, verify:"FAILED" with both hashes and the ' +
    'snapshot ref, and does NOT auto-retry (a mangled write may have already landed; inspect before ' +
    'retrying). The before-snapshot is restorable via rock_restore (generic patch-back path, same ' +
    'as rock_edit) since the executed ledger record\'s payload.body carries the full new Content. ' +
    'Scope cuts: one row per call (no multi-row/context-row batch edits); no regex; no new-version ' +
    'creation (edits the targeted row in place — the ledger snapshot is the rollback source); ' +
    'block_id refuses non-active fallback rows.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      block_id: {
        type: 'number',
        description: 'The Block Id. Resolves to the actively-rendered HtmlContent row (same rule as get_block_content); REFUSES if only a warned fallback row would be selected. Exactly one of block_id / html_content_id is required.',
      },
      html_content_id: {
        type: 'number',
        description: 'The HtmlContent Id directly — edits exactly this row, no selection logic. Exactly one of block_id / html_content_id is required.',
      },
      operation: {
        type: 'string',
        enum: ['replace', 'insert_before', 'insert_after', 'full_replace'],
        description: 'Which surgical operation to perform. See tool description for the contract of each.',
      },
      old_string: { type: 'string', description: 'operation:"replace" — the exact literal substring to find (no regex). Must occur exactly expected_count times in the current content.' },
      new_string: { type: 'string', description: 'operation:"replace" — the literal substring that replaces every occurrence of old_string.' },
      expected_count: { type: 'number', description: 'operation:"replace" — how many occurrences of old_string are expected (default 1). Refuses with the actual count if it does not match.' },
      anchor: { type: 'string', description: 'operation:"insert_before"/"insert_after" — the exact literal substring to anchor on. Must occur exactly once.' },
      text: { type: 'string', description: 'operation:"insert_before"/"insert_after" — the literal text spliced immediately before/after the anchor.' },
      content: { type: 'string', description: 'operation:"full_replace" — the complete new content. Must hash to declared_sha256.' },
      declared_sha256: { type: 'string', description: 'operation:"full_replace" — sha256 (hex) you computed locally from the SAME bytes passed as content. Mismatch refuses the call.' },
      base_sha256: { type: 'string', description: 'REQUIRED on the confirm (phase 2) call — echo back the base_sha256 the preview returned. The row is re-fetched and compared against this before the token is even checked.' },
      confirmation_token: { type: 'string', description: 'Omit on the first (preview) call; pass the returned token (plus base_sha256) on the second (execute) call.' },
      label: { type: 'string', description: 'Optional human label recorded in the audit ledger.' },
      session_tag: {
        type: 'string',
        description:
          'Optional: your Claude session id, recorded on the audit ledger entry alongside the ' +
          'operator\'s git identity, so "did my session touch prod?" is answerable later.',
      },
    },
    required: ['operation'],
  },
};

/** Result of computing the new content for a given operation — shared by preview and execute so both phases run the identical derivation from the identical inputs. */
interface ComputedEdit {
  newContent: string;
  /** Up to 3 excerpts of ±80 chars around each match/anchor/first-difference, for the preview. */
  excerpts: string[];
}

/** sha256 of each raw operation-argument string (not the raw strings themselves) — keeps the token op canonical and cheap; see deriveEditOp below. */
interface OperationArgHashes {
  old_string_sha256?: string;
  new_string_sha256?: string;
  expected_count?: number;
  anchor_sha256?: string;
  text_sha256?: string;
  content_sha256?: string;
  declared_sha256?: string;
}

const EXCERPT_RADIUS = 80;
const MAX_EXCERPTS = 3;

function excerptAround(content: string, index: number, matchLen: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(content.length, index + matchLen + EXCERPT_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < content.length ? '…' : '';
  return prefix + content.slice(start, end) + suffix;
}

/** All (non-overlapping) indices of a literal substring in content — used for excerpts + the exact-count check. */
function findAllIndices(content: string, needle: string): number[] {
  if (needle.length === 0) return [];
  const indices: number[] = [];
  let from = 0;
  for (;;) {
    const idx = content.indexOf(needle, from);
    if (idx === -1) break;
    indices.push(idx);
    from = idx + needle.length;
  }
  return indices;
}

/**
 * Compute the new content for the given operation from the given base content. Pure and
 * deterministic — phase 1 (preview) and phase 2 (execute) both call this on their own
 * freshly-fetched base content, so a re-fetch that still hashes to base_sha256 is
 * guaranteed to reproduce byte-identical output.
 */
function computeEdit(baseContent: string, params: EditBlockContentParams): ComputedEdit {
  const op = params.operation;

  if (op === 'replace') {
    if (!params.old_string) throw new Error('edit_block_content (operation:"replace") requires old_string.');
    if (params.new_string === undefined) throw new Error('edit_block_content (operation:"replace") requires new_string.');
    const expected = params.expected_count ?? 1;
    const indices = findAllIndices(baseContent, params.old_string);
    if (indices.length !== expected) {
      throw new Error(
        `edit_block_content: old_string occurs ${indices.length} time(s) in the current content, ` +
          `not the expected ${expected}. Pass expected_count:${indices.length} if that count is ` +
          'correct, or narrow old_string to a unique excerpt.'
      );
    }
    const newContent = baseContent.split(params.old_string).join(params.new_string);
    const excerpts = indices
      .slice(0, MAX_EXCERPTS)
      .map((idx) => excerptAround(baseContent, idx, params.old_string!.length));
    return { newContent, excerpts };
  }

  if (op === 'insert_before' || op === 'insert_after') {
    if (!params.anchor) throw new Error(`edit_block_content (operation:"${op}") requires anchor.`);
    if (params.text === undefined) throw new Error(`edit_block_content (operation:"${op}") requires text.`);
    const indices = findAllIndices(baseContent, params.anchor);
    if (indices.length !== 1) {
      throw new Error(
        `edit_block_content: anchor occurs ${indices.length} time(s) in the current content, but ` +
          `operation:"${op}" requires exactly 1. Narrow anchor to a unique excerpt.`
      );
    }
    const idx = indices[0];
    const insertAt = op === 'insert_before' ? idx : idx + params.anchor.length;
    const newContent = baseContent.slice(0, insertAt) + params.text + baseContent.slice(insertAt);
    const excerpts = [excerptAround(baseContent, idx, params.anchor.length)];
    return { newContent, excerpts };
  }

  // full_replace
  if (params.content === undefined) throw new Error('edit_block_content (operation:"full_replace") requires content.');
  if (!params.declared_sha256) throw new Error('edit_block_content (operation:"full_replace") requires declared_sha256.');
  const actualSha = sha256Hex(params.content);
  if (actualSha !== params.declared_sha256) {
    throw new Error(
      `edit_block_content (operation:"full_replace"): sha256(content) is ${actualSha}, which does ` +
        `not match declared_sha256 (${params.declared_sha256}). The content you passed does not ` +
        'match what you claim to have computed it from — recompute declared_sha256 from the exact ' +
        'same bytes you are passing as content (from a local file, not by eyeballing).'
    );
  }
  return { newContent: params.content, excerpts: [] };
}

/** sha256 each raw operation-argument string rather than embedding it raw — see the module header note on token derivation. */
function hashOperationArgs(params: EditBlockContentParams): OperationArgHashes {
  const h: OperationArgHashes = {};
  if (params.old_string !== undefined) h.old_string_sha256 = sha256Hex(params.old_string);
  if (params.new_string !== undefined) h.new_string_sha256 = sha256Hex(params.new_string);
  if (params.expected_count !== undefined) h.expected_count = params.expected_count;
  if (params.anchor !== undefined) h.anchor_sha256 = sha256Hex(params.anchor);
  if (params.text !== undefined) h.text_sha256 = sha256Hex(params.text);
  if (params.content !== undefined) h.content_sha256 = sha256Hex(params.content);
  if (params.declared_sha256 !== undefined) h.declared_sha256 = params.declared_sha256;
  return h;
}

/**
 * Build the confirmation-token WriteOp for a given (target id, base content, computed new
 * content) triple. Binding baseSha means a mid-handshake content change invalidates the
 * token (the base the caller previewed against is part of what they're confirming);
 * binding newSha pins the exact result being confirmed. The raw operation argument
 * strings (old_string, new_string, anchor, text, content) are NOT embedded raw — each goes
 * through its own sha256 first (hashOperationArgs) so the token's canonical JSON stays
 * small and cheap to hash regardless of how large the surrounding HtmlContent is; this
 * mirrors rock_edit's op.body carrying the PATCH body verbatim, just with the large
 * string fields pre-hashed since here they're inputs to a derivation, not the body itself.
 */
function deriveEditOp(id: number, params: EditBlockContentParams, baseSha: string, newSha: string): WriteOp {
  return {
    verb: 'edit',
    mode: 'rest',
    controller: 'HtmlContents',
    id,
    body: {
      editOf: id,
      operation: { type: params.operation, args: hashOperationArgs(params) },
      baseSha,
      newSha,
    },
  };
}

/** Fetch the target HtmlContent row directly by Id — the shared base-fetch for both phases. */
async function fetchRowById(client: RockClient, id: number): Promise<HtmlContentRow> {
  try {
    return await client.v1Get<HtmlContentRow>(`HtmlContents/${id}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`edit_block_content: no HtmlContent row found for html_content_id ${id} (${msg}).`);
  }
}

/**
 * Resolve block_id to the target HtmlContent row Id, REFUSING (not warning) when only a
 * fallback row would be selected — mirrors get_block_content's active-version rule exactly,
 * but where that tool returns a warned fallback, this tool throws: a surgical edit must
 * never silently target a version Rock isn't actively rendering.
 */
async function resolveBlockIdToActiveRow(client: RockClient, blockId: number): Promise<HtmlContentRow> {
  const rows = await client.v1Get<HtmlContentRow[]>('HtmlContents', {
    $filter: `BlockId eq ${blockId}`,
  });
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`edit_block_content: no HtmlContent rows found for block_id ${blockId}. Verify the block id in Rock.`);
  }
  const defaultRows = rows.filter((r) => isEmptyEntityValue(r.EntityValue));
  if (defaultRows.length === 0) {
    throw new Error(
      `edit_block_content: block_id ${blockId} has only context-specific HtmlContent rows (all have ` +
        'a non-empty EntityValue) — there is no default-context row to select as the active version. ' +
        'Pass html_content_id explicitly (surgical edits refuse to guess a fallback target).'
    );
  }
  const active = selectActiveRow(defaultRows);
  if (!active) {
    throw new Error(
      `edit_block_content: no HtmlContent row for block_id ${blockId} currently satisfies the ` +
        'active-version rule (approved, in-window) — only a warned-fallback row would be selected. ' +
        'Pass html_content_id explicitly to target a specific row (surgical edits must not silently ' +
        'target a non-rendered version).'
    );
  }
  return active;
}

/** Resolve params to the target HtmlContent row (phase-1 and phase-2 both start here, each with a fresh fetch). */
async function resolveTargetRow(client: RockClient, params: EditBlockContentParams): Promise<HtmlContentRow> {
  const hasBlockId = params.block_id !== undefined && params.block_id !== null;
  const hasHtmlContentId = params.html_content_id !== undefined && params.html_content_id !== null;
  if (hasBlockId === hasHtmlContentId) {
    throw new Error(
      'edit_block_content requires exactly one of block_id or html_content_id ' +
        (hasBlockId ? '(both were provided)' : '(neither was provided)') +
        '.'
    );
  }
  if (hasHtmlContentId) {
    const id = params.html_content_id as number;
    if (!Number.isFinite(id)) {
      throw new Error(`edit_block_content: html_content_id must be a finite number, got ${JSON.stringify(params.html_content_id)}.`);
    }
    return fetchRowById(client, id);
  }
  const blockId = params.block_id as number;
  if (!Number.isFinite(blockId)) {
    throw new Error(`edit_block_content: block_id must be a finite number, got ${JSON.stringify(params.block_id)}.`);
  }
  return resolveBlockIdToActiveRow(client, blockId);
}

export async function editBlockContent(client: RockClient, params: EditBlockContentParams): Promise<unknown> {
  if (!params.operation) {
    throw new Error('edit_block_content requires operation (one of "replace", "insert_before", "insert_after", "full_replace").');
  }
  const operator = resolveGitIdentity();
  const sessionTag = params.session_tag;
  const ts = nowIso();

  // ==================================================================== Phase 2: execute
  if (params.confirmation_token) {
    if (!params.base_sha256) {
      throw new Error(
        'edit_block_content: base_sha256 is required on the confirm call — echo back the ' +
          'base_sha256 the preview returned, so a mid-handshake content change can be caught ' +
          'before the write.'
      );
    }
    const row = await resolveTargetRow(client, params);
    const currentSha = sha256Hex(row.Content ?? '');

    // Base-drift check comes BEFORE token validation — a stale-content refusal is a more
    // honest and more actionable error than "token mismatch" when the real cause is that
    // someone else edited the row mid-handshake.
    if (currentSha !== params.base_sha256) {
      throw new Error(
        `edit_block_content: the content changed since the preview — current sha256 is ${currentSha}, ` +
          `but the preview was based on ${params.base_sha256}. Get a fresh preview (re-call ` +
          'edit_block_content WITHOUT confirmation_token) and re-confirm against the new base_sha256.'
      );
    }

    const baseContent = row.Content ?? '';
    const computed = computeEdit(baseContent, params);
    const newSha = sha256Hex(computed.newContent);
    const op = deriveEditOp(row.Id, params, currentSha, newSha);

    if (!validateToken(op, params.confirmation_token)) {
      throw new Error(
        'Confirmation token mismatch — arguments changed since the preview, or the preview was ' +
          'skipped. Re-call edit_block_content WITHOUT a token to get a fresh preview.'
      );
    }

    const token = params.confirmation_token;
    const auditId = shortHash(token);

    // Before-snapshot: the full row as it stood immediately pre-write — the byte-exact
    // revert source (mirrors rock_edit's captureRestSnapshot + writeSnapshotFile).
    const snap = await captureRestSnapshot(client, 'HtmlContents', row.Id, ts);
    const snapRef = await writeSnapshotFile(`${shortHash(token)}-before`, snap.data);

    // Write: mirrors room-calendar's deploy.mjs updateBlockContent() cache-flush
    // sequence — a raw Content write does NOT bust Rock's render cache; it is the
    // ApprovedDateTime field (any field, really — but this is the proven one) that fires
    // the model-save pipeline, which broadcasts FlushCachedContent to every front-end.
    // deploy.mjs does this as POST-new-row-then-PATCH-ApprovedDateTime (it always creates a
    // new version); this tool edits the row IN PLACE per its contract, so both effects — the
    // content change and the cache-flush trigger — are one PATCH to the SAME existing row.
    const approvedDateTime = nowIso();
    await client.v1Patch(`HtmlContents/${row.Id}`, { Content: computed.newContent, ApprovedDateTime: approvedDateTime });

    // Re-fetch + verify. Never auto-retry on mismatch — a timed-out/mangled write may have
    // already landed; blind-retrying could double-apply or clobber a since-changed row.
    const after = await client.v1Get<HtmlContentRow>(`HtmlContents/${row.Id}`).catch(() => undefined);
    const afterContent = after?.Content ?? undefined;
    const afterSha = afterContent !== undefined ? sha256Hex(afterContent) : undefined;
    const verifyOk = afterSha === newSha;

    const auditLogged = await appendAudit({
      auditId,
      ts,
      phase: 'executed',
      operator,
      sessionTag,
      tool: 'edit_block_content',
      verb: 'edit',
      mode: 'rest',
      target: { entityType: 'HtmlContent', id: row.Id },
      snapshotRef: snapRef,
      // payload.body carries the FULL new Content (not a diff) — this exact shape is what
      // lets rock_restore's generic patch-back plan (classifyRestore case c) undo this edit:
      // restore keys = Object.keys(payload.body), values come from the snapshot at those keys.
      payload: {
        label: params.label,
        body: { Content: computed.newContent, ApprovedDateTime: approvedDateTime },
        operation: params.operation,
        baseSha: currentSha,
        newSha,
      },
      confirmationToken: params.confirmation_token,
      result: { success: verifyOk },
    });

    if (!verifyOk) {
      return {
        phase: 'executed',
        success: false,
        verify: 'FAILED',
        verb: 'edit',
        mode: 'rest',
        controller: 'HtmlContents',
        id: row.Id,
        expected_sha256: newSha,
        actual_sha256: afterSha ?? null,
        before_snapshot_ref: snapRef,
        warning:
          'The write completed but the after-fetch does not hash to the expected new content. ' +
          'Inspect the row in Rock (and the before-snapshot) before retrying — do NOT blind-retry ' +
          'this call; the PATCH may have partially landed.',
        auditId,
        auditLogged,
        operator,
      };
    }

    return {
      phase: 'executed',
      success: true,
      verb: 'edit',
      mode: 'rest',
      controller: 'HtmlContents',
      id: row.Id,
      before_sha256: currentSha,
      after_sha256: afterSha,
      length_chars_before: baseContent.length,
      length_chars_after: computed.newContent.length,
      length_delta_chars: computed.newContent.length - baseContent.length,
      cache_flushed: true,
      cache_flush_mechanism: 'ApprovedDateTime PATCH → Rock model-save pipeline → FlushCachedContent broadcast to all front-ends',
      before_snapshot_ref: snapRef,
      auditId,
      auditLogged,
      operator,
    };
  }

  // ==================================================================== Phase 1: preview
  const row = await resolveTargetRow(client, params);
  const baseContent = row.Content ?? '';
  const baseStats = computeStats(baseContent);
  const computed = computeEdit(baseContent, params);
  const newStats = computeStats(computed.newContent);
  const op = deriveEditOp(row.Id, params, baseStats.sha256, newStats.sha256);
  const token = deriveToken(op);
  const auditId = shortHash(token);

  const warnings: string[] = [];
  const trailingDelta = newStats.trailing_whitespace_chars - baseStats.trailing_whitespace_chars;
  if (trailingDelta < 0) {
    warnings.push(
      `Trailing whitespace is DECREASING by ${-trailingDelta} char(s) (${baseStats.trailing_whitespace_chars} → ` +
        `${newStats.trailing_whitespace_chars}) — this is the exact failure mode edit_block_content exists to ` +
        'catch (a prior full-value replace silently lost 61 bytes of trailing whitespace). Verify this is intended ' +
        'before confirming.'
    );
  }
  if (!row.IsApproved) {
    warnings.push(`HtmlContent ${row.Id} has IsApproved:false — you are editing a row that is not currently approved/live.`);
  }

  await appendAudit({
    auditId,
    ts,
    phase: 'preview',
    operator,
    sessionTag,
    tool: 'edit_block_content',
    verb: 'edit',
    mode: 'rest',
    target: { entityType: 'HtmlContent', id: row.Id },
    // Preview ledger record NEVER carries the full content — only a compact summary.
    payload: {
      label: params.label,
      operation: params.operation,
      baseSha: baseStats.sha256,
      newSha: newStats.sha256,
    },
    confirmationToken: token,
    result: { success: true },
  });

  return {
    phase: 'preview',
    verb: 'edit',
    controller: 'HtmlContents',
    id: row.Id,
    operation: params.operation,
    base_sha256: baseStats.sha256,
    new_sha256: newStats.sha256,
    length_chars_before: baseStats.length_chars,
    length_chars_after: newStats.length_chars,
    length_bytes_before: baseStats.length_bytes,
    length_bytes_after: newStats.length_bytes,
    trailing_whitespace_chars_before: baseStats.trailing_whitespace_chars,
    trailing_whitespace_chars_after: newStats.trailing_whitespace_chars,
    context_excerpts: computed.excerpts,
    cache_note:
      'Execution PATCHes {Content, ApprovedDateTime} in one call — the ApprovedDateTime bump is what ' +
      'fires Rock\'s model-save pipeline and its FlushCachedContent broadcast; this is built into ' +
      'execution, no separate flush_cache call needed.',
    is_approved: row.IsApproved,
    warning: warnings.length ? warnings.join(' ') : undefined,
    confirmation_token: token,
    next_step:
      'STOP. Show the user the preview above (especially any trailing-whitespace warning). Only after ' +
      'they approve, re-call edit_block_content with the SAME arguments plus this confirmation_token AND ' +
      'base_sha256 (echo the base_sha256 above) to execute.',
    operator,
  };
}
