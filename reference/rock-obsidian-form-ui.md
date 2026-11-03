> Portability: observed behavior, not a version guarantee. Discover all IDs locally; examples are not production configuration.

# Obsidian WorkflowEntry form UI — the reusable PreHtml kit (7/2026)

Proven across TWO shipped e-sign builds — Check Request (Block **<discover ID>**, page 3274) and Missing
Receipt (Block **<discover ID>**, page 3290), both on the Obsidian WorkflowEntry **BlockType 608**. All
custom form UX lives in **Block PreHtml** (a `<style>` + `<script>` fragment); a REST Block PATCH
flushes that block's own cache, so PreHtml deploys need no Cache Manager trip. The generalized
index is `skills/rock-build/SKILL.md` → "Obsidian WorkflowEntry form UI"; this note is the deep
detail.

## ⚑ Rock v18 regressions (prod upgraded 7/28/26 — read this FIRST)

Confirmed against Rock source, present in every 18.x release through 18.4.1 + develop — and **still present on 19.4.4** (prod + rockdev, 9/2026):

1. **Sectioned forms silently DROP per-field PreHtml/PostHtml.** Any FormAttribute with an
   `ActionFormSectionId` loses its PreHtml/PostHtml entirely (custom labels, help text, JS mount
   divs/anchor spans). Flat (section-less) forms still render it — v18.1's fix for #6446 covered
   only that branch. Filed upstream: **SparkDevNetwork/Rock#6944**.
   - **New builds: put question text in the NATIVE field label and the help note in the field
     Description (the ⓘ bubble) — do not build labels in field PreHtml.** This survives v18 and
     is the pattern both the check-request retrofit shim emulates and the new-hire forms were
     migrated to.
   - **Existing PreHtml-built forms:** the block still ships every field's `preHtml`/`postHtml`
     in its init config JSON (`componentConfiguration.fields[n].preHtml`) — a client-side shim
     can re-fetch the page, parse those out, and inject them. Reference implementation:
     `V18_FIELDCHROME_JS` in the local implementation of this pattern — pair config fields to the LEAF
     `.row > [class*=col-md-]` containers in document order, verify each pair's `columnSize`
     against the container's `col-md-N`, **abort untouched on any mismatch**, and retry bounded
     (SPA step transitions race the fetch). Config escaping: structural quotes arrive as
     `"`, value-internal quotes as `\\"` (3 backslashes) — tokenize inner quotes to a
     placeholder before regexing.
2. **The post-sign message is HARDCODED** ("Your signature has been submitted successfully.",
   `Rock/Workflow/Action/WorkflowControl/ElectronicSignature.cs:231`) and always wins over
   `NoActionMessage` in the SPA state — a fresh GET renders NoActionMessage fine. The
   reload-once shim (below) is now **required** on every e-sign form, not a nice-to-have.
3. **Theme CSS pins `.input-group-addon` height (~16px)** — date-picker calendar buttons shrink
   to detached chips — and the inter-field vertical rhythm is gone (labels visually hug the
   previous field; narrow inputs overflow under neighbors). Fix CSS: addon
   `align-self:stretch; height:auto !important`; input `flex:1 1 auto; width:auto; min-width:0`;
   restore spacing with `margin-bottom` on the field containers.
4. **Deploy-script escaping trap (cost a failed prod deploy):** JS regexes inside
   template-literal exports lose one backslash layer per nesting (`\\d+` deploys as `d+` and
   matches nothing, silently). **Always functionally test the MATERIALIZED export** — node
   harness against a wire-format sample AND a live in-page eval — never just the hand-typed
   version you tested in devtools.
5. **Managed-sections deploy model** (supersedes blind append for live blocks): give each
   surgical PreHtml addition a named header comment (`/* XX-SECTION-NAME */`) and make the
   deploy script find-and-replace the section **by name** (append only if absent, error if the
   marker exists without its header). Model: the local implementation of this pattern.
6. **Cleanup on a LIVE form:** never run type-wide cleanup scripts once real staff use the form —
   write a targeted script keyed to explicit workflow IDs with an initiator safety check
   (model: the local implementation of this pattern). Rock's auto-purge handles abandoned
   empty entry-page instances on its own.

## Completion screen (NoActionMessage promotion)

- Put your completion "contract" in `WorkflowType.NoActionMessage`, e.g.
  `<div class="xx-done" data-signeddoc="{{ Workflow | Attribute:'SignedDoc','RawValue' }}" data-wfstatus="{{ Workflow.Status }}">…</div>`
- **The block HTML-escapes it** — it arrives as literal text inside an `.alert-warning`. PreHtml JS
  must regex the payload (the BinaryFile GUID) out of the escaped TEXT and swap the alert for a
  real element (`promoteEscapedDone()` pattern).
- **`&#0022;` trap:** the config transport encodes double-quotes as hex entities, so a GUID regex
  with a `[^0-9a-fA-F]` gap can't cross them. Use a lazy `.{0,16}?` gap anchored on the full
  8-4-4-4-12 GUID shape. Cost a redeploy on the first build.
