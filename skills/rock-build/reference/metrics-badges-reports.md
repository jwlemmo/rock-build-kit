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

