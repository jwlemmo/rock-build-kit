> Portability: observed behavior, not a version guarantee. Discover all IDs locally; examples are not production configuration.

# Rock runtime gotchas (bite ANY client, not just this MCP)

Source: generalized technical observations; verify against this church and Rock version.
(`reference/rock-field-notes.md`, §2 "Lessons learned since 7/28",
proposal P3). These are behaviors of **Rock itself** — its caches, its workflow engine, its
validators, its REST layer — that a `skill` written for one client (the `rock-v2` MCP) can't
own, because six of the eight items below were first hit by code paths that will never read a
Claude skill: a Node build script (the local implementation of this pattern), a Vercel email-QA worker, and a browser
front-end (the local implementation of this pattern). If you're writing *any* code that talks to Rock — MCP tool, build script,
Lava block, external worker — read this first.

For build **recipes** (how to construct a page/block/workflow/metric/badge in Rock), see
`skills/rock-build/SKILL.md` (kit root). This doc is the other half: what Rock does underneath,
regardless of which client is driving it.

---

## 1. Four independent cache scopes

Rock does not have one cache to flush — it has (at least) four, and busting one does nothing
for the others. Conflating them is the single most time-costly mistake across the sessions
mined for this doc.

### 1.1 HtmlContent / Lava body cache
A raw write to an `HtmlContent` row's `Content` does not by itself invalidate what Rock is
serving.
- **Bust it:** stamp `ApprovedDateTime = utcnow()` on the row (a plain content UPDATE does not
  trigger this), or call `flush_cache { target:"htmlcontent", id:<HtmlContentId> }` /
  `flush_cache { target:"block", id:<BlockId> }` (the latter re-approves the `HtmlContent` rows
  `WHERE BlockId = <id>`).

### 1.2 Block settings / AttributeValue / Auth cache
Block-level settings (`AttributeValue` rows keyed to a Block), and `Auth` rows, written via SQL
or REST need a manual **Cache Manager → Clear Cache** (page **<discover ID>**). No REST/MCP call busts
this cache — `flush_cache` does not touch it.

### 1.3 A page's block-list cache — a SEPARATE scope from 1.2, easily mistaken for it
Rock caches *which blocks exist on a page* independently of any individual block's content or
settings. A block created via REST or `create_page_bundle` can be a perfectly valid row and
still not render — which reads exactly like an Auth failure, because the symptom (block
missing) is identical.
- **Symptom:** a newly created block simply does not appear on the page. No error. Looks like
  the security/Auth write failed.
- **Cause:** the page's cached block list was built before the new block existed, and nothing
  in the write path invalidates it.
- **Fix:** Cache Manager (page **<discover ID>**) → Clear Cache. `flush_cache target:"block"` does **not**
  help here — verified in source, `rock-mcp-server-v2/src/tools/cache.ts`: `target:"block"` only
  re-approves `HtmlContent` rows `WHERE BlockId = <id>`; it has no code path that touches a
  page's block list.
- **Evidence:** `Claude-Codex-Projects/f90590ca` 2026-08-03 — *"The block didn't appear after
  deploying, and it wasn't the Auth — Rock caches the page's block list, so a newly created
  block is simply absent until Cache Manager (page 533) → Clear Cache. The `flush_cache` MCP
  call only handles HtmlContent."* Recurred 4 days later, same mistake, different session:
  `Claude-Codex-Projects/3bb7c3df` 2026-08-07 — *"it was a caching issue on my end: I created the
  banner block but Rock had already cached that page's block list, and I never re-verified after."*
- **Corollary — don't trust "a Block PATCH self-flushes" for this case.** A REST PATCH to an
  *existing* block's PreHtml/CssClass does self-flush that block's own cache — but that fact is
  about scope 1.2/1.1 on a block that's already visible. It says nothing about scope 1.3. A
  newly-created block being invisible is **not** evidence the create/Auth write failed; check
  the page's block list (Cache Manager 533) before you start debugging Auth.

### 1.4 WorkflowType / action-config cache
Workflow action rows and their config `AttributeValue`s are cached at the `WorkflowType` level.
- **Bust it:** `flush_cache { target:"workflowtype", id:<WorkflowTypeId> }` (a `WorkflowType.
  ModifiedDateTime` bump does the same thing). On config that's proven sticky (action-config
  AttributeValues, not just the action row), also do a Cache Manager (533) clear and re-verify
  on a fresh live instance before trusting the fix — flush without re-verification has shipped
  stale behavior before.

---

## 2. `flush_cache` — exact arg shape, and the NaN decoder story

- **Required shape:** `target` ∈ {`htmlcontent`, `block`, `workflowtype`} **and** `id`. Nothing
  else. `{}`, `{scope:"all"}`, `{target:"all"}`, `{cache_type, entity_id}` are all wrong shapes.
- **What a wrong shape actually does:** on some builds, a missing/renamed arg reaches
  `Math.trunc(undefined)`, which is `NaN`, which lands in the query as
  `SELECT Id FROM HtmlContent WHERE BlockId = NaN` → surfaces as
  `Rock SQL/Lava error: Invalid column name 'NaN'`. **That error is your argument shape, not a
  broken server.**
