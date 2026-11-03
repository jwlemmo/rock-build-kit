> Portability: observed behavior, not a version guarantee. Discover all IDs locally; examples are not production configuration.

# Rock RMS Lava — Full Reference

Gotchas and patterns learned while writing Lava for Rock at the source church. Read this BEFORE
writing Lava — the merge-field and tag-join issues here are the kind of things that waste a
half-hour of trial and error.

_This is the full reference (scrubbed copy of the operator's canonical vault note; person examples
genericized). The build-breaking subset is also inlined in the `/rock-build` skill._

---

## 1. Report Lava Field merge variables: use bare property names

Inside a **Lava Field column** on a Rock Report, the current row's properties are exposed
**directly without a prefix** — not under `Row.`, `Person.`, `Entity.`, or `Object.`.

```liquid
✅ {{ Id }}            → 12345
✅ {{ NickName }}      → Sam
✅ {{ LastName }}      → Smith
✅ {{ PrimaryAliasId }}

❌ {{ Row.Id }}        → empty
❌ {{ Person.Id }}     → empty
❌ {{ Row.PersonId }}  → empty
❌ {{ Entity.Id }}     → empty
```

If your SQL throws "Incorrect syntax near AND" or similar, the most likely cause is that
`{{ Row.Id }}` rendered empty and the WHERE clause collapsed. Diagnose by pasting:

```liquid
Id = {{ Id }}<br>
NickName = {{ NickName }}<br>
PrimaryAliasId = {{ PrimaryAliasId }}
```

…then use whichever populates.

---

## 2. Tags: `TaggedItem.EntityGuid` joins to `Person.Guid` (NOT `PersonAlias.Guid`)

For Person-entity tags, the `TaggedItem.EntityGuid` column stores the **Person.Guid**. A query
joining via PersonAlias will return zero rows.

```sql
-- ✅ Correct
INNER JOIN Person p ON p.Guid = ti.EntityGuid
WHERE p.Id = {{ Id }}

-- ❌ Wrong (returns nothing)
INNER JOIN PersonAlias pa ON pa.Guid = ti.EntityGuid
WHERE pa.PersonId = {{ Id }}
```

If a Lava field renders blank with no error, this is suspect #1.

---

## 3. The `{% sql %}` block

Lava lets you embed SQL and iterate the rows:

```liquid
{% sql %}
SELECT col1, col2 FROM Foo WHERE Id = {{ Id }}
{% endsql %}
{% for row in results %}{{ row.col1 }}{% endfor %}
```

- The result variable is always **`results`** (lowercase, plural).
- `{{ Id }}` (and other merge fields) are interpolated **before** the SQL is sent to the
  server, so they're not parameterized — be aware if the value could be untrusted. (Rock v9+
  supports real parameter binding: `{% sql name:'{{ v }}' %} … WHERE x = @name {% endsql %}` —
  use it for anything external/untrusted.)
- The block requires the page/block to allow Lava SQL. The Reports block typically does; if you
  get "SQL not enabled," an admin needs to flip it on for the block
  (`EnabledLavaCommands="Sql"`, block attr 1983 on HTML blocks).

---

## 4. Tag creation gotcha: Entity Type must be explicitly "Person"

When creating tags via the Rock UI for use with the MCP `add_person_tag` tool: the **Entity
Type field defaults to blank/Universal**, and tags created that way will fail with:

> Error: Tag "<name>" not found for Person entity type

Fix: edit the tag, set **Entity Type = Person**, save. The MCP call will then succeed.

If tagging fails right after creation, check this first.

---

## 5. Safe output for missing data

`{% sql %}` returns an empty `results` collection if no rows match. Wrap output in a check so
labels don't render for people with no data:

```liquid
{% if results.size > 0 %}
  ...labels and data...
{% endif %}
```

For multi-line output where some lines might be empty, also check each accumulator string
before printing its label:

```liquid
{% if line1 != '' %}<strong>Label:</strong> {{ line1 }}<br>{% endif %}
```

---

## 6. Building a comma-separated list with conditional separator

Lava doesn't have a clean "join with separator" filter that handles the empty-first-item case.
The pattern that works:

```liquid
{% assign acc = '' %}
{% for row in results %}
  {% if acc == '' %}
    {% assign acc = row.SomeField %}
  {% else %}
    {% assign acc = acc | Append:', ' | Append:row.SomeField %}
  {% endif %}
{% endfor %}
{{ acc }}
```

For simpler cases where you have ALL rows up front and want a separator between them,
`{% unless forloop.last %}, {% endunless %}` inside the for loop is cleaner.

---

## 7. HTML in Lava field cells works

Rock renders the Lava field output as HTML in the report grid. So `<br>`, `<strong>`, `<em>`,
links, etc. all work. Useful for multi-line cells.

---

## 8. Tag-driven multi-line report column (real, working example)

This pattern powers a staff-report column that renders a three-line profile from a family of
Person tags (names follow a `"<Prefix> N - <Value>"` convention). It exercises §§2, 5, 6 at
once:

