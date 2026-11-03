> Portability: observed behavior, not a version guarantee. Discover all IDs locally; examples are not production configuration.

# Compute-heavy Lava dashboards — caching + external data (7/2026)

Learned on two shipped dashboards: **People on Campus** (page 3261 `/OnCampus`, Block 6058,
HtmlContent 844 — heavy multi-source SQL per campus/service-hour) and **Network Health**
(page 3283 `/NetworkHealth` — server-side Meraki API calls). Index entries live in
`skills/rock-build/SKILL.md`; this note is the working detail.

## HtmlContent active-version mechanics (the stale-dashboard trap)

- `HtmlContent.ApprovedDateTime` is **stored/compared in UTC**, and Rock serves the version row
  with the **latest** ApprovedDateTime. Stamping local time (behind UTC) made a *newer* version
  silently lose to the old one. **Always stamp with UTC** (`utcnow()` / `toISOString()`).
- **Identical timestamps across versions can activate the WRONG (oldest) row.** The kit's
  `flush_cache target:block` used to stamp every version the same; since 7/14/26 it stamps the
  newest row (highest Id) strictly later so it deterministically wins. On older builds, follow a
  block flush with `flush_cache target:htmlcontent` on the row that should win.
- The HTML Content block's output cache **keys by query string** — while a block is broken, each
  query-string variant caches its own error copy (looks like inconsistent behavior; it isn't).

## Compute-once `{% cache %}` pattern

- Block attr **<discover ID>** `EnabledLavaCommands = "Sql,Cache"`; wrap the whole body:
  `{% cache key:'poc-{campus}-{yyyyMMdd}{refreshSuffix}' duration:'…' %} … {% endcache %}`.
  Use a context-aware TTL (e.g. 600 s during live hours, 21600 s otherwise). Compute ~0.5–3 s;
  cache hits ~0.02 s.
- `?refresh=1` appends a suffix (e.g. `-rHHmmss`) to the key → a **private fresh compute for that
  viewer**, shared entry untouched. Render per-viewer UI (an admin-only Refresh button, role-gated
  in Lava) **outside** the cache tag.
- ⚠ **Never write a bare block tag (`{% cache %}`, etc.) inside `{%- comment -%}`** — Rock parses
  it as a real unclosed tag → live "Index was outside the bounds of the array" / "Unclosed tag
  'cache'". Reword prose to "the cache tag". (One phantom happened to be tolerated; three broke
  the page.)

## LavaShortcodes created via REST

Two SEPARATE gotchas:
1. The REST create **silently drops the `Parameters` field** — re-SELECT and PATCH it.
2. The shortcode **doesn't register with the Lava engine at all** until an admin opens it in
   Admin → CMS → Lava Shortcodes and clicks **Save**. Clearing LavaShortcodeCache /
   WebsiteLavaTemplateCache does nothing (same disease as REST-created PageRoutes).

## Verifying SQL-heavy templates

- `/api/Lava/RenderTemplate` **mangles multi-line `{% sql %}` bodies** ("Incorrect syntax near
  '\\'" even on clean SQL) — a harness artifact, not a template bug. Verify on the live block.
- SQL time-parsing traps (schedule → service-hour mapping): `TRY_CONVERT(time,'')` returns
  **midnight, not NULL** → wrap with `NULLIF(col,'')`; iCal midnight DTSTARTs are data-entry
  artifacts (also NULLIF); biweekly A/B-week parity = `DATEDIFF(WEEK, DTSTART, @targetDate) % 2`
  (and check the day-of-week — some "Sunday-looking" biweekly schedules are weeknight groups).
  Prefer fully data-driven mapping with a diagnostics line (excluded/unmapped counts) in the
  footer over any hardcoded map.

## External APIs — two patterns

**Server-side (`{% execute %}`), key never in the browser** — the Rock Health / Network Health
pattern:
- `{% execute %}` runs C# with HttpClient; the API key lives in an **encrypted Global Attribute**
  and never reaches the client. Requires `EnabledLavaCommands=Execute` on the block.
- Pair a short server-side block cache (~2 min) with a client-side auto-refresh (~5 min) to stay
  under the provider's rate limit. Remember the block cache means a CSS/content tweak keeps
  serving the cached render until it ages out — that's the cache, not a failed deploy.
- Recurring quirk: a REST-created route won't resolve until a page-editor re-save or app-pool
  recycle; `/page/<id>` works meanwhile.

**Client-side bridge** — for sources that aren't in Rock's DB at all (e.g. Planning Center
scheduling):
- Add a tiny read-only route to an app you already control
  (`GET /api/public/…?campus=…&token=…`), token substituted into the block at deploy time; the
  provider key stays server-side in that app.
- The block's JS fetches it and merges the numbers into the rendered cards — stays live past the
  Lava cache and needs no new Rock integration. Mark the merged numbers' provenance in a footer
  so trend badges computed server-side stay honest.
