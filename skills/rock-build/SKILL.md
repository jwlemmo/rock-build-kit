---
name: rock-build
description: >
  Hard-won recipes for BUILDING things inside the source church's Rock RMS — pages, blocks,
  HtmlContent, dashboards, metrics, workflows, badges, and scoped reports — via the
  rock-rms-v2 MCP. Use when the user asks to build/create/add a page, block, dashboard,
  metric, workflow, badge, report, e-signature form, file-upload form, or admin console in
  Rock, or to deploy an HTML app into a Rock block. Encodes the cache-flush rules, the
  WorkflowActionType/metric/badge/report/e-sign/AttributeMatrix recipes, the byte-fidelity
  and binary-transport traps, and when to drop to a build script. Also /rock-build.
  (This is for CONSTRUCTION. For read-only queries/reports use rock-query; for granting
  access use rock-grant-access.) Changing anything in Rock? Load rock-change-management and
  open a change bundle before the first write.
---

# rock-build — building inside Rock RMS

Read `START-HERE.md` and `SETUP.md` first when the church connection is not configured. Resolve paths relative to this kit root (or ROCK_KIT_ROOT after installation).

Use the configured church's sandbox when available. The optional `rock-change-management` skill records changes and promotion. Never assume a working sandbox, shared keys, standing authorization, a specific Rock version, or a permission grant.

These recipes preserve observations from real builds. They are hypotheses to verify on the connected Rock version, not guarantees. Every numeric object ID must be discovered on this church using schema/metadata queries. Never execute historical IDs or copy credentials from examples.

New pages hide the built-in title and breadcrumb by default; set a clear heading in the content. Keep labels and error messages useful and concise.

**Deep runtime behaviors live elsewhere:** cache-scope internals, the workflow engine's
`IsProcessing` lock, Rock's own field validators, Communication/BinaryFile mechanics, and the
HTTP-200-with-inline-Lava-error shape are documented once, for every Rock client (MCP, build
scripts, Vercel workers, Lava) at
`mcp/reference/rock-runtime-gotchas.md` — read it, don't re-derive it.

**Everything else learned on past builds** — v19 traps (PreHtml truncation, core.css
`.show{display:block!important}`), Lava/SQL parse traps, REST quirks, workflow Delay/webhook
internals, metrics, CSS, Rock AI agents — is in `reference/rock-field-notes.md`, with a
"conflicts to verify" list at the top. Skim the section for your area before you build.

## Two lanes — pick before you start
- **MCP lane (this skill):** interactive builds, one or a handful of objects, anything you
  want the two-phase preview + audit ledger under. Use `rock_create` / `rock_edit` /
  `rock_delete`.
- **Script lane:** a workflow with hundreds of actions, a whole dashboard, or an HTML app
  deployed into a block. Hand-write an idempotent, `ForeignKey`-tagged Node build script and
  version-control it. Proven models: `reference/rock-field-notes.md` and
  `reference/rock-field-notes.md` (which bakes the cache-flush below). One reviewed
  script beats hundreds of tool calls; Spark's own engineers recommend SQL over per-object
  REST for bulk. See `reference/rock-field-notes.md` for the two-lane rationale.

## Universal write mechanics
- Execute authorized writes in the primary session; prepare and review payloads before changing shared records.
- `rock_create` = light (executes + ledgers immediately). `rock_edit` / `rock_delete` =
  two-phase: first call returns a preview (before-snapshot + impact + `confirmation_token`);
  re-call with identical args + the token to execute. Show the preview before confirming.
- **Write-path decision table — `execute_sql` is READ-ONLY. Do not send it a write.** Writes
  REST can't do (e.g. `WorkflowActionType`) go through `rock_create`/`rock_edit`/`rock_delete`
  with `mode:"sql"`. Sending INSERT/UPDATE/DELETE/MERGE/CREATE/BULK through `execute_sql` is the
  single most common Rock-MCP mistake in the transcripts — it has never once been the right call.

  | Goal | Tool + exact args |
  |---|---|
  | Read rows | `execute_sql { query }` — **add a `TOP n`**; unbounded reads have blown the token ceiling and spilled to disk |
  | Column names | `get_schema { table }` before writing SQL, not after the `Invalid column name` |
  | New entity via REST | `rock_create { mode:"rest", controller:"Metrics", body:{…}, label }` — **not** `entity`/`data`, **not** `entityType`/`values` |
  | New row REST can't do | `rock_create { mode:"sql", sql, verifyByGuid:"<the literal Guid you inlined>", label }` |
  | Change existing | `rock_edit { mode:"sql", sql, snapshotQuery, label }` → preview → same args + `confirmation_token` |
  | Delete | `rock_delete { mode:"sql", sql, snapshotQuery, label }` (snapshotQuery is required and must match >0 rows) |
  | Read block bytes | `get_block_content { block_id }` — snake_case; `blockId` fails |
  | Surgical block edit | `edit_block_content { block_id, operation:"replace", old_string, new_string, expected_count }`; `operation:"full_replace"` also needs `declared_sha256`; the execute call needs `base_sha256` + `confirmation_token` |
  | Bust a cache | `flush_cache { target, id }` (see the cache table below) |

- **Never retype a sha256.** Carry the hash from `get_block_content`'s response into the next
  call programmatically. A hand-copied hash with two digits transposed (`944a37d` vs `944a73d`)
  was misread as a content race on 8/7/26.
