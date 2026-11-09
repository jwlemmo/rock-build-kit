# Included MCP tools

All 55 upstream tools are retained, plus get_build_guide for clients without local file access. Read means no intentional Rock data mutation; it can still access sensitive data.

## Write rules (every write tool)

- **Reason required.** Every write call must pass `reason`: one plain sentence saying why. An empty reason is refused before anything runs. The reason is recorded in the audit ledger and is part of the confirmation token, so changing it needs a fresh preview.
- **Two kinds of write.** *Ledgered create*: runs at once, is recorded in the ledger with the new row's Id, and `rock_restore` can undo it. *Two-phase*: the first call writes nothing and returns a preview (intended change, before-snapshot, `confirmation_token`); show it to the person, then repeat the same call with the token to execute. A token from a changed call, a changed reason, or a target that changed in Rock is refused.
- **Bulk cap.** One call may touch at most `ROCK_MCP_BULK_WRITE_MAX` rows (default 25). A bigger call is refused unless it passes `allowBulk: true` with a reason that says why. For `mode:"sql"` UPDATE/DELETE the server counts the rows with your `snapshotQuery` and refuses when that count does not match the statement's own WHERE; INSERT…SELECT is counted before it runs.
- **Refusals are ledgered** as phase `"denied"` (tool, target, why).
- **Read-back.** Every executed write re-reads its target and reports `verified: true/false`. Nothing is ever retried automatically; when `verified` is false, check in Rock before trying again.
- **SQL writes** (`rock_create`/`rock_edit`/`rock_delete` with `mode:"sql"`) pass a preflight: GETDATE()/SYSDATETIME() and the other database-clock functions are refused (set `ROCK_TIMEZONE` to the Rock server's Windows time-zone id to get a ready-made "now" expression; the kit assumes no zone), INSERTs are checked against the table's real columns (missing NOT NULL columns, unknown columns, `IsSystem` on tables without it), GroupMember INSERTs must set `GroupTypeId`, and missing Created/Modified audit columns are added from the API key's own person. Writes to the `Auth` table also pass a lockout guard that refuses removing or denying the stock "RSR - Rock Administration" role's access or the API key person's own access.
- **Dev bundle gate.** When `ROCK_REQUIRE_CHANGE_BUNDLE=1` and the target host is `ROCK_DEV_HOST`, build writes need the operator's open change bundle (see CHANGELOG-SETUP.md).
- `flush_cache` is ledgered but needs no reason; it only bumps a timestamp so Rock rebuilds its cache.

| Tool | Category |
|---|---|
| `get_build_guide` | Read — bundled instructions; no Rock request |
| `search_people` | Read |
| `get_person` | Read |
| `update_person` | Write — two-phase |
| `update_person_address` | Write — two-phase (adding a new address type creates a Location + GroupLocation, both ledgered) |
| `update_person_phone` | Write — two-phase |
| `add_person_tag` | Write — ledgered create |
| `remove_person_tag` | Write — two-phase |
| `search_groups` | Read |
| `get_group` | Read |
| `update_group` | Write — two-phase |
| `add_group_member` | Write — ledgered create |
| `remove_group_member` | Write — two-phase (Rock may archive instead of delete; restore un-archives) |
| `search_attendance` | Read |
| `record_attendance` | Write — ledgered create |
| `search_giving` | Read |
| `get_metrics` | Read |
| `list_metric_categories` | Read |
| `upsert_metric_value` | Write — new value is a ledgered create; overwrite is two-phase |
| `execute_sql` | Read |
| `get_schema` | Read |
| `search_reservations` | Read |
| `create_reservation` | Write — ledgered create |
| `update_reservation` | Write — two-phase |
| `search_content_channels` | Read |
| `search_content_channel_items` | Read |
| `get_content_channel_item` | Read |
| `list_defined_types` | Read |
| `list_defined_values` | Read |
| `get_defined_value` | Read |
| `list_campuses` | Read |
| `get_campus` | Read |
| `list_attributes` | Read |
| `get_person_attributes` | Read |
| `set_person_attribute` | Write — two-phase (restorable) |
| `list_step_programs` | Read |
| `list_step_types` | Read |
| `list_person_steps` | Read |
| `record_step` | Write — ledgered create |
| `get_notes` | Read |
| `add_note` | Write — ledgered create |
| `list_schedules` | Read |
| `get_schedule` | Read |
| `list_workflow_types` | Read |
| `launch_workflow` | Write — ledgered, cannot be undone (its actions have already run) |
| `list_tags` | Read |
| `search_communications` | Read |
| `get_communication` | Read |
| `get_block_content` | Read |
| `edit_block_content` | Write — two-phase, byte-exact |
| `rock_create` | Write — ledgered create |
| `rock_edit` | Write — two-phase |
| `rock_delete` | Write — two-phase |
| `create_page_bundle` | Write — ledgered create (one record per object) |
| `rock_restore` | Write — two-phase undo of a ledgered write (security-role members are re-created by validated SQL) |
| `flush_cache` | Write — ledgered, no reason required |

`tools/rock-ui`, `tools/render-lava.mjs`, `tools/push-attrvalue.mjs`, and `mcp/src/buildlib` are additional local tools; direct scripts are outside MCP confirmation enforcement.
