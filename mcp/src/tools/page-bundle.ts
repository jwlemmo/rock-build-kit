/**
 * create_page_bundle — the proven "new admin page" recipe, in ONE call.
 *
 * On this Rock instance, standing up a new admin page has always meant five-plus separate
 * writes (Page, PageRoute, Block, HtmlContent [+ an ApprovedDateTime flush PATCH], and the
 * admin-lock Auth rows) with three separately-rememberable gotchas (see below). This tool
 * runs that whole sequence in order, in a single call, each object individually ledgered
 * and manifest-recorded so every piece stays undoable via rock_restore.
 *
 * Policy: "create = light" — same class as rock_create. Every object this tool writes is
 * BRAND NEW (a fresh Page and everything hanging off it), so there is no confirmation_token,
 * no two-phase handshake, no impact analysis: it executes immediately. The admin-lock Auth
 * rows are part of the create (they lock a page that didn't exist a moment ago), not an edit
 * of something pre-existing, so they follow the same light path.
 *
 * The three gotchas this tool encodes so nobody has to rediscover them:
 *   1. HtmlContent needs TWO writes, not one: POST a full new version row, THEN PATCH its
 *      ApprovedDateTime. A raw Content-only POST does not fire Rock's FlushCachedContent
 *      broadcast (see block-content.ts's cache-rule note and room-calendar/build/
 *      deploy.mjs's updateBlockContent) — the ApprovedDateTime PATCH runs the model-save
 *      pipeline that broadcasts the flush to every front-end on this multi-front-end
 *      instance. Pushing a full version (rather than routing through a WYSIWYG editor) also
 *      bypasses the sanitizer that can strip inline <style>/<svg> tags.
 *   2. REST-created PageRoutes do NOT register with Rock's routing table until the route
 *      string is re-added via the admin page editor UI (a cache clear is NOT enough; an
 *      app-pool recycle also works). This tool's result carries an explicit warning about
 *      this whenever it creates a route — the route WILL 404 until that manual step happens.
 *   3. Auth ordering for a locked page: Allow role(s) first at Order 0..n-1, then a
 *      Deny-all-users row LAST (SpecialRole:1, Order n). Getting the order or the
 *      allow/deny split wrong silently leaves a page open (or closes it to everyone,
 *      including the roles meant to have access). People go into the security-role GROUP
 *      via add_group_member elsewhere — this tool only ever writes the page's own Auth
 *      rows, never a per-person grant.
 *
 * Proven default ids (layout / HTML Content block type / Page EntityTypeId) come from
 * room-calendar/build/deploy.mjs, cross-checked against new-hire-onboarding/build/
 * (04-entry-page.mjs, 05-dashboard.mjs) — see the CFG constants below for the exact
 * cross-reference per value. There is deliberately NO site param: Rock's Page entity has
 * no SiteId field (the layout determines the site) and neither proven source sends one —
 * an accepted-but-unused param would let a caller believe they targeted a site with no
 * signal otherwise.
 *
 * Sequence (STOPS at first failure — see failure contract in the function body):
 *   1. POST Pages                              → pageId
 *   2. [if route] POST PageRoutes               → routeId (+ registration warning)
 *   3. POST Blocks                              → blockId
 *   4. POST HtmlContents, then PATCH ApprovedDateTime on the new row → htmlContentId
 *   5. [if allow_role_ids] POST Auths: allow(s) then deny-all         → authIds
 *   6. Verify: GET each created object back
 *
 * Each created object gets its OWN appendAudit record (phase 'create') and its own
 * recordCreated manifest entry, so rock_restore can undo any single piece (e.g. just the
 * Auth rows, or just the route) without touching the rest.
 */

import { createHash } from 'node:crypto';
import { RockClient } from '../rock-client.js';
import { resolveGitIdentity, appendAudit, recordCreated } from '../safety/index.js';