- **This got shipped as wrong fact once.** A session hit the NaN error twice in a row and wrote
  into a delivered runbook: *"`flush_cache` via MCP is broken (`Invalid column name 'NaN'`), so
  config changes won't appear until you clear cache in the UI."* It isn't broken — the calls
  were shaped `{}` and `{scope:"all"}`.
- **Evidence (4 NaN failures):** `ROOT/4536d6c7` 8/6 (`{}`); `ROOT/ab35ec23` 8/7 (`{}` then
  `{scope:"all"}` — the session that wrote the wrong conclusion into a runbook);
  `purchase-order-rock/dd0bb084` 8/14 (`{cache_type,entity_id}`). Also 3 separate zod `-32602`
  rejections of `{target:"all"}` / `{cache_type,entity_id}` shapes: `church-email-signatures` 8/6,
  `purchase-order-rock` 8/11 ×2 — same root cause, cleaner error on those builds.
- **Split-brain warning — long-lived MCP processes serve stale builds.** On 8/7, the *same day*
  and the *same bad call shape*, `rock-v2` returned a clean zod validation error while `rock-dev`
  returned the NaN SQL error. Both aliases launch the identical
  `~/rock-mcp-server-v2/dist/index.js` — but each running process keeps whatever build of
  `dist/` it started with. **A rebuild does not reach an already-running server**; restart the
  process (or the session) after rebuilding, or you're debugging yesterday's code.

---

## 3. `Workflow.IsProcessing` — check this FIRST on any stuck workflow

Before credentials, before rights, before Lava commands: query `Workflow.IsProcessing` on the
stuck instance. Rock silently refuses to process a workflow whose `IsProcessing = 1`, and the
flag can stay stuck **indefinitely** — there is no timeout and no error trail:
- No `ExceptionLog` row is written.
- A `{% workflowactivate %}` kick returns an empty `kicked=` with no explanation.
- The ~30-minute "Process Workflows" job silently skips the row while still reporting `Success`
  for its run.

All three of those symptoms have independent-looking causes (auth, Lava config, job scheduling)
and all three are actually the same one flag.

- **Don't assume the ~30-minute job is a real fallback for advancing a stuck instance.** On the
  check-request flow, every single completion came from an external Nudge kick — the Rock job
  itself has never been observed advancing one of these workflows. Treat a kick-based advance
  mechanism as a single point of failure, not as backed up by the scheduled job.
- **Evidence:** `church-check-request/177f6f17` 2026-08-12, after roughly 4 hours of misdiagnosis —
  *"Root cause was a stale `Workflow.IsProcessing=1`, frozen at 2026-08-11 14:31:42. Rock
  silently refuses to process an in-process workflow, which explains every symptom at once: the
  bare `kicked=` from both credentials, the absent ExceptionLog, and the 30-min job skipping the
  row while reporting `Success`."* This stranded a $5,650 check for 19 hours; two wrong
  hypotheses (a credential split, then "the 30-min job doesn't advance this stage") were chased
  first. The session's own retro: *"The `IsProcessing` gotcha was already in this project's
  memory from the July build — I had it in context and didn't check it."* Same session
  disproved the documented fallback: *"the '30-minute Process Workflows fallback' documented at
  merge.mjs:143 does not exist. Every completed request completed via a Nudge; the Rock job has
  never advanced one of these."*

---

## 4. `CommunicationRecipient` — two independent silent-skip conditions

Both of these make a send look like it worked (or make Rock report "no communications to send")
with no exception anywhere.

- **`MediumEntityTypeId = NULL` on a REST-created recipient row → silently skipped.** The send
  job routes recipients by medium; a NULL medium means the row is invisible to it. Rock's own UI
  sets this field when you build a communication there; the REST API does **not** default it.
  **Fix: set `MediumEntityTypeId = 37` (Email) on every scripted/REST-created recipient row.**
- **A Communication that already has a `SendDateTime` silently ignores appended recipients.**
  Adding stragglers to an already-sent Communication does nothing — no error, no send, no log.
  **Recovery requires a fresh Communication**, not editing the sent one.