- `mode:"sql"` INSERTs: **`verifyByGuid` must be the literal Guid you inlined in the SQL —
  never `NEWID()`**. If a verify step fails, the INSERT may still have committed: check with
  `execute_sql` before retrying (a blind retry duplicates the row / hits a duplicate-key
  error). The tool now pre-validates this, but scripts must follow the same rule.
- **Don't guess columns — call `get_schema("TableName")`** (crib at
  `mcp/reference/rock-schema-crib.md`). `AttributeValue` is SQL-only (not a
  REST entity): join `EntityId = Person.Id AND AttributeId = <id>`.
- Raw-SQL traps: bracket reserved-word columns everywhere (`[Order]`, `[Group]`), not just in
  ORDER BY. `AttributeQualifier` has **no `ModifiedDateTime` column** (an UPDATE that sets it
  fails). To search stored content for `{%`/`{{`, build the pattern via `CHAR()` concatenation
  (`CHAR(123)+CHAR(37)`) — literal Lava delimiters are rejected by the validator.
- Build via MCP, then verify the resulting page and access in the browser. Use the configured sandbox; if none exists, identify production explicitly before writes.

## ⚑ The cache-flush rule (the single most-relearned gotcha — what you wrote decides what you
flush; see the decision table below)
1. **HtmlContent** (block content/Lava): a raw REST/SQL write updates the row but does NOT
   fire Rock's cache invalidation, so the app keeps serving the old render. Fix: **PATCH the
   HtmlContent row's `ApprovedDateTime` = now** — that runs the model-save pipeline and
   broadcasts `FlushCachedContent` to all front-ends. (`reference/rock-field-notes.md`
   `updateBlockContent()` does exactly this.) Since v18, Cache Manager "Clear Cache" reaches
   every web server, and a clear-all is headless: `~/rock-build-kit/tools/rock-ui/rock-ui.mjs [--prod] cache clear` — no
   browser trip, use only within the authorized scope.
   **`ApprovedDateTime` is stored/compared in UTC and picks the active version:** Rock serves the
   HtmlContent row with the LATEST ApprovedDateTime — stamping local Central time made a *newer*
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

## Recipe — Workflow (WorkflowType → ActivityType → ActionType)
- Build `WorkflowType` + workflow attributes + each `WorkflowActivityType` via normal REST —
  no hang.
- **`WorkflowActionType` REST POST hangs.** Insert the row via `mode:"sql"`, read its `Id`
  back by `Guid`, then configure the action's `AttributeValue`s via normal REST. After a batch
  of SQL-inserted actions, **flush the workflow cache**: PATCH the `WorkflowType`'s
  `ModifiedDateTime` (or pass `cacheFlushWorkflowTypeId` to `rock_create`).
- Engine quirks (both cost real debugging): **`Active=False` on an action is NOT honored** —
  delete the action, don't disable it. If a hard delete is FK-blocked by live instances, **neuter
  it instead**: delete its config AttributeValues and set its run-criteria to a never-true value
  ("completes if unmet" → silently skips); hard-delete once the old instances purge. **Adding one
  action to an existing activity may not instantiate** on new instances (the type cache snapshots
  the activity) — delete + recreate the whole activity in one pass.
- **Criteria-skipped actions still "succeed":** an action whose run-criteria isn't met counts as
  success for `IsActivityCompletedOnSuccess` — a skipped gated route with `ActivityComplete=1`
  closed its activity before later routes ran, so the workflow "completed" without ever hitting
  the final steps. For branching/routing actions set `ActivityComplete=0` and add an explicit
  CompleteActivity action instead.
- **Routing-plan strings:** Rock's `Split` filter REMOVES empty entries, so never emit an empty
  token in a Split-parsed plan string — use a fixed token count with `-` sentinels and map
  `-`→blank on read (an empty token silently shifts every downstream column; see the Lava traps
  section).
- **Processing model:** completed-form workflows advance via the ~30-min Process Workflows job.
  Instant "kick": `{% workflowactivate workflowid:'X' activitytype:'<no-op activity guid>' %}`
  processes that one workflow synchronously (requires `WorkflowActivate` appended to Global
  Attribute `DefaultEnabledLavaCommands` + cache flush). Gotchas: a just-signed workflow still has
  `IsProcessing=1` so the kick silently skips — a `?WorkflowId=` page load reprocesses instead;
  and ANY `?WorkflowId=` page view PROCESSES the workflow (a crafted activity-less probe
  auto-completes on first view — useful for probing, dangerous in testing).
- **⚑ A stuck workflow? Check `Workflow.IsProcessing` FIRST, before credentials, rights, or
  Lava commands.** Rock silently refuses to process a workflow whose `IsProcessing = 1`, and the
  flag can stay stuck indefinitely: no ExceptionLog row, the `{% workflowactivate %}` kick
  returns an empty `kicked=`, and the 30-min Process Workflows job skips the row while reporting
  `Success`. Inspect processing state before attempting recovery; avoid clearing a lock held by a running process.
- **Don't assume the 30-min job is a real fallback.** On the check-request flow every single
  completion came from the external Nudge kick — the Rock job has never advanced one. If a kick
  is your advance mechanism, it is a single point of failure; treat it as one. (Full writeup:
  `mcp/reference/rock-runtime-gotchas.md` §3.)