// IDs are discovered from this target before ANY write; never copied from another church.
async function discoverPageIds(client: RockClient, params: CreatePageBundleParams) {
  let layoutId = params.layout_id;
  if (layoutId === undefined) {
    const parent = await client.v1Get<Record<string, unknown>>(`Pages/${params.parent_page_id}`);
    layoutId = Number(parent.LayoutId ?? parent.layoutId);
  }
  let blockTypeId = params.block_type_id;
  if (blockTypeId === undefined) {
    const rows = await client.v1Get<Array<Record<string, unknown>>>('BlockTypes', { $filter: "Path eq '~/Blocks/Cms/HtmlContent.ascx'" });
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Cannot uniquely discover HTML Content BlockType. Supply block_type_id from this church.');
    blockTypeId = Number(rows[0].Id ?? rows[0].id);
  }
  let pageEntityTypeId: number | undefined;
  if (params.allow_role_ids?.length) {
    const rows = await client.v1Get<Array<Record<string, unknown>>>('EntityTypes', { $filter: "Name eq 'Rock.Model.Page'" });
    if (!Array.isArray(rows) || rows.length !== 1) throw new Error('Cannot uniquely discover Rock.Model.Page EntityType. Nothing written.');
    pageEntityTypeId = Number(rows[0].Id ?? rows[0].id);
  }
  for (const value of [layoutId, blockTypeId, ...(pageEntityTypeId === undefined ? [] : [pageEntityTypeId])]) {
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error('Invalid discovered page configuration. Nothing written.');
  }
  return { layoutId: layoutId!, blockTypeId: blockTypeId!, pageEntityTypeId };
}

// ---------------------------------------------------------------- helpers

function nowIso(): string {
  return new Date().toISOString();
}
function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}
function newIdFrom(res: unknown): string | number | null {
  if (typeof res === 'number') return res;
  if (res && typeof res === 'object') {
    const o = res as Record<string, unknown>;
    const v = o.Id ?? o.id ?? null;
    return typeof v === 'number' || typeof v === 'string' ? v : null;
  }
  const n = Number(res);
  return Number.isFinite(n) ? n : null;
}
/** name → a URL-safe, lowercase, hyphenated slug, for the default manifest key prefix. */
function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'page'
  );
}

// ---------------------------------------------------------------- params / schema

export interface CreatePageBundleParams {
  name: string;
  parent_page_id: number;
  content: string;
  route?: string;
  layout_id?: number;
  block_name?: string;
  block_type_id?: number;
  zone?: string;
  order?: number;
  icon_css_class?: string;
  allow_role_ids?: number[];
  description?: string;
  manifest_section?: string;
  manifest_key_prefix?: string;
  label?: string;
  session_tag?: string;
}