```liquid
{% sql %}
SELECT
  t.Name AS TagName,
  CASE
    WHEN t.Name LIKE 'Genius 1%' THEN 1
    WHEN t.Name LIKE 'Genius 2%' THEN 2
    WHEN t.Name LIKE 'Competency 1%' THEN 3
    WHEN t.Name LIKE 'Competency 2%' THEN 4
    WHEN t.Name LIKE 'Frustration 1%' THEN 5
    WHEN t.Name LIKE 'Frustration 2%' THEN 6
  END AS SortOrder
FROM Tag t
INNER JOIN TaggedItem ti ON ti.TagId = t.Id
INNER JOIN Person p ON p.Guid = ti.EntityGuid
WHERE p.Id = {{ Id }}
  AND (t.Name LIKE 'Genius %' OR t.Name LIKE 'Competency %' OR t.Name LIKE 'Frustration %')
ORDER BY SortOrder
{% endsql %}
{% if results.size > 0 %}
{% assign genius = '' %}
{% assign competency = '' %}
{% assign frustration = '' %}
{% for row in results %}
  {% assign type = row.TagName | Split:' - ' | Last %}
  {% if forloop.index <= 2 %}
    {% if genius == '' %}{% assign genius = type %}{% else %}{% assign genius = genius | Append:', ' | Append:type %}{% endif %}
  {% elsif forloop.index <= 4 %}
    {% if competency == '' %}{% assign competency = type %}{% else %}{% assign competency = competency | Append:', ' | Append:type %}{% endif %}
  {% else %}
    {% if frustration == '' %}{% assign frustration = type %}{% else %}{% assign frustration = frustration | Append:', ' | Append:type %}{% endif %}
  {% endif %}
{% endfor %}
{% if genius != '' %}<strong>Genius:</strong> {{ genius }}<br>{% endif %}
{% if competency != '' %}<strong>Competency:</strong> {{ competency }}<br>{% endif %}
{% if frustration != '' %}<strong>Frustration:</strong> {{ frustration }}{% endif %}
{% endif %}
```

Example output shape:

> **Genius:** Value1, Value2
> **Competency:** Value3, Value4
> **Frustration:** Value5, Value6

---

## 9. Diagnostic-first workflow

When a Lava field doesn't behave:

1. **Replace the whole template with a diagnostic** that prints the variables you depend on.
   Confirm they have values.
2. **Test the SQL in isolation** by hardcoding a known ID (e.g., `WHERE p.Id = 12345`) before
   re-introducing `{{ Id }}`. This separates "SQL is wrong" from "merge field is empty."
3. **Add `<br>` between debug lines** so the column renders readably.

Don't iterate blindly on the production template — the debug round trip is fast.

---

## 10. Time zones — server-computed date properties are UTC, Lava `'Now'` is org-local

LH's Rock SQL server runs on UTC. **Person properties that include a "today" comparison are
computed server-side using the SQL clock, so they flip a day around 6–7pm Central** (when UTC
rolls over).

Affected properties (non-exhaustive — anything that compares to "today" on the server):
- `DaysUntilBirthday`
- `DaysUntilAnniversary`
- `Age` (only on the actual birthday — wrong for people whose birthday is today-Central but
  tomorrow-UTC)
- Any custom calculated SQL field using `GETDATE()` / `GETUTCDATE()` against today

In contrast, **Lava's `'Now'` uses `RockDateTime.Now`, which respects Rock's org-configured
time zone** (System Settings → General Configuration → Organization Time Zone, currently
Central). So `'Now' | Date:'yyyy-MM-dd'` is correct from Lava's perspective even when the SQL
server is wrong.

### The rule

**Don't trust `DaysUntilBirthday`-style server-computed date fields in user-facing UI.
Recompute in Lava using `'Now'` and `DateDiff`.** This applies to both:

- The displayed value (e.g., "TODAY" badge, "in 5 days" label)
- Any `where:` filter that uses the field — server-side filters drop people whose actual
  today/tomorrow has wrapped to `364`/`365`

### The fix pattern

```liquid
{% assign today = 'Now' | Date:'yyyy-MM-dd' %}
{% assign currentYear = 'Now' | Date:'yyyy' %}
{% assign nextYear = currentYear | Plus:1 %}

{% for person in personItems %}
  {% unless person.BirthDate %}{% continue %}{% endunless %}
  {% assign bMonthDay = person.BirthDate | Date:'MM-dd' %}
  {% assign bdayStr = currentYear | Append:'-' | Append:bMonthDay %}
  {% assign daysUntil = today | DateDiff:bdayStr,'d' %}
  {% if daysUntil < 0 %}
    {% assign bdayStr = nextYear | Append:'-' | Append:bMonthDay %}
    {% assign daysUntil = today | DateDiff:bdayStr,'d' %}
  {% endif %}
  {# now use daysUntil for filtering, labeling, etc #}
{% endfor %}
```