- RunSQL action config = `AttributeValue`s `SQLQuery` (attr **<discover ID>**) + `Active` (**<discover ID>**)=True,
  `EntityId` = the action's own Id.
- WorkflowEntry block (BlockType **<discover ID>**) shows a Cloudflare Turnstile captcha unless block
  attr `DisableCaptchaSupport` (**<discover ID>**) = True — disable for internal authenticated forms.
  For anything with an ElectronicSignature step, use the **Obsidian** WorkflowEntry block
  (BlockType **<discover ID>**) instead — see the e-signature recipe below.
- **Outbound HTTP from a workflow:** the native `WebRequest` action (EntityType **<discover ID>**,
  `Rock.Workflow.Action.WebRequest`) does a synchronous call in-engine — config attrs `Method`
  **<discover ID>** (GET/POST/…), `RequestContentType` **<discover ID>** / `ResponseContentType` **<discover ID>**
  (`0`=JSON), plus Url/Parameters and a `ResponseAttribute` that receives the raw body; parse
  it in a later action with Lava `FromJSON`. ⚠️ Rock's WebRequest has a hardcoded **~12s
  timeout** — parallelize anything slow on the far end (see `reference/rock-field-notes.md`).
- **Testing a multi-step workflow:** a raw-SQL-inserted `WorkflowActivity` has **no
  `WorkflowAction` child rows**, so the engine "completes" it as a silent no-op (WorkflowLog
  signature: `Processing…` → `Processing Complete` with zero per-action lines). Launch through
  the engine/UI, then SQL-attach test data (e.g. a BinaryFile guid onto the instance's file
  attribute) and click Continue. Also: **every page load of a WorkflowEntry block persists a
  Workflow instance** — clean strays before a delete-and-rebuild `--reset`, or the
  `WorkflowActionType` deletes FK-conflict.
- **Entry-form layout (Obsidian):** `WorkflowActionFormAttribute.ColumnSize` (12-col grid) is
  honored **only when the field sits inside a `WorkflowActionFormSection`** — sectionless
  fields stack full-width. Create sections via REST (`WorkflowActionFormSections`); section
  Title/Description render as **plain text** (HTML entities leak — use real characters).
  Custom labels: `HideLabel=true` + label markup in `PreHtml` (suppress the leaked `a.help`
  icon with CSS). Form **button captions are plain text too** (`&`, not `&amp;`). Block-level
  `PreHtml`/`CssClass` styles every step of the workflow, including the e-sign screen, and a
  `<script>` in Block PreHtml executes.
- Launching: **the raw `POST api/Workflows` entity create hangs on this instance** (same family
  as the WorkflowActionType hang). The working path is `POST api/Workflows/WorkflowEntry/{typeId}`
  with attribute values as query-string params — which is what `launch_workflow` uses (fixed +
  live-verified 7/5/26). A form-gated intake no longer hangs the tool: it processes up to the
  form, reports Status "Active", and (if the type persists instances) leaves a waiting instance
  in Rock — finish or clean it up in the UI. Use only disposable test records created on your church instance.

## Recipe — Electronic Signature workflow (native e-sign, no plugin)
- Native e-sign = a `SignatureDocumentTemplate` with `ProviderEntityTypeId IS NULL` (Rock's
  in-house engine, not the legacy SignNow/Adobe path). Signed PDFs land in `BinaryFileData`
  (Database storage provider), served via `/GetFile.ashx?guid=`.