export const createPageBundleSchema = {
  name: 'create_page_bundle',
  description:
    'CREATE a brand-new admin page bundle in ONE call — Page + (optional) PageRoute + Block + ' +
    'HtmlContent + (optional) admin-lock Auth rows, the proven "new admin page" recipe run in ' +
    'order. "create = light" (same class as rock_create): every object is brand new, so this ' +
    'executes immediately with NO confirmation_token — including the Auth rows, which lock a ' +
    "page that didn't exist a moment ago and so count as part of the create, not an edit of " +
    'something pre-existing. ' +
    'Sequence: (1) POST Pages, (2) if route is given, POST PageRoutes, (3) POST Blocks, ' +
    '(4) POST HtmlContents then PATCH its ApprovedDateTime (two writes, not one — the PATCH is ' +
    "what fires Rock's FlushCachedContent broadcast across every front-end on this multi-front-" +
    'end instance; a raw Content-only POST would leave stale/no cache), (5) if allow_role_ids is ' +
    'given, POST Auths: an Allow row per role (Order 0..n-1, Action "View", AllowOrDeny "A") ' +
    'THEN one Deny-all-users row LAST (Order n, SpecialRole 1, AllowOrDeny "D") — get this order ' +
    'or split wrong and the page is either open to everyone or closed to the roles meant to see ' +
    'it. (6) GET every created object back to verify. ' +
    'IMPORTANT GOTCHA: a REST-created PageRoute does NOT register with Rock\'s routing table ' +
    'until the route string is re-added via the admin page editor UI (a cache clear is NOT ' +
    'enough; an app-pool recycle also works) — the result carries an explicit warning about ' +
    'this whenever route is set; the URL will 404 until that manual step happens. ' +
    'People belong in the security-role GROUP (add_group_member) — this tool only ever writes ' +
    "the new page's own Auth rows, never a per-person grant. " +
    'STOPS at the first failed step (no rollback — creates are light and each already-created ' +
    'object is individually undoable) and reports created_so_far with each piece\'s auditId. ' +
    'Every created object (page, route, block, html content, each auth row) gets its OWN audit ' +
    'ledger record (logs/changes.jsonl) and manifest entry, so rock_restore can undo any single ' +
    'piece without touching the rest.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Page name — used for InternalName/PageTitle/BrowserTitle, and (slugified) as the default manifest key prefix.' },
      parent_page_id: { type: 'number', description: 'Id of the parent Page this new page nests under.' },
      content: { type: 'string', description: 'The HtmlContent body (full markup/Lava) for the new block\'s content.' },
      route: { type: 'string', description: 'Optional route string, e.g. "MyAdminPage". A leading slash is stripped if present (Rock stores routes without one). When set, creates a PageRoute and the result carries the registration-gotcha warning.' },
      layout_id: { type: 'number', description: 'Layout ID from this church; omitted means inherit the parent page layout. The layout determines the site (Page has no SiteId field).' },
      block_name: { type: 'string', description: 'Block Name. Defaults to name.' },
      block_type_id: { type: 'number', description: 'HTML Content BlockType ID from this church; omitted means discover the unique standard HTML Content block by path.' },
      zone: { type: 'string', description: 'Block zone. Default "Main".' },
      order: { type: 'number', description: 'Block Order. Default 0.' },
      icon_css_class: { type: 'string', description: 'Optional IconCssClass for the new page.' },
      allow_role_ids: {
        type: 'array',
        items: { type: 'number' },
        description: 'Security-role GroupIds to Allow View on the new page. When present, writes the admin-lock Auth set: one Allow row per role (Order 0..n-1) THEN one Deny-all-users row LAST (Order n, SpecialRole 1). Omit to leave the new page unlocked (inherits its parent\'s security).',
      },
      description: { type: 'string', description: 'Optional Page Description.' },
      manifest_section: { type: 'string', description: 'Manifest section to record all created ids under. Default "page-bundles".' },
      manifest_key_prefix: { type: 'string', description: 'Manifest key prefix for each created object (suffixed with -page/-route/-block/-htmlcontent/-auth-N). Default: a slug of name.' },
      label: { type: 'string', description: 'Optional human label recorded in each object\'s audit ledger entry (prefixed per-object, e.g. "<label> — page").' },
      session_tag: {
        type: 'string',
        description:
          'Optional: your Claude session id, recorded on every object\'s audit ledger entry ' +
          'alongside the operator\'s git identity, so "did my session touch prod?" is answerable later.',
      },
    },
    required: ['name', 'parent_page_id', 'content'],
  },
};

// ---------------------------------------------------------------- validation

function validateParams(params: CreatePageBundleParams): { route?: string; routeStripped: boolean } {
  if (!params.name || !params.name.trim()) {
    throw new Error('create_page_bundle: name is required and must be non-empty.');
  }
  if (!Number.isFinite(params.parent_page_id)) {
    throw new Error(`create_page_bundle: parent_page_id must be a finite number, got ${JSON.stringify(params.parent_page_id)}.`);
  }
  if (params.content === undefined || params.content === null) {
    throw new Error('create_page_bundle: content is required (the HtmlContent body).');
  }
  if (params.layout_id !== undefined && !Number.isFinite(params.layout_id)) {
    throw new Error(`create_page_bundle: layout_id must be a finite number, got ${JSON.stringify(params.layout_id)}.`);
  }
  if (params.block_type_id !== undefined && !Number.isFinite(params.block_type_id)) {
    throw new Error(`create_page_bundle: block_type_id must be a finite number, got ${JSON.stringify(params.block_type_id)}.`);
  }
  if (params.order !== undefined && !Number.isFinite(params.order)) {
    throw new Error(`create_page_bundle: order must be a finite number, got ${JSON.stringify(params.order)}.`);
  }
  let route: string | undefined;
  let routeStripped = false;
  if (params.route !== undefined && params.route !== null && params.route !== '') {
    route = params.route;
    if (route.startsWith('/')) {
      route = route.replace(/^\/+/, '');
      routeStripped = true;
    }
  }
  if (params.allow_role_ids !== undefined) {
    if (!Array.isArray(params.allow_role_ids)) {
      throw new Error('create_page_bundle: allow_role_ids must be an array of numbers.');
    }
    for (const id of params.allow_role_ids) {
      if (!Number.isFinite(id)) {
        throw new Error(`create_page_bundle: allow_role_ids must all be finite numbers — got ${JSON.stringify(id)}.`);
      }
    }
  }
  return { route, routeStripped };
}