### Sort/filter caveat

Pulling a wide range and filtering in Lava is fine for moderate datasets (low thousands). For
sorting:

- Server `sort:'DaysUntilBirthday'` is **shifted but stable** — relative order is preserved,
  except the actual-today people land at the end of the list (with server-DaysUntilBirthday
  ≈ 364) instead of the top.
- To handle this without sorting in Lava (which is awkward), **bucket the rendered cards into
  today/tomorrow/future strings** and concatenate at the end.

### Real example

The homepage birthday block was showing tomorrow's birthdays with a "TODAY" badge after ~6pm
Central because the SQL server had already rolled to the next UTC day. The fix recomputes
`daysUntil` in Lava and buckets cards before rendering. Code lives on the homepage HTML block.

### Root-cause alternative

The cleanest fix is to have Rock compare against `RockDateTime.Today` instead of `GETDATE()`
for these computed fields, but that's plugin-level work. The Lava-side workaround is good
enough for end-user displays.

---

## 11. `{% sql %}` breaks on leading `--` comments → "Cannot find table 0"

A SQL comment as the FIRST line inside `{% sql %}` breaks Lava's parser and throws
`Rock SQL/Lava error: (Block: sql) Cannot find table 0`. Hit three separate times in June
2026. Strip leading comments — safest is no `--` comments inside Lava SQL at all. (The MCP's
`execute_sql` strips them for you; hand-written Lava does not get that protection.)

---

## 12. No nested aggregates — use a CTE

Rock's SQL Server rejects aggregate-of-aggregate: "Cannot perform an aggregate function on an
expression containing an aggregate or a subquery." Compute the inner aggregate in a CTE, then
aggregate the CTE. Hit 3× across different sessions in June 2026.

---

## 13. Literal Lava delimiters (and keyword lookalikes) in SQL text get rejected

The MCP write path rejects any SQL containing literal `{{ }}` / `{% %}` — even inside string
literals you're merely searching for (e.g. `LIKE '%{%raw%}%'`). Workarounds: build the
delimiters with CHAR() codes (`CHAR(123)+CHAR(37)` = `{%`), or do the write via REST instead.

Related: the v2 `execute_sql` read validator string-matches keywords, so it can false-positive
on "Delete"/"Create" appearing inside CASE labels or data strings, and on
multi-statement-lookalikes. Rewrite to avoid the bare keyword, or split the query.

---

## 14. Three DIFFERENT cache flushes — don't mix them up

1. **HtmlContent blocks** (page HTML edited via SQL/REST): PATCH the block's HtmlContent
   `ApprovedDateTime` via REST — that fires `FlushCachedContent`. The Cache Manager page does
   **not** flush this.
2. **Block settings / attribute values** (edited via SQL): Cache Manager (page 533) → Clear
   Cache.
3. **Security/Auth records written via REST**: Rock does **not** auto-flush the permission
   cache (UI writes do). New Auths are invisible until you flush.

This was independently re-discovered in two projects within 5 days (6/26 and 7/1/2026) —
trust this section, not trial and error.

---

## 15. Rock REST API gotchas

- Controller names are **plural**: `PATCH /api/Auths/{id}`, not `/api/Auth/{id}` (404s).
- `POST /api/WorkflowActionTypes` **hangs forever** — insert WorkflowActionType rows via SQL
  (`rock_create` with `mode:"sql"`) and pass `cacheFlushWorkflowTypeId`.
- OData types `Auths.SpecialRole` as a **string** — filter/compare it as text, not int.
- REST ignores page-level security entirely; REST access is governed by RestController/entity
  Auths (see `rock-rest-api-security.md` in this folder).

---

## 16. Schema: look it up, don't guess

Column-name guessing burned 10+ round trips in June 2026 ("Invalid column name", "multi-part
identifier could not be bound"). Use the MCP's `get_schema("TableName")`, or raw:

```sql
SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'ReportField' ORDER BY ORDINAL_POSITION
```

Known traps: `ReportField` orders by `ColumnOrder`/`SortOrder` (there is no `[Order]` column);
layout/join FK names often don't match the guessed pattern.

---

## 17. Dashboard performance: precompute, don't live-query

Heavy aggregates in page-load `{% sql %}` blocks time out and drag the whole page (an 8s page
dropped to 2.4s on 6/27/2026 by moving them out). Pattern: run expensive queries in a
**nightly metric-value job** and have the page read MetricValues. Also: Rock theme CSS
sometimes needs `!important` to override text/labels in embedded custom blocks.

---

## See also (in this kit)

- `rock-rest-api-security.md` — the full security model for API keys and Auth records.
- the local implementation of this pattern — metric + workflow + dashboard build recipes that use these
  patterns in anger.
- The `/rock-build` skill — the generalized recipes, including the newer traps (PascalCase
  math filters, `Split` nullable-last, `InitiatorPersonAlias` blank in action Lava).
