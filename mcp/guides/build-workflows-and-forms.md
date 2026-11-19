# Workflows, e-sign, person entry and form recipes

## Contents
- Recipe — Workflow (WorkflowType → ActivityType → ActionType)
- Recipe — Electronic Signature workflow (native e-sign, no plugin)
- Recipe — Person Entry: anonymous person matching on public forms
- Recipe — Obsidian WorkflowEntry form UI (custom UX in Block PreHtml)
- Recipe — AttributeMatrix (line-item grids on forms)
- Recipe — File uploads (single and multi)

## Recipe — Workflow (WorkflowType → ActivityType → ActionType)
- Build `WorkflowType` + workflow attributes + each `WorkflowActivityType` via normal REST —
  no hang.
- **`WorkflowActionType` REST POST hangs.** Insert the row via `mode:"sql"`, read its `Id`
  back by `Guid`, then configure the action's `AttributeValue`s via normal REST. After a batch
  of SQL-inserted actions, **flush the workflow cache**: PATCH the `WorkflowType`'s
  `ModifiedDateTime` (or pass `cacheFlushWorkflowTypeId` to `rock_create`).
- The hang is a confirmed platform bug (issue #6954): full-entity POST/PUT on WorkflowActionType
  hangs, fixed only in v20.0; PATCH works. The SQL-insert path above is still correct on 19.8.1.
- **Action `Active` and `Order` attributes are vestigial** — the action component overrides them;
  the real position is `WorkflowActionType.Order`, and writing the attribute silently creates a
  junk AttributeValue (why `Active=False` below is ignored). `CriteriaAttributeGuid` is a Guid
  column: a wrong value never errors, it just never matches.
- A SQL action that reads the previous form's attributes needs a **Persist Workflow** action
  before it. A WorkflowLauncher failure can follow side effects that already succeeded — check
  the action log before retrying. Keep `{% workflowactivate %}` on one line (multi-line
  parameters throw a blank-key error).
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
  timeout** — parallelize anything slow on the far end (see the kit root's `reference/rock-field-notes.md`).
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