- The action: **ElectronicSignature component 914** (`Rock.Workflow.Action.ElectronicSignature`).
  Config attr map: `SignatureDocumentTemplate` **<discover ID>** (template GUID), `AppliesTo`/
  `AssignedTo`/`SignedByPersonAlias` **<discover ID>** (each a workflow Person-attr GUID),
  `SignatureDocument` **<discover ID>** (output slot, Binary File field type **<discover ID>** — feeds a
  SendEmail action's `AttachmentOne` attr **<discover ID>** directly), `SignatureDocumentName` **<discover ID>**.
- **The signing step renders inline ONLY on the Obsidian WorkflowEntry block (608)** — the
  legacy webforms block (264) redirects home and strands the workflow waiting. This was the
  key fix. *(Correction 7/14/26: not universal — the Ice Rink Waiver has run anonymous e-sign
  on legacy 264 since 2025. The 264 failure is specific to multi-activity re-entry flows.
  Either block can carry a single-pass e-signature; 608 has the empty-spouse bug below.)*
- **Anonymous signer's email on the completion panel:** after clicking Sign, the Obsidian
  signature control shows a second panel asking for an email (it prefills only from
  `store.state.currentPerson` — blank for logged-out signers). If the flow already collected
  the email earlier, hook it client-side: stash the email at the earlier step's submit
  (sessionStorage), then on `.signature-entry-complete` appearing, set the EmailBox via native
  setter + `input` event and hide its `.form-group`. Fail-open (field reappears if no stash).
  Implement and test the client-side behavior in your own form; no external example source is required.
- **The receipt email goes to whatever email the signer typed** — and with Person Entry it also
  OVERWRITES the matched person's real profile email (see Person Entry recipe). A typo'd email
  = lost receipt + polluted profile. Tell users on-screen which email to use.

## Recipe — Person Entry: anonymous person matching on public forms

**The matcher** (`PersonService.FindPersons`, historically observed cutoff **35**, verify on your version): FirstName-or-NickName **+15**,
LastName **+15**, primary-or-previous email OR mobile **+15**, DOB month/day **+10** (+**5** if
year too), gender **+3**, suffix **+10**. Consequences:
- **Address is not scored at all** — never require it for matching's sake. Name+email alone = 45.
- **Gender and DOB are also hard FILTERS** — a candidate whose recorded gender/birth-month/day
  contradicts the entered value is EXCLUDED entirely (wrong DOB on the form = guaranteed
  no-match = duplicate Pending person). Gender's +3 never decides anything; leave it hidden.
- **AccountProtectionProfile trumps everything:** people whose profile is in
  `SecuritySettings.AccountProtectionProfilesForDuplicateDetectionToIgnore` (this instance:
  `[3]` = Extreme — Rock admins, HR, finance) can **NEVER auto-match from a public form, by
  design** (anti-spoofing). Staff testing with their own record will always "fail to match" —
  test with a low-profile person instead, and always build a LOUD unmatched-notification path.
- On match, Person Entry **UPDATES the matched person's Email/Mobile/Gender/BirthDate from the
  form values** (typos flow onto real records; `History` table has the old value for restore).
- On no-match it **creates a Pending Person + family group** (RecordStatus from
  `PersonEntryRecordStatusValueId`, connection from `PersonEntryConnectionStatusValueId` —
  filter test-junk sweeps on that connection status). `PersonEntryGroupLocationTypeValueId`
  must be set (19=Home) even when address is hidden or the create path null-refs.

**⚑ The Obsidian (608) empty-spouse bug — Rock v17.6.1:** the Obsidian client sends
`"spouse": {}` inside `personEntryValues` even when spouse entry is Hidden. Server-side,
`WorkflowPersonEntryProcessor` sees a non-null spouse bag and processes it:
- matched person HAS a spouse → **NullReferenceException** (~line 199; submit 500s, signer stuck);
- matched/created person has NO spouse → Rock **creates a nameless Person row** in the family
  (junk on every single anonymous submission — this is where mystery nameless Persons come from).
Legacy 264 doesn't send the bag (why Ice Rink never hit it). Fix: client-side XHR/fetch hook on
`/GetNextInteractiveAction` that rewrites an identity-less spouse bag to `null` (fail-open) —
implement in your local frontend. **Re-check after the Sept-2026 v18
upgrade** — if the v18 client stops sending the bag, the patch no-ops and can be removed.

**Cleanup order for Person-Entry junk** (FK-forced, all learned live): Interaction (email-open
tracking rows appear MINUTES after the emails — re-sweep) → CommunicationRecipient (may include
a still-Pending queued send — deleting it stops the email) → PhoneNumber → PersonSearchKey →
GroupMember → PersonAlias → Person → Group (family + Known Relationship, verify no real members).
- Dual-signature on ONE PDF: capture signer 1's signed-date to an attr; render their
  "signed by …" line in the template Lava conditionally (`{% if RequesterSignedDate != '' %}`)
  — Rock appends only the CURRENT signer's block, so each signer's PDF composes correctly.
- Preview templates locally, byte-faithfully: Rock v17.6.1 renders signature PDFs with
  **headless Chromium** (`HeadlessChrome` in the PDF Producer), so a local
  `chrome --headless=new --screenshot` of the template HTML shows exactly what Rock will emit
  (data URIs + modern CSS all work).

## Recipe — Obsidian WorkflowEntry form UI (custom UX in Block PreHtml)

**⚑ v18 form regressions (LIVE since 7/28/26 — confirmed against Rock source, all 18.x ≤ 18.4.1):**
- **Sectioned forms silently DROP per-field PreHtml/PostHtml.** Any field with an
  `ActionFormSectionId` loses its PreHtml (custom labels, help text, JS mount divs/anchors) —
  flat forms still render it (v18.1's #6446 fix covered only the section-less branch). Filed
  upstream as SparkDevNetwork/Rock#6944. **New builds: put question text in the NATIVE field
  label + description bubble (section-level pattern), never in field PreHtml.** Existing forms: the
  block still ships every field's `preHtml`/`postHtml` in its config JSON, so a client-side
  restore shim works — see `V18_FIELDCHROME_JS` in the local implementation of this pattern (fetch the
  page, parse config fields, pair to LEAF `.row > col-md-*` containers in order, verify each
  pair's columnSize, abort untouched on any mismatch, bounded retries because SPA step
  transitions race the fetch).
- **Post-sign message is HARDCODED** ("Your signature has been submitted successfully.",
  `ElectronicSignature.cs:231`) and always beats `NoActionMessage` in the SPA state; a fresh GET
  renders NoActionMessage fine → the reload-once shim below is now REQUIRED, not optional.
- **v18 theme pins `.input-group-addon` height (~16px)** → date-picker calendar buttons shrink
  to detached chips; and inter-field vertical rhythm is gone (labels hug the previous field).
  Fix CSS: addon `align-self:stretch; height:auto !important`; input `flex:1 1 auto; width:auto;
  min-width:0` (without min-width:0 the input overflows its column under the neighbor field);
  restore spacing with margin-bottom on the field containers.
- **Deploy-script escaping trap (cost a failed prod deploy):** JS regexes inside template-literal
  exports lose one backslash layer per nesting (`\\d+` → `d+`, `\\u0022` similarly). ALWAYS
  functionally test the MATERIALIZED export — node harness on a wire-format sample + live eval
  in the page — never just the hand-typed version.
- **Cleanup on a LIVE form:** never run type-wide cleanup scripts (they sweep real staff
  instances); write a targeted script keyed to explicit workflow IDs with an initiator
  safety-check — model: the local implementation of this pattern.
- **Completion screen:** the Obsidian block **HTML-escapes `WorkflowType.NoActionMessage`** — your
  completion `<div>` arrives as literal text in an `.alert-warning`. Ship PreHtml JS that regexes
  the payload (e.g. a BinaryFile GUID) out of the escaped TEXT and promotes it to real HTML;
  `| Escape` any user-supplied names in the message so the un-escape is injection-safe. Trap: the
  config transport encodes double-quotes as `&#0022;`, so a GUID regex with a `[^0-9a-fA-F]` gap
  can't cross them — use a lazy `.{0,16}?` gap anchored on the full 8-4-4-4-12 GUID shape.
- **Post-sign dead end:** after signing, Rock shows a generic "signature submitted" panel and never
  re-renders — do ONE `location.reload()` (sessionStorage-guarded per WorkflowId, else it loops) so
  the completed workflow renders the NoActionMessage.
- **DOM placement:** FormAttribute PreHtml renders as a **sibling** of `.form-group` inside the
  `.col-md-12` wrapper (`closest('.form-group')` fails — search the column wrapper); some labels
  live in `.form-section-fields`. A **read-only field renders as a static control**
  (`.form-group.static-control … .form-control-static`, no `<input>`) — read `textContent`, not `.value`.
- **Re-render survival:** never use a DOM-writing MutationObserver (infinite loop with Vue → frozen
  renderer) — use a ~300 ms interval tick with a state-key guard to re-mount/re-wire, and keep row
  state in JS (never re-parse it from a hidden field after first load). Never inject DOM into
  Vue-owned grid rows — use CSS pseudo-content for chips/badges. Styling hides must be
  **stylesheet** rules (e.g. `:has()` to hide the mandatory prefilled e-sign email box) — Vue
  re-renders wipe inline-style/class hides.
- **Never fight Ant `<a-select>`.** For a searchable dropdown, convert the column to plain Text and
  build your own combobox appended to `<body>` (z-index above Rock's fixed header), viewport-rect
  positioned under the native input, re-pinned every ~150 ms + on scroll/resize — typing already
  sets the Vue model, so the field degrades to plain text if the overlay breaks. Debugging Ant's
  own dropdown: the `rc-align` failure mode "parks" it ~9,999 px off-screen while its class still
  says open — check `getBoundingClientRect()`, not classes. v17.6.1 bug: single-select DefinedValue
  fields never forward enhanced search to the control (`enhancedselection` qualifier is ignored) —
  config alone can't fix it on this version.
- **Card look without reparenting:** set the Block `CssClass` and restyle `.panel.panel-block`
  itself (don't build a card inside the panel) — the native submit button then inherits the look
  and the Vue form model + any guard disable-logic stay untouched.
- **Synthetic input** into Obsidian Vue fields needs `.value` + BOTH `input` and `change` events,
  and custom-wired fields may only bind after a real `focusin`.
- **Rock core's per-control no-HTML validator rejects `<` and `>` in Text workflow attributes —
  including fields you have hidden with CSS.** The submit fails with a validation summary naming
  a control the user cannot see ("Vendor Name contains invalid characters… angle brackets"),
  which is indistinguishable from a broken form. Anything writing into a form attribute
  server-side (a RunLava derive step, an AI extractor, an import) must strip `[<>]` at the
  source *and* the client must scrub the input immediately before submit.
- **A failing `{% sql %}` inside a RunLava action writes Rock's HTML error fragment into the
  output attribute** rather than erroring — so the failure arrives later, as poisoned field
  content, in a different part of the form. (Both: `purchase-order-rock/dd0bb084` 8/14/26.
  Full writeup: `mcp/reference/rock-runtime-gotchas.md` §5.)

## Recipe — AttributeMatrix (line-item grids on forms)
- **Lava can't create matrix rows in-engine.** Build rows server-side via `{% sql %}` command
  mode (or a build script): insert `AttributeMatrix` + `AttributeMatrixItem` rows
  (item attrs live on EntityTypeId **<discover ID>**, qualifier `AttributeMatrixTemplateId`), then hand
  the matrix **GUID** back to the workflow attribute.
- **A matrix column's `IsRequired` is enforced only in Rock's manual row-editor, NOT on form
  submit** — any row created outside the editor (SQL, AI pre-fill) sails through with blanks.
  Enforce with a client-side JS guard injected via Block PreHtml.

## Recipe — File uploads (single and multi)
- A File (**<discover ID>**) / Binary File (**<discover ID>**) attribute needs a `binaryFileType` qualifier (the
  BinaryFileType GUID) or the Obsidian block errors serializing it.
- A `BinaryFileType` created via REST with `CacheControlHeaderSettings = NULL` **crashes the
  Obsidian form** ("Value cannot be null" deserializing). Always set it:
  `{"RockCacheablityType":3,"MaxAge":null,"MaxSharedAge":null}`.
- Rock's stock Obsidian FileUploader is **single-file by design** — don't fight it. Its
  handler is replayable: `POST /FileUploader.ashx?isBinaryFile=True&fileTypeGuid=<g>&isTemporary=True`
  (cookie-auth, `credentials:'include'`) returns `{Id,Guid,FileName}` — a custom drag-drop
  multi-uploader in Block PreHtml reuses it, stores a guid CSV in a Memo attribute, and
  dispatches `input`/`change` events so the Obsidian Vue model persists it. (Injected JS:
  pure `createElement`, no innerHTML with filenames, no inner backticks/`${}`.)
- **Binary in/out over the API key transports as HEX, never base64**:
  `SELECT CONVERT(varchar(max), Content, 2)` to read, `CONVERT(varbinary(max),'<hex>',2)` to
  write — base64-over-Lava corrupts through the `{% sql %}` render path. `GetFile.ashx` /
  `FileUploader.ashx` need a session **cookie**, not the API key; SQL-hex is the headless route.

## Recipe — Metric (manual or SQL-source)
- Metric **Category** `EntityTypeId` = **<discover ID>** (discover the Metric entity separately). Manual
  `SourceValueTypeId` = **<discover ID>**; SQL-source = **<discover ID>**.
- A metric created via REST needs an **explicit default `MetricPartition`** or it can't accept
  values.
- SQL-source `SourceSql` must return columns `YValue, MetricValueDateTime, <partition EntityIds
  in partition Order>` (clone metric **<discover ID>** "Kids Worship" for the shape). The "Calculate
  Metrics" job (ServiceJob **<discover ID>**) runs every 15 min. When backfilling a converted metric,
  **exclude the current in-progress week** so the calc job owns it (else a duplicate at the seam).
- **`metricdisplaypanel` (shortcode 20) INNER-JOINs the Campus partition** (EntityTypeId 67)
  and filters `EntityId = {CampusId page param}` → a metric with no Campus partition renders
  **0** on a campus tab (shows only on "All Campuses"). Give it a Campus partition to appear on
  campus tabs.
- HTML blocks that run `{% sql %}` need `EnabledLavaCommands="Sql"` (block attr **<discover ID>**).

## Recipe — Badge
- A badge = a BadgeId + a Liquid/Lava component. Secure it via `Auth` on `EntityType` **<discover ID>**
  (Badge): **Allow** the specific role, then **Deny `SpecialRole=1`** (all users) — the same
  allow-then-deny idiom used everywhere.
- Badge **Order** is set by a drag-reorder in the UI (a jQuery quirk — REST `Order` alone may
  not stick). Edit a badge's Display Text in the **Ace** editor (not CodeMirror).

## Recipe — Scope a shared Report to one page (clone pattern)
- To change a report for one page without touching the shared original, **clone the report**
  and point the page's block at the clone.
- `ReportField` order is the **`ColumnOrder`** column (NOT `Order`). Block-setting
  (AttributeValue) edits need a **Cache Manager Clear Cache** to show (rule #2 above).

## Recipe — Page + Block + HtmlContent + admin-lock Auth
- Page / Block / PageRoute / Auth POST via REST works fine (no hang).
- HtmlContent: POST a **full new version**, then PATCH `ApprovedDateTime` to flush (rule #1).
  Pushing a full version bypasses the WYSIWYG sanitizer, which can strip inline `<style>`/`<svg>`.
- **REST-created PageRoutes don't register** until the route string is re-added via the admin
  page editor (a Save on the Edit Page dialog is enough; an app-pool recycle also works — a cache
  clear is NOT enough). **REST-created LavaShortcodes have the same disease**: they don't register
  with the Lava engine until you open them in Admin → CMS → Lava Shortcodes and click **Save**
  (clearing LavaShortcodeCache/WebsiteLavaTemplateCache does nothing).
- **Menu-link redirects: never use Rock's native Redirect block (BlockType <discover ID>)** — it exempts
  admins by design (shows the target instead of redirecting), which reads as "broken" during
  verification. Use an HtmlContent block with `window.location.replace('/…')`.
- Auth ordering for a protected page: **Allow** role(s) first (Order 0/1), **Deny All Users**
  (`SpecialRole=1`) last. Add people to a **security-role group** via `add_group_member`
  (uses `PersonId`, NOT `PersonAliasId`), not direct per-person page Auth.
- **Nested-`<form>` bug:** Rock wraps the whole page in one ASP.NET `<form runat="server">`, so
  a `<button>` with no `type` defaults to `type="submit"` and reloads the page on click — set
  `type="button"` on every button. Reproduce locally by wrapping your block in a fake outer
  `<form>` before shipping.

## Recipe — Compute-heavy Lava dashboards (`{% cache %}` compute-once)
- Set block attr **<discover ID>** `EnabledLavaCommands = "Sql,Cache"` and wrap the whole body in
  `{% cache key:'name-{campus}-{date}{refreshSuffix}' %}` with a context-appropriate TTL. A
  `?refresh=1` param that appends a suffix to the key gives that viewer a private fresh compute
  without touching the shared entry. Per-viewer UI (an admin Refresh button) goes **outside** the
  cache tag.
- The HTML Content block's output cache **keys by query string** — while a block is broken, each
  distinct query-string variant caches its own error copy.
- **Never write a bare block tag (e.g. `{% cache %}`) inside `{%- comment -%}`** — Rock parses it
  as a real, unclosed tag → live "Index was outside the bounds of the array" / "Unclosed tag".
  Reword to "the cache tag".
- `/api/Lava/RenderTemplate` **mangles multi-line `{% sql %}` bodies** ("Incorrect syntax near
  '\\'" on clean SQL) — a harness artifact; verify SQL-heavy templates on the live block.
- SQL schedule-parsing traps: `TRY_CONVERT(time,'')` returns **midnight, not NULL** (wrap with
  `NULLIF(col,'')`); iCal midnight DTSTARTs are data-entry artifacts; biweekly A/B parity =
  `DATEDIFF(WEEK, DTSTART, @D0) % 2`.

## Recipe — External APIs from a block (server-side, key never in the browser)
- `{% execute %}` (C# HttpClient) makes the API call **server-side**, with the API key read from an
  **encrypted Global Attribute** — it never reaches the browser. Needs `EnabledLavaCommands=Execute`
  on the block. Pair a short server-side block cache (~2 min) with a client auto-refresh to respect
  rate limits.
- Cross-source alternative (e.g. Planning Center data that isn't in Rock's DB): fetch client-side
  from a small companion route on an app you control (token substituted at deploy, key stays
  server-side there) and merge into the rendered page in JS — stays live past the Lava cache, no
  new Rock integration.

## Data hygiene & security
- **Retention ≠ deletion:** `CompletedWorkflowRetentionPeriod` does NOT remove `SignatureDocument`
  rows or their `BinaryFile` bytes — a purge/archive script is the authoritative cleaner. FK-safe
  delete order per workflow: SignatureDocuments (`EntityTypeId=<discover Workflow EntityType ID> AND EntityId=<wf>` — approver
  flows have TWO) → BinaryFiles (file-attr guids + sigdoc binaries, deduped) → AttributeValue rows
  → the Workflow row. **AttributeValue deletes must always be scoped `AttributeId + EntityId`** —
  `EntityId` is NOT unique across entity types.
- **`GetFile.ashx?guid=` serves files with NO authentication** when the BinaryFileType has
  `RequiresViewSecurity=false` — the unguessable GUID is the only secret. For sensitive files set
  it true + grant View (note: flipping it breaks already-emailed links).
- **Verify a GroupId is actually a security role before granting** — group ids are easy to
  transpose and a family group nearly got used as "staff" in a real build. Cross-check the name
  (`SELECT Name FROM [Group] WHERE Id=…`) against a known-good page's Auth rows.
- **Every WorkflowEntry page view persists a workflow instance** (IsPersisted types) — stray
  Actives are inherent, not a bug; sweep them in the purge job.
- **Ship gate:** before any e-sign/form build goes live, run an adversarial second-model review
  (e.g. `/codex:review`) — on the check-request build it caught 6 real security bugs (unescaped
  AI-output XSS, SQL injection via a client-writable Memo, fail-open secret checks, an Enter-key
  guard bypass). Never trust client-side validation alone: re-validate server-side (RunLava →
  error attr → reactivate-form loop).

## Lava traps that bite builds
Full reference: `reference/rock-lava-reference.md`. The ones that cause silent-wrong-output (not
errors):
- `{% sql %}` results need `{% for row in results %}` — `results | first` + dot-access returns
  blank on this instance.
- Math filters must be **PascalCase** (`Times` / `DividedBy` / `Format` / `Plus`) — lowercase
  `times`/`divided_by` are no-ops and render the raw numerator.
- `Split` **drops empty fields** and silently shifts every downstream column. The full rule
  (learned twice): never emit an empty token in any Split-parsed string — use a fixed token count
  with `-` sentinels and map `-`→blank on read; at minimum put the only nullable field last.
  (Second occurrence nearly cross-wired approval-routing person slots on a live finance form.)
- `{% sql %}` **parameter binding to a `uniqueidentifier` column fails on blank input** ("conversion
  error") — wrap every GUID param in `TRY_CONVERT(uniqueidentifier, @p)`.
- A `LavaShortcodes` REST create **silently drops the `Parameters` field** — re-SELECT and PATCH
  it after creating. (Separately, a REST-created shortcode won't register with the engine at all
  until an admin opens it and clicks Save — see the Page recipe.)
- `{% sql %}` supports **parameter binding** (`{% sql name:'{{ v }}' %} … WHERE x = @name {% endsql %}`,
  v9+) and a `timeout:` param (v12+) — use parameters instead of interpolating Lava into SQL.
  This is **mandatory, not stylistic, for external/AI-extracted text** (receipt fields, form
  input) — single-quote doubling alone leaves a real injection surface in hand-rolled clients.
- `{{ Workflow.InitiatorPersonAlias.Guid }}` renders **blank** in a workflow-action Lava
  context (lazy nav not loaded). Use
  `{% if CurrentPerson %}{{ CurrentPerson.PrimaryAlias.Guid }}{% else %}{{ Workflow.InitiatorPersonAlias.Guid }}{% endif %}`.
- `| Attribute:'X','Object'` returns **null for Binary File field types** (works for Person).
  A `{% if bf and bf.Id %}` guard then silently skips your whole block. Use
  `| Attribute:'X','RawValue'` (the GUID) and resolve the entity inside parameterized SQL
  (`WHERE bf.[Guid] = TRY_CONVERT(uniqueidentifier, @g)`). Cost us the handbook Document-row
  insert on 7/14/26 — zero errors, zero rows, "Success:True".
- **RunLava logs `Success:True` no matter what happened inside** — a throwing `{% sql %}`, a
  false guard, a no-op: all "succeed" (with no target attribute the output is discarded, error
  text and all). NEVER trust workflow-action success for SQL side effects — SELECT for the row.
- An INSERT/UPDATE inside plain `{% sql %}` (query mode) does not work — `statement:'command'`
  is required (query mode can also throw "Cannot find table 0" AFTER committing, so a retry
  double-inserts — verify database effects separately).

## Byte-fidelity on large Lava / HtmlContent
A full-value REST replace of a big template risks losing invisible bytes — the `CampusId=All`
shortcode fix lost **61 bytes** of trailing whitespace on a re-transcribed replace, which
forced a browser Ace-editor edit. For a **targeted** change to a large field, either edit in
the live Ace editor (browser) or do an exact-bytes `mode:"sql"` `UPDATE` (e.g. `REPLACE(...)`),
not a hand-reconstructed full body. The proven push discipline: ASCII-escape (`ensure_ascii`) +
compute a SHA-256 over the exact pushed content and verify before/after. (When editing the Ace
editor via browser JS: the text insert and the Save click must be **separate** JS calls, or the
form model saves stale.)

## Render Lava BEFORE you ship it (`/api/Lava/RenderTemplate`)
You do not have to write a template into Rock to find out what it produces. POST it to
`/api/Lava/RenderTemplate` with the API key and you get the real rendered HTML back, executed by
Rock's own engine against live data — `{% sql %}` included. Use it to prove an email body, a
dashboard block, or a risky query before any write, and to diff an old version against a new one
(render both, `diff` the output — that is how the weekly-giving Second Campus variant proved it changed
nothing in the all-campus email).

**The one trap: `Content-Type: text/plain` with the RAW template as the body.** Posting
`JSON.stringify(template)` makes Rock read the JSON escaping literally — every `"` arrives as `\"`
and the sql block dies with `Incorrect syntax near '\'`, which reads like a SQL bug and isn't.
The response is a JSON-encoded string; parse it, then write the HTML to a file and screenshot it.
Working script: `tools/render-lava.mjs` (kit root; default dev, `--prod` for prod).

Corollary for template AttributeValues (email bodies, RunLava action `Value`): a REST **PATCH of
the whole value with readback verification** (`tools/push-attrvalue.mjs`) is simpler and safer than
CHAR()-encoded SQL surgery. `execute_sql` refuses literal Lava delimiters and `rock_edit mode:"sql"`
allows one statement, which pushes people toward `REPLACE()` gymnastics — skip it, push exact bytes
and verify the sha.

## After building — verify in Chrome
API/SQL checks can't see client-side behavior. Load the live page in Claude-in-Chrome and check
for: the nested-form submit-reload, z-index (Rock's own fixed header/search bar paints above
block overlays — mount overlays in a body-level layer), and email rendering (Gmail collapses
byte-identical footers behind "•••", hiding button rows; `SendEmail` actions don't write to the
`Communication` table, so verify sent content in Gmail, not SQL). Obsidian selects render as
Ant Design `<a-select>` (NOT jQuery Chosen) — browser-automation "type" won't drive them; set
the input value and dispatch an `input` event via JS. Chrome-MCP `file_upload` can't feed
arbitrary local files into Rock forms — for file-upload workflows use the DB-attach test
pattern in the workflow recipe above.

## The v18 upgrade LANDED 7/28/26 (overnight, ahead of the Sept plan)
MCP side: a NON-EVENT, exactly as the 7/19 audit predicted — auth, REST, and all tools kept
working on prod v18. The real cost was the FORM regressions (see the ⚑ v18 block in the
Obsidian WorkflowEntry recipe): sectioned-form PreHtml dropped, post-sign message hardcoded,
input-group addon/spacing CSS changes. Historical notes from the pre-upgrade audit follow.
The
earlier claim that "v18's v2 REST rejects `Authorization-Token`" was **wrong** — v18 auth
is identical to v17; the 401s were missing `ExecuteUnrestrictedRead/Write` Auth rows
(deny-by-default, exact-match, no RSR bypass — and Rock 401s for *unauthorized* too, which
is what fooled the 7/5 diagnosis). Prod's 6/15 bulk grant survives the in-place upgrade,
so nothing breaks; upgrade-day runbook (idempotent grant SQL for new controllers → cache
clear → driver rerun) lives in `reference/rock-rest-api-security.md`.
v18.2 confirms fixed: workflow-launch #6604, v2-JSON-body writes. v18.2 quirks to remember:
v2 `metricvalues/search` 500s (get_metrics auto-falls back to SQL); `People` v1 DELETE is
405; v1 DELETE on Groups/Tags/WorkflowTypes soft-deletes (`IsActive=0`). Native-AIAgents
angle still worth a spike. Re-check this skill after the upgrade.
See `reference/rock-field-notes.md` and memory `rockdev-v18-v2-auth`.
