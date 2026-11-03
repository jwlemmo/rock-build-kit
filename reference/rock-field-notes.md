# Portable field notes

Read the comprehensive `skills/rock-build/SKILL.md` plus `mcp/reference/rock-runtime-gotchas.md`. Historical behavior must be verified on the actual version. No inherited numeric ID is configuration.

- Use the MCP buildlib and guarded write APIs for pages, blocks, HtmlContent, workflows, metrics, badges, attributes and reports. Clone a shared report when the change should affect only one page; ReportField sorting uses ColumnOrder.
- New metrics need partitions. Resolve SQL/manual source values and entity IDs locally. Do not backfill the current period that a scheduled calculation owns.
- Workflow action and launch endpoints have exhibited hangs; inspect for an already-created record before retrying. Prefer launch_workflow's WorkflowEntry path. New action configuration may need a WorkflowType cache refresh. Criteria-skipped actions can still signal success; design completion/branching explicitly.
- Full HtmlContent versions avoid WYSIWYG stripping; ApprovedDateTime affects which version renders. Use UTC, exact bytes, hashes, and edit_block_content for surgical edits. New blocks can require page cache refresh. Resave REST-created routes in the browser if registration is stale.
- Auth order matters: specific allows before deny-all, verify actual effective access. Use role membership rather than scattered individual permissions.
- ASP.NET wraps content in a form: use type="button" for non-submit buttons. Test overlays against Rock navigation and validate mobile layout. Never conclude from API success that UI is correct.
- For file bytes use a verified binary path; the source installation required hex through Lava because base64 was corrupted. Cookies and API tokens are different authentication mechanisms.
- Native e-sign, Person Entry matching, AttributeMatrix, dashboard caching, and Lava behavior are covered in the retained recipe references. Inspect configuration names/guids to resolve current IDs.
