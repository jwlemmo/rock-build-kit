# Pages, blocks and dashboards

## Contents
- Recipe — Page + Block + HtmlContent + admin-lock Auth
- Recipe — Compute-heavy Lava dashboards (`{% cache %}` compute-once)
- Recipe — External APIs from a block (server-side, key never in the browser)
- Recipe — Lava Applications (`/api/v2/lava-app/...`)
- Staff pages must work on a phone AND in Rock's dark mode
- Byte-fidelity on large Lava / HtmlContent
- After building — verify in Chrome

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
  (`SpecialRole=1`) last. **An explicit Deny All Users also locks out Rock admins**: RSR - Rock
  Administration gets no bypass once the page or block has its own rules. Always add an Allow for
  RSR - Rock Administration on View, Edit and Administrate ABOVE the deny rows, on the page AND any
  block you lock, and include an admin in the access test. (measured on Rock 19.8.1, 2026-11-17: a
  lock that said "admins always keep access" locked the admin out.)
- **Lock View AND Edit AND Administrate, never View alone.** Rock shows a block to anyone who can
  view OR edit it, and Edit is inherited from parent pages (a person-profile page often gives Edit
  to a pastoral or care group). On each of the three actions: allow the list, allow RSR - Rock
  Administration, then Deny All Users. Write the Auth rows BEFORE the block gets content
  (otherwise it is visible under the page's rules for a while and Rock can cache that), clear the
  cache after any API/SQL Auth write, then impersonate someone from the group that holds Edit higher
  up and confirm they see nothing. Find that group with:
  ```sql
  WITH chain AS (SELECT Id, ParentPageId, 0 AS d FROM Page WHERE Id = <pageId>
    UNION ALL SELECT p.Id, p.ParentPageId, c.d + 1 FROM Page p JOIN chain c ON p.Id = c.ParentPageId)
  SELECT c.d AS levelsUp, a.EntityId AS pageId, a.Action, a.AllowOrDeny, a.SpecialRole, g.Name
  FROM chain c JOIN Auth a ON a.EntityTypeId = (SELECT Id FROM EntityType WHERE Name = 'Rock.Model.Page')
    AND a.EntityId = c.Id
  LEFT JOIN [Group] g ON g.Id = a.GroupId
  WHERE a.Action IN ('Edit','Administrate') ORDER BY c.d, a.Action, a.[Order]
  ```
  (measured on Rock 19.8.1, 2026-11-17: a pledge card on Person Profile showed to a pastoral group
  for an afternoon because only View was locked; Deny Edit for All Users on the block fixed it.)
- Add people to a **security-role group** via `add_group_member` (uses `PersonId`, NOT
  `PersonAliasId`), not direct per-person page Auth.
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
- **⚑ HTML Content Cache Duration > 0 keys on block + context parameter, NOT the current person** —
  it can serve one person's output to another. Never set it on a block that renders per-person
  data; use `{% cache %}` with the person in the key instead.
- The Lava `cache` tag supports `tags:` (clear a tag from Cache Manager) and caps each item at
  200 KB by default. Writes made with the Lava `sql` command bypass Rock's cache — flush yourself.
- Heavy config/data can be built at refresh time into a persisted dataset, so the page makes no
  database calls at load.
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
- **⚑ `{% execute %}` is going away** (removed in v21, and it breaks as Rock moves to .NET Core).
  Inventory your existing uses (block content, PreHtml and workflow action values) and plan
  replacements; Spark recommends a small C# plugin made with the rock-dev-tool CLI. Don't add
  new `execute` uses.
- Cross-source alternative (e.g. Planning Center data that isn't in Rock's DB): fetch client-side
  from a small companion route on an app you control (token substituted at deploy, key stays
  server-side there) and merge into the rendered page in JS — stays live past the Lava cache, no
  new Rock integration.


## Recipe — Lava Applications (`/api/v2/lava-app/...`)
- Endpoints grant **no View by default** — add security deliberately. `javascript`/`stylesheet`
  commands don't work inside endpoints. A GET must not change data.
- **Test endpoints as a non-admin** — admins bypass endpoint security. Send the
  `X-Helix-CSRF-Protection: true` header from the page.
- v20 fixes non-admin failures when the Lava Application Developers role is inactive and
  intermittent 404s after save — on 19.x, re-test after each save.

## Staff pages must work on a phone AND in Rock's dark mode
Rock's staff theme has a dark mode (`[theme="dark"]` on `<html>`, or the OS setting when the
person's theme is "system"), and leaders open dashboards on their phones. A block built with a
light-only palette turns into dark text on black with white cards, and a desktop-only grid runs
off a 390px screen (one installation shipped a dashboard broken both ways, 2026-11-17). For every
HtmlContent dashboard or app:
- **Put every color in CSS variables on the block's root class** and redefine them under
  `[theme="dark"] .root` AND `@media (prefers-color-scheme: dark){ :root:not([theme]) .root,
  [theme="system"] .root{...} }`. Hard-coded colors in SVG `fill`/`stroke` attributes don't
  switch; give SVG parts classes and color them from the variables.
- **Pick the dark palette on purpose** (your church's brand guide, or neutral panels near
  #141414, lines near #2a2a2a, text #f2f2f2 / #a3a3a3, one accent for warnings) instead of
  inverting the light one.
- **Reset Rock's text colors inside the block**: the theme colors bare `p`/`span`/`label` and
  flips them in dark mode. `.root :where(p,span,b,small,div,td,th,a,h3){color:inherit;line-height:inherit}`
  plus `color-scheme` on the root.
- **Phone layout**: grid columns are `minmax(0,1fr)`, never bare `1fr` (a wide table inside a
  `1fr` card pushes the card off screen). Tables with more than 3 columns become one labelled
  block per row under ~640px (`td[data-l]::before{content:attr(data-l)}`). SVG charts in a
  600-wide viewBox need their text scaled up on phones (22 user units ≈ 12px at 390px).
  Segmented tabs: 2x2 grid on phones, not a wrapping pill. Hide Rock's empty title bar with
  `body:has(.root) #main_secPageTitle{display:none}` when the block has its own heading.
- **Test all four before promotion**: 390px and desktop, light and dark (impersonate on the
  sandbox; in a headless browser `emulateMedia({colorScheme})` plus `setAttribute('theme','dark')`),
  and check nothing's right edge passes the viewport. Rock scrolls inside a container, so a
  full-page screenshot needs that container's height and overflow released first.
- Lava tip: avoid `/-` inside CSS in a Lava block (`grid-column:1 / -1`); use `span N`.

## Byte-fidelity on large Lava / HtmlContent
A full-value REST replace of a big template risks losing invisible bytes — the `CampusId=All`
shortcode fix lost **61 bytes** of trailing whitespace on a re-transcribed replace, which
forced a browser Ace-editor edit. For a **targeted** change to a large field, either edit in
the live Ace editor (browser) or do an exact-bytes `mode:"sql"` `UPDATE` (e.g. `REPLACE(...)`),
not a hand-reconstructed full body. The proven push discipline: ASCII-escape (`ensure_ascii`) +
compute a SHA-256 over the exact pushed content and verify before/after. (When editing the Ace
editor via browser JS: the text insert and the Save click must be **separate** JS calls, or the
form model saves stale.)

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
