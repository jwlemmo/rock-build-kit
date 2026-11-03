# Included MCP tools

All 55 upstream tools are retained. Read means no intentional Rock data mutation; it can still access sensitive data. Guarded edits use preview tokens; other writes may execute immediately.

| Tool | Category |
|---|---|
| `search_people` | Read |
| `get_person` | Read |
| `update_person` | Write — executes immediately |
| `update_person_address` | Write — executes immediately |
| `update_person_phone` | Write — executes immediately |
| `add_person_tag` | Write — executes immediately |
| `remove_person_tag` | Write — executes immediately |
| `search_groups` | Read |
| `get_group` | Read |
| `update_group` | Write — executes immediately |
| `add_group_member` | Write — executes immediately |
| `remove_group_member` | Write — executes immediately |
| `search_attendance` | Read |
| `record_attendance` | Write — executes immediately |
| `search_giving` | Read |
| `get_metrics` | Read |
| `list_metric_categories` | Read |
| `upsert_metric_value` | Guarded write (metric creates execute immediately) |
| `execute_sql` | Read |
| `get_schema` | Read |
| `search_reservations` | Read |
| `create_reservation` | Write — executes immediately |
| `update_reservation` | Write — executes immediately |
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
| `set_person_attribute` | Write — executes immediately |
| `list_step_programs` | Read |
| `list_step_types` | Read |
| `list_person_steps` | Read |
| `record_step` | Write — executes immediately |
| `get_notes` | Read |
| `add_note` | Write — executes immediately |
| `list_schedules` | Read |
| `get_schedule` | Read |
| `list_workflow_types` | Read |
| `launch_workflow` | Write — executes immediately |
| `list_tags` | Read |
| `search_communications` | Read |
| `get_communication` | Read |
| `get_block_content` | Read |
| `edit_block_content` | Guarded write (metric creates execute immediately) |
| `rock_create` | Write — executes immediately |
| `rock_edit` | Guarded write (metric creates execute immediately) |
| `rock_delete` | Guarded write (metric creates execute immediately) |
| `create_page_bundle` | Write — executes immediately |
| `rock_restore` | Guarded write (metric creates execute immediately) |
| `flush_cache` | Write — executes immediately |

`tools/rock-ui`, `tools/render-lava.mjs`, `tools/push-attrvalue.mjs`, and `mcp/src/buildlib` are additional local tools; direct scripts are outside MCP confirmation enforcement.
