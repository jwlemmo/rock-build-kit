## Lava traps that bite builds
Full reference: the kit root's `reference/rock-lava-reference.md`. The ones that cause silent-wrong-output (not
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
- **Prefer `{% modifyentity %}` over a raw `{% sql %}` write** — it fires Rock's PreSave/PostSave
  hooks, fills ModifiedDateTime/ModifiedByPersonAliasId and writes History; raw SQL skips all of
  that (and attribute Default Values on insert). Rules: one action per block;
  `[[ attribute key:'...' ]]` keys are NOT Lava-rendered (use literals); an empty `[[ property ]]`
  writes NULL; setting Guid fails; the result is keyed by entity type name — use a named `return:`.
- `{% dbtransaction %}` wraps modifyentity/deleteentity; a `{% sql %}` write inside it can't report
  failure; rendered output inside is discarded on rollback; `forcerollback:'true'` is a dry run.
- **Once an entity command runs, later UPDATEs in the same render save nothing** (inserts still
  work; issue #7155). A failed modify also poisons later saves in the same render, and a blank
  value in an entity command's `where:` (Dynamic LINQ) breaks it. Split such work across renders.
- **A `{% sql %}` timeout throws away the whole rendered template** and returns HTTP 200 with
  `Lava Error: (Block: sql) Execution Timeout Expired` (default 30 s). Set `timeout:` on heavy
  queries.
- **⚑ `/-` after an unclosed `{` blanks the rest of the template with HTTP 200** (observed on
  Rock 19.8.1): Rock reads it as a `/- ... -/` block comment. CSS like `grid-row: 1/-1` inside a
  `{ }` rule, or a SQL string containing `/-`, truncates everything after it. Write `1 / -1` with
  spaces or wrap static code in `{% raw %}`.
- Lava truthiness (observed on Rock 19.8.1): `''` is truthy, nil is falsy; a SQL integer `==` a
  Lava string is equal both ways; `AsInteger('12abc')` = nil, `AsInteger('1.9')` = 1. `Default`
  replaces only null/empty.


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