- `| Escape` any user-supplied names rendered in the message so the un-escape is injection-safe.
- **Post-sign dead end:** after Sign → Complete, Rock shows a generic "signature has been submitted
  successfully" panel and never re-renders on its own, so the NoActionMessage (and your download
  button) never appears. Do ONE `location.reload()`, **sessionStorage-guarded per WorkflowId** —
  without the guard it loops forever. (On v18 this message is hardcoded in core — see the ⚑ v18
  section; the reload shim is mandatory.)

## Where things actually render (selectors)

- FormAttribute **PreHtml renders as a SIBLING of `.form-group`** inside the `.col-md-12` column
  wrapper — `closest('.form-group')` fails; search the column wrapper. Some field labels live in
  `.form-section-fields`, not `.form-group`.
- A **read-only form field renders as a static control**:
  `.form-group.static-control > .control-wrapper > .form-control-static` — there is **no
  `<input>`**. Field finders must accept that selector and read `textContent`, not `.value`.
- **Card look without reparenting:** don't build a card inside Rock's panel — set the **Block
  `CssClass`** (e.g. `church-mr`) and restyle `.panel.panel-block` itself (max-width, radius, shadow,
  heading hidden). The native `.actions .btn-primary` then sits inside the card and can take a
  full-width treatment with the Vue form model and any guard disable-logic untouched. Add a JS
  fallback that re-adds the class if the CssClass is ever lost.

## Surviving Vue re-renders

- **Never use a DOM-writing MutationObserver** — it infinite-loops with your own `update()` and
  freezes the renderer. Use a ~300 ms interval tick that re-mounts/re-wires after re-renders, with
  a **state-key guard** so unchanged states are a no-op.
- Keep row/UI state **in JS** — never re-parse it from a hidden field after first load, so
  re-renders can't clobber in-progress typing.
- **Never inject DOM into Vue-owned grid rows** — use CSS **pseudo-content** for chips/badges so
  `textContent` guards stay exact.
- Hides/styling must be **stylesheet rules**, not inline styles or classes toggled on Vue-owned
  nodes (re-renders wipe them). Example: hide the mandatory prefilled e-sign email box with
  `FORM_CSS .form-group:has(input[type=email]) { display:none }` — keep the value present for
  required-validation.
- Ant renders an **empty `.ant-select-selection-item` node even with no value**, so CSS `:has()`
  can't detect blankness — toggle marker classes from the interval sweep and key prompts off those.

## Never fight Ant `<a-select>` (searchable dropdowns)

The durable pattern after a five-version mobile saga:

1. Make the field a **plain Text** attribute/matrix column (FieldType 1).
2. Build the type-to-search dropdown as **your own element appended to `<body>`** (z-index above
   Rock's fixed header), positioned by `getBoundingClientRect()` under the native input, re-pinned
   every ~150 ms + on scroll/resize.
3. Selecting fills the input; **typing already sets the Vue model**, so if the overlay ever breaks
   the field still works as plain text (de-risked by design). Optionally badge hand-typed values
   that aren't in the list — and **re-validate server-side against the canonical list** (never
   trust the client).

Why not Ant's own search:
- The `rc-align` failure mode "parks" the dropdown ~9,999 px off-screen while its class still says
  *open* — on inner-scroll Obsidian pages the align math computes garbage on any focus flip.
  **Debug with `getBoundingClientRect()`, not classes.**
- Obsidian SingleSelect only enables search for `ddl_enhanced`; for DefinedValue selects the
  canonical qualifier is `enhancedselection` — but **v17.6.1 has a bug where single-select
  DefinedValue never forwards enhanced search to the control** (proven via Vue introspection).
  Config alone cannot fix it on this version; fixed on upgrade.

## Driving/testing the form headlessly

- Synthetic input into Obsidian Vue fields needs `.value` set + **BOTH `input` and `change`**
  events; custom-wired fields may only bind after a real `focusin`.
- Building a `File` from a huge pasted base64 string in devtools **truncates the bytes** →
  downstream "PDF not valid" errors that aren't product bugs. Prefer SQL-inserting BinaryFiles
  (readFileSync → hex) to test against known-good bytes.
- These Obsidian pages use an inner-scroll container: screenshots go blank after scrolling and
  `getBoundingClientRect` coords don't match click space — verify by reading DOM values via JS,
  not screenshots/coordinate clicks. Browser-extension JS tools may block return values containing
  GUIDs/query strings (a privacy filter, not a bug) — scrub them from return values.
- E2E recipe: launch through the UI, SQL-attach test data to the instance, reload `?WorkflowId=`,
  click Continue. A raw-SQL-inserted activity has no action rows and "completes" as a silent no-op.

## Deploy discipline

- Keep the PreHtml fragment in a version-controlled source file and deploy with a small script
  that PATCHes `{PreHtml, CssClass}` on exactly the intended block (refuse other block ids).
- **Once you start surgical PreHtml edits on a live block, a regenerate-from-source deploy script
  becomes dangerous** — it will wipe later hand-applied sections. Either fold every section back
  into the source of truth immediately, or mark the regen script STALE with a loud header.
- Always keep a before-backup of the current PreHtml next to the deploy script.
