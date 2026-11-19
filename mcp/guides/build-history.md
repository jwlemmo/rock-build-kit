## The v18 upgrade LANDED 7/28/26 (overnight, ahead of the Sept plan)
MCP side: a NON-EVENT, exactly as the 7/19 audit predicted — auth, REST, and all tools kept
working on prod v18. The real cost was the FORM regressions (see the ⚑ v18 block in the
Obsidian WorkflowEntry recipe): sectioned-form PreHtml dropped, post-sign message hardcoded,
input-group addon/spacing CSS changes. Historical notes from the pre-upgrade audit follow.
The
earlier claim that "v18's v2 REST rejects `Authorization-Token`" was **wrong** — v18 auth
is identical to v17; the 401s were missing `ExecuteUnrestrictedRead/Write` Auth rows
(deny-by-default, exact-match, no RSR bypass — and Rock 401s for *unauthorized* too, which
is what fooled the 7/5 diagnosis). Prod's 6/15 bulk grant survives the in-place upgrade,
so nothing breaks; upgrade-day runbook (idempotent grant SQL for new controllers → cache
clear → driver rerun) lives in the kit root's `reference/rock-rest-api-security.md`.
v18.2 confirms fixed: workflow-launch #6604, v2-JSON-body writes. v18.2 quirks to remember:
v2 `metricvalues/search` 500s (get_metrics auto-falls back to SQL); `People` v1 DELETE is
405; v1 DELETE on Groups/Tags/WorkflowTypes soft-deletes (`IsActive=0`). Native-AIAgents
angle still worth a spike. Re-check this skill after the upgrade.
See the kit root's `reference/rock-field-notes.md` and the kit root's `reference/rock-rest-api-security.md`.