- **Evidence:** `legacy-team-2026-08/ef633012` 2026-08-11 (a 686-recipient send that silently
  didn't send) — *"The recipient rows I created via REST had `MediumEntityTypeId` null — the
  send job routes recipients by medium, so it silently skipped them and reported 'no
  communications to send.' Rock's own UI sets that field; the REST API doesn't default it."* And,
  same session: *"appending recipients to an already-sent communication silently does nothing.
  Recovering stragglers needs a fresh communication each time."* — this is why that campaign
  ended up with wave-1 and wave-2 copies.

---

## 5. Per-control no-HTML (angle-bracket) validator — fires even on fields the UI hides

Rock core validates every control's submitted value against a no-HTML rule that rejects `<` and
`>`. This runs **per control**, including a Text workflow attribute that's been CSS-hidden from
the user — the control still exists in the form and still gets validated.
- **Symptom:** submit fails with a validation summary naming a control the user cannot see on
  screen (e.g. *"Vendor Name contains invalid characters… angle brackets like `<` or `>`"*),
  which is indistinguishable from a broken form to whoever's debugging it.
- **Cause found in practice:** an AI extraction step, asked for a value not present in the
  source document (a vendor name not printed on a receipt), returned a bracketed placeholder
  (e.g. `<not found>`), and the calling script wrote that placeholder straight into the hidden
  attribute — no sanitization at either end.
- **Corollary — the same characters can arrive from Lava, not just AI output.** If a `{% sql %}`
  block inside a RunLava action errors, Rock emits an HTML error fragment (angle brackets and
  all) into that action's output — so a failing Lava block can poison a downstream text
  attribute with content that then trips this exact validator, arriving as a confusing
  validation failure far from the actual Lava error.
- **Fix:** anything that writes into a form attribute server-side (a RunLava derive step, an AI
  extractor, an import) must strip `[<>]` at the source, **and** the client should scrub input
  immediately before submit as a second layer — don't rely on only one side.
- **Evidence:** `purchase-order-rock/dd0bb084` 2026-08-14 — workflow attribute **<discover ID>**
  (`VendorName`) on form **<discover ID>**, a field the UI hides; the write path was the local implementation of this pattern. Quote: *"If
  its `{% sql %}` block errors, Rock emits an HTML error fragment — angle brackets — into that
  output."*

---

## 6. `BinaryFileData` pre-creation — a blind INSERT is a PK collision

`POST /api/BinaryFiles` does not leave the content row for you to create afterward. Rock's
database-storage provider creates the `BinaryFileData` row (empty) **as part of saving the
BinaryFile itself** — so by the time the POST returns, the row already exists.
- **Symptom:** a follow-up write of the actual file bytes as an `INSERT` into `BinaryFileData`
  fails on a primary-key violation — or, worse, silently produces a zero-byte file if the error
  isn't being checked correctly (see §7 below — this exact failure mode combined with the HTTP-200
  inline-error trap to reach production).
- **Fix:** always **UPSERT** the content row (update the existing empty row), never blind-INSERT.
- **Evidence:** `church-email-qa/02d92684` 2026-08-11 — *"Rock's database-storage provider creates
  the `BinaryFileData` row (empty) as part of saving the BinaryFile, so by the time `POST
  /api/BinaryFiles` returns, the row already exists."* Three zero-byte orphan BinaryFiles reached
  production before this was caught.

---

## 7. `{% sql %}` errors render inline in an HTTP 200 body

A failed `{% sql %}` block does not produce an HTTP error status. Rock renders the failure as an
HTML/text error fragment **inside** the response body of what is still a 200 OK.
- **Consequence:** any client that checks only the status code — which is the natural thing to
  do — reports success on a request that actually failed server-side (including the PK-collision
  case in §6: a blind INSERT that failed on the primary key still came back as HTTP 200 with the
  error text embedded in the body).
- **Fix:** don't trust status code alone for anything that renders Lava. Detect Rock's inline
  error format in the body (the pre-existing convention in one codebase looked only for the
  literal string `/Lava Error:/`, which is why this got missed for a while — match more broadly),
  and independently verify the actual side effect happened (for a file write: check `FileSize`
  **and** `DATALENGTH(Content)` **and** a stored hash — asserting only one of the three lets a
  silent partial failure pass).
- **Evidence:** `church-email-qa/02d92684` 2026-08-11 — *"Rock renders a failed `{% sql %}` block
  inline in the response body, not as an HTTP error. The old `sqlCommand` only looked for `/Lava
  Error:/`, so the PK violation was silently swallowed and reported as success."*

---

## 8. UI-Save registration requirement — PageRoute, LavaShortcode, and now Attribute Auth

Three different entity types share the same disease: a row written via REST/SQL exists in the
database and is functionally correct, but Rock does not pick it up until a human (or an
automated browser step) opens it in the admin UI and clicks **Save** — because Save is what
actually runs the registration/permission pipeline, not just persists the row. No REST call and
no cache flush substitutes for this.

- **PageRoute:** the row exists in `PageRoute` and `/page/{id}` works, but the friendly route
  404s until CMS → Routes → Page Route Detail → Edit → **Save** (which calls
  `ReregisterRoutes()`), or an app-pool recycle. Cache Manager Clear Cache does **not**
  re-register routes.
- **LavaShortcode:** a REST-created shortcode does not register with the Lava engine until it's
  opened in Admin → CMS → Lava Shortcodes and **Save** is clicked. Clearing
  `LavaShortcodeCache`/`WebsiteLavaTemplateCache` does nothing.
- **Attribute Auth (new in this scan):** a REST-written `Auth` row on an **Attribute** does not
  take effect until you open that attribute's Security dialog in the UI and **Save** it. Same
  class as the two above, extended from Page/LavaShortcode to Attribute.
  **Evidence:** `church-email-signatures/5b42a865` 2026-08-06 — *"I saved it through the attribute's
  Security dialog in the UI (the required step to make REST-written rules take effect)."*

**Working rule for any REST/SQL write to PageRoute, LavaShortcode, or Attribute Auth:** treat the
UI Save (or an app-pool recycle) as the actual commit step. The database write is necessary but
not sufficient.
