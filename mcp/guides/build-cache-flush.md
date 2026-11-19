## ⚑ The cache-flush rule (the single most-relearned gotcha — what you wrote decides what you
flush; see the decision table below)
1. **HtmlContent** (block content/Lava): a raw REST/SQL write updates the row but does NOT
   fire Rock's cache invalidation, so the app keeps serving the old render. Fix: **PATCH the
   HtmlContent row's `ApprovedDateTime` = now** — that runs the model-save pipeline and
   broadcasts `FlushCachedContent` to all front-ends. (the kit root's `reference/rock-field-notes.md`
   `updateBlockContent()` does exactly this.) Since v18, Cache Manager "Clear Cache" reaches
   every web server, and a clear-all is headless: `~/rock-build-kit/tools/rock-ui/rock-ui.mjs [--prod] cache clear` — no
   browser trip, use only within the authorized scope.
   **`ApprovedDateTime` is stored/compared in UTC and picks the active version:** Rock serves the
   HtmlContent row with the LATEST ApprovedDateTime — stamping the server's local time made a *newer*
   version silently lose to the old one (always stamp with `utcnow()`/`toISOString()`), and
   stamping every version identically lets the pick tie-break to the OLDEST (the pre-7/14/26
   `flush_cache target:block` did exactly that; it now stamps the newest row last — on older
   builds, follow with `target:htmlcontent` on the row that should win).
2. **Block settings / AttributeValue / Auth** written via SQL or REST: these writes don't fire
   Rock's cache invalidation. Fixes: `rock-ui.mjs [--prod] security resave <page|block|attribute|restcontroller|entityTypeId> <id>`
   re-saves the entity's Security dialog (flips one rule and back, verifies every rule ends
   unchanged) — or `rock-ui cache clear`, which since v18 reaches every web server and is
   headless. **A NEW block on an existing page being absent is NOT proof the create/Auth write
   failed — it reads exactly like an Auth failure and isn't one.** Rock caches a page's block
   list separately from any block's own content; flush it with `flush_cache target:"page"`
   (Page ModifiedDateTime PATCH — refreshes page properties AND the cached block list; picks up
   after the MCP server restarts) or `rock-ui cache clear`. (Confirmed twice, same mistake both
   times: `Claude-Codex-Projects/f90590ca` 8/3 and `Claude-Codex-Projects/3bb7c3df` 8/7. Full
   writeup: `mcp/reference/rock-runtime-gotchas.md` §1.3.) Also: a REST
   **Block PATCH flushes that block's cache itself** — PreHtml/CssClass edits show up without
   a clear, and `flush_cache target:"blocksettings"` (Block ModifiedDateTime PATCH) covers
   raw-SQL PreHtml changes.
3. **Metric source edits:** after editing a metric's `SourceSql` via REST, the MetricCache can
   be stale and the calc job skips it until a full clear: `rock-ui.mjs [--prod] cache clear`.
4. **Workflow action/config edits:** a `WorkflowType.ModifiedDateTime` bump usually works, but on
   this multi-front-end box it has failed to propagate a workflow-action fix — instances kept
   running the old config until a Cache Manager (page <discover ID>) Clear Cache. For action/criteria
   changes, flush AND re-verify on a fresh instance before trusting it.
   **Confirmed hard on 7/14/26 (handbook e-sign):** a RunLava action's config AttributeValue was
   rewritten via REST at 17:09 + WorkflowType touch at 17:12 — a live run at 17:25 still executed
   the OLD Lava (Success:True, wrong behavior). Form-level PersonEntry column edits propagated in
   ~1 min all day; **action-config AttributeValues are the sticky ones.** Do not report an
   action-config fix as done until a fresh live instance demonstrably ran the new version.
   A full clear is still required: `rock-ui.mjs [--prod] cache clear`.
5. **An API-created PageRoute is NOT in the ASP.NET route table.** The row exists in `PageRoute`,
   `/page/{id}` works, but the friendly route 404s (Site 8 shows its 404 page, NOT a login
   redirect — looks exactly like an auth problem and isn't). A PageRoute PATCH does NOT fix it;
   Cache Manager Clear Cache does NOT re-register routes. Fix: `rock-ui.mjs [--prod] route save <PageRouteId>`
   (verified 404→200; it's the UI page <discover ID> Edit→Save under the hood, which calls
   `ReregisterRoutes()`). Learned on 7/14/26 after an hour of auth-hunting on the handbook route.

**What did you write → what to flush**

| You wrote | Flush |
|---|---|
| HtmlContent body / Lava | `flush_cache target:"htmlcontent" id:<HtmlContentId>` (or `target:"block"`) |
| Block PreHtml / PostHtml / CssClass via REST PATCH | nothing — the Block PATCH self-flushes |
| Block PreHtml via raw SQL | `flush_cache target:"blocksettings" id:<BlockId>` (new target; picked up after the MCP server restarts) |
| Block settings / AttributeValue / Auth | `rock-ui.mjs [--prod] security resave <page/block/attribute/restcontroller/entityTypeId> <id>` — or `rock-ui cache clear` |
| **A NEW Block on an existing page** | `flush_cache target:"page" id:<PageId>` (new target — refreshes page properties AND the page's cached block list; picked up after the MCP server restarts) — or `rock-ui cache clear` |
| Metric `SourceSql` | full clear: `rock-ui cache clear` |
| WorkflowActionType rows / action config AttributeValues | `flush_cache target:"workflowtype"` **and** `rock-ui cache clear`, then prove it on a fresh live instance |
| A PageRoute | `rock-ui.mjs [--prod] route save <PageRouteId>` (a PageRoute PATCH does NOT fix it) |
| A LavaShortcode | `rock-ui.mjs [--prod] shortcode save <id>` |
| Want to run a Rock job now (Send Communications, etc.) | `rock-ui.mjs [--prod] job run <id/name> [--wait]` (calls the Jobs grid's RunNow action; `--wait` polls LastStatus) |

6. **`flush_cache` takes exactly `target` + `id`, nothing else.** `{}`, `{scope:"all"}`,
   `{target:"all"}`, `{cache_type,entity_id}` are all wrong. A mis-shaped call on some builds
   returns `Rock SQL/Lava error: Invalid column name 'NaN'` — that is **your argument shape,
   not a broken server** (`Math.trunc(undefined)` → `WHERE BlockId = NaN`). One session shipped
   "flush_cache via MCP is broken" into a delivered runbook on the strength of that error (8/7/26).
7. **The MCP servers are long-lived processes.** `rock-rms-v2` and `rock-rms-dev` both launch the same
   `mcp/dist/index.js`, but each keeps whatever build it started with — on 8/7
   they returned *different* errors for the same bad call because one was serving a stale build.
   After a rebuild, restart the session/servers or you're testing yesterday's code.

Full detail, evidence, and quotes for all of the above:
`mcp/reference/rock-runtime-gotchas.md` §1–2.