// ---------------------------------------------------------------- main

export async function createPageBundle(client: RockClient, params: CreatePageBundleParams): Promise<unknown> {
  const { route, routeStripped } = validateParams(params);
  const operator = resolveGitIdentity();
  const sessionTag = params.session_tag;
  const manifestSection = params.manifest_section ?? 'page-bundles';
  const manifestKeyPrefix = params.manifest_key_prefix ?? slugify(params.name);
  const labelBase = params.label ?? params.name;
  const { layoutId, blockTypeId, pageEntityTypeId } = await discoverPageIds(client, params);
  const zone = params.zone ?? 'Main';
  const order = params.order ?? 0;
  const blockName = params.block_name ?? params.name;

  const createdSoFar: Array<{ object: string; id: string | number; auditId: string }> = [];
  const auditIds: string[] = [];
  const warnings: string[] = [];
  if (routeStripped) {
    warnings.push(`route had a leading slash — stripped to "${route}" (Rock stores routes without one).`);
  }

  /** Append one audit record + manifest entry for a just-created object; pushes onto createdSoFar/auditIds. */
  async function ledgerOne(opts: {
    object: string;
    entityType: string;
    newId: string | number;
    body: Record<string, unknown>;
    manifestKey: string;
  }): Promise<string> {
    const ts = nowIso();
    const auditId = shortHash(`create|page-bundle|${opts.object}|${opts.entityType}|${opts.newId}|${ts}`);
    await appendAudit({
      auditId,
      ts,
      phase: 'create',
      operator,
      sessionTag,
      tool: 'create_page_bundle',
      verb: 'create',
      mode: 'rest',
      target: { entityType: opts.entityType, id: opts.newId },
      payload: { label: `${labelBase} — ${opts.object}`, body: opts.body },
      result: { success: true, newId: opts.newId },
    });
    recordCreated(manifestSection, opts.manifestKey, opts.newId);
    createdSoFar.push({ object: opts.object, id: opts.newId, auditId });
    auditIds.push(auditId);
    return auditId;
  }

  // ==================================================================== 1. Page
  const pageBody: Record<string, unknown> = {
    InternalName: params.name,
    PageTitle: params.name,
    BrowserTitle: params.name,
    ParentPageId: params.parent_page_id,
    LayoutId: layoutId,
    IconCssClass: params.icon_css_class ?? '',
    Description: params.description ?? '',
    IsSystem: false,
    // New pages hide Rock's stock title and breadcrumb; the page's own content carries its heading.
    // Standard for MCP-created pages until the design system settles page chrome (portable default).
    PageDisplayTitle: false,
    PageDisplayBreadCrumb: false,
    PageDisplayIcon: false,
    PageDisplayDescription: false,
  };
  let pageId: string | number;
  try {
    const pageRes = await client.v1Post<unknown>('Pages', pageBody);
    const id = newIdFrom(pageRes);
    if (id == null) {
      throw new Error(`Pages POST returned no usable Id (${JSON.stringify(pageRes).slice(0, 200)}).`);
    }
    pageId = id;
  } catch (err) {
    return failureResult('page', err, createdSoFar);
  }
  await ledgerOne({ object: 'page', entityType: 'Page', newId: pageId, body: pageBody, manifestKey: `${manifestKeyPrefix}-page` });

  // ==================================================================== 2. PageRoute (optional)
  let routeId: string | number | undefined;
  if (route) {
    const routeBody: Record<string, unknown> = { PageId: pageId, Route: route, IsGlobal: false, IsSystem: false };
    try {
      const routeRes = await client.v1Post<unknown>('PageRoutes', routeBody);
      const id = newIdFrom(routeRes);
      if (id == null) {
        throw new Error(`PageRoutes POST returned no usable Id (${JSON.stringify(routeRes).slice(0, 200)}).`);
      }
      routeId = id;
    } catch (err) {
      return failureResult('route', err, createdSoFar);
    }
    await ledgerOne({ object: 'route', entityType: 'PageRoute', newId: routeId, body: routeBody, manifestKey: `${manifestKeyPrefix}-route` });
    warnings.push(
      `PageRoute "${route}" was created via REST but will NOT register with Rock's routing table until ` +
        'the route string is re-added via the admin page editor UI (a cache clear is NOT enough; an ' +
        `app-pool recycle also works) — the page will 404 at /${route} until that manual step happens. ` +
        `Until then, reach the page at /page/${pageId}.`
    );
  }

  // ==================================================================== 3. Block
  const blockBody: Record<string, unknown> = { PageId: pageId, BlockTypeId: blockTypeId, Zone: zone, Name: blockName, Order: order, IsSystem: false };
  let blockId: string | number;
  try {
    const blockRes = await client.v1Post<unknown>('Blocks', blockBody);
    const id = newIdFrom(blockRes);
    if (id == null) {
      throw new Error(`Blocks POST returned no usable Id (${JSON.stringify(blockRes).slice(0, 200)}).`);
    }
    blockId = id;
  } catch (err) {
    return failureResult('block', err, createdSoFar);
  }
  await ledgerOne({ object: 'block', entityType: 'Block', newId: blockId, body: blockBody, manifestKey: `${manifestKeyPrefix}-block` });

  // ==================================================================== 4. HtmlContent (POST + ApprovedDateTime flush PATCH)
  const htmlContentBody: Record<string, unknown> = { BlockId: blockId, Content: params.content, EntityValue: '', Version: 1, IsApproved: true };
  let htmlContentId: string | number;
  try {
    const htmlRes = await client.v1Post<unknown>('HtmlContents', htmlContentBody);
    const id = newIdFrom(htmlRes);
    if (id == null) {
      throw new Error(`HtmlContents POST returned no usable Id (${JSON.stringify(htmlRes).slice(0, 200)}).`);
    }
    htmlContentId = id;
  } catch (err) {
    return failureResult('html_content', err, createdSoFar);
  }
  // Ledger the row the moment it exists in Rock — the ledger records what HAPPENED, not what
  // completed cleanly. The flush PATCH below is a separate benign cache step, not part of the
  // row's identity: if it fails, the row is still real (just cache-stale) and MUST be visible
  // to created_so_far / rock_restore rather than becoming an invisible orphan.
  await ledgerOne({
    object: 'htmlcontent',
    entityType: 'HtmlContent',
    newId: htmlContentId,
    body: htmlContentBody,
    manifestKey: `${manifestKeyPrefix}-htmlcontent`,
  });
  // The proven cache-flush sequence (deploy.mjs updateBlockContent / block-content.ts's edit_block_content):
  // PATCHing ApprovedDateTime runs the model-save pipeline, which broadcasts FlushCachedContent to every
  // front-end. A raw Content-only POST does not do this by itself.
  try {
    await client.v1Patch(`HtmlContents/${htmlContentId}`, { ApprovedDateTime: nowIso() });
  } catch (err) {
    return failureResult(
      'html_content_flush',
      err,
      createdSoFar,
      `the HtmlContent row (id ${htmlContentId}) exists but is cache-stale — re-flush via ` +
        'flush_cache target:"htmlcontent", or undo it via rock_restore with its auditId'
    );
  }

  // ==================================================================== 5. Auth (optional admin lock)
  const authIds: Array<string | number> = [];
  if (params.allow_role_ids && params.allow_role_ids.length > 0) {
    const roles = params.allow_role_ids;
    for (let i = 0; i < roles.length; i++) {
      const authBody: Record<string, unknown> = {
        EntityTypeId: pageEntityTypeId,
        EntityId: pageId,
        Order: i,
        Action: 'View',
        AllowOrDeny: 'A',
        SpecialRole: 0,
        GroupId: roles[i],
      };
      let authId: string | number;
      try {
        const authRes = await client.v1Post<unknown>('Auths', authBody);
        const id = newIdFrom(authRes);
        if (id == null) {
          throw new Error(`Auths POST (allow role ${roles[i]}) returned no usable Id (${JSON.stringify(authRes).slice(0, 200)}).`);
        }
        authId = id;
      } catch (err) {
        return failureResult(`auth_allow_${i}`, err, createdSoFar);
      }
      await ledgerOne({ object: `auth-${i}`, entityType: 'Auth', newId: authId, body: authBody, manifestKey: `${manifestKeyPrefix}-auth-${i}` });
      authIds.push(authId);
    }
    // Deny-all-users row LAST (Order = roles.length), after every Allow.
    const denyOrder = roles.length;
    const denyBody: Record<string, unknown> = {
      EntityTypeId: pageEntityTypeId,
      EntityId: pageId,
      Order: denyOrder,
      Action: 'View',
      AllowOrDeny: 'D',
      SpecialRole: 1,
    };
    let denyId: string | number;
    try {
      const denyRes = await client.v1Post<unknown>('Auths', denyBody);
      const id = newIdFrom(denyRes);
      if (id == null) {
        throw new Error(`Auths POST (deny-all) returned no usable Id (${JSON.stringify(denyRes).slice(0, 200)}).`);
      }
      denyId = id;
    } catch (err) {
      return failureResult('auth_deny_all', err, createdSoFar);
    }
    await ledgerOne({ object: `auth-${denyOrder}`, entityType: 'Auth', newId: denyId, body: denyBody, manifestKey: `${manifestKeyPrefix}-auth-${denyOrder}` });
    authIds.push(denyId);
  }

  // ==================================================================== 6. Verify chain
  const verified: Record<string, boolean> = {};
  try {
    const pageRow = await client.v1Get<unknown>(`Pages/${pageId}`);
    verified.page = !!pageRow && newIdFrom(pageRow) != null;
  } catch {
    verified.page = false;
  }
  if (routeId !== undefined) {
    try {
      const routeRow = await client.v1Get<unknown>(`PageRoutes/${routeId}`);
      verified.route = !!routeRow && newIdFrom(routeRow) != null;
    } catch {
      verified.route = false;
    }
  }
  try {
    const blockRow = await client.v1Get<unknown>(`Blocks/${blockId}`);
    verified.block = !!blockRow && newIdFrom(blockRow) != null;
  } catch {
    verified.block = false;
  }
  try {
    const htmlRow = await client.v1Get<unknown>(`HtmlContents/${htmlContentId}`);
    verified.html_content = !!htmlRow && newIdFrom(htmlRow) != null;
  } catch {
    verified.html_content = false;
  }
  if (authIds.length > 0) {
    let allAuthsVerified = true;
    for (const id of authIds) {
      try {
        const authRow = await client.v1Get<unknown>(`Auths/${id}`);
        if (!authRow || newIdFrom(authRow) == null) allAuthsVerified = false;
      } catch {
        allAuthsVerified = false;
      }
    }
    verified.auth = allAuthsVerified;
  }

  warnings.push(
    '/rock-build reminder: only NEW objects were touched by this call — nothing pre-existing on ' +
      'this Rock instance was edited or deleted.'
  );

  const urlHint = route ? `/${route}` : `/page/${pageId}`;

  return {
    success: true,
    page_id: pageId,
    route_id: routeId,
    block_id: blockId,
    html_content_id: htmlContentId,
    auth_ids: authIds.length > 0 ? authIds : undefined,
    url_hint: urlHint,
    verified,
    warnings,
    audit_ids: auditIds,
    manifest: { section: manifestSection, key_prefix: manifestKeyPrefix },
    operator,
  };
}

/** Shared failure-contract shape: STOP immediately, no rollback, report what was created so far.
 *  `hint` is a per-step recovery note (e.g. the flush-failure case: the row exists, just cache-stale). */
function failureResult(
  failedStep: string,
  err: unknown,
  createdSoFar: Array<{ object: string; id: string | number; auditId: string }>,
  hint?: string
): { success: false; failed_step: string; error: string; created_so_far: Array<{ object: string; id: string | number; auditId: string }>; undo_hint: string; hint?: string } {
  return {
    success: false,
    failed_step: failedStep,
    error: err instanceof Error ? err.message : String(err),
    created_so_far: createdSoFar,
    undo_hint: 'each created object can be reversed via rock_restore with its auditId',
    ...(hint !== undefined ? { hint } : {}),
  };
}
