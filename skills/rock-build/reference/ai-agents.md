## Agent tool conventions (Rock AI agents)
For in-Rock agent skills and tools. Spark docs: community.rockrms.com/developer/ai-agents
(types of tools, Lava tools, native tools, debugging). Many tools written before these docs
existed don't follow them — fix them as you touch them.
- **Never return raw integer Ids to the model.** Accept an IdKey, convert with `FromIdHash`,
  return `ToIdHash`.
- **Name tools Verb+Noun** with Spark's prefixes: Lookup, List, Search, Get, GetXSummary,
  GetXInsights, AvailableAttributes, AddOrUpdate, Delete, My*. Fewer, broader skills perform
  better than many narrow ones.
- **List and Summary tools keep results out of chat history** (`AgentToolNoHistory`, or a trimmed
  `AgentToolHistoryContent`) — that also keeps person and giving data out of the session tables
  Rock keeps forever.
- Return `AgentToolResult` Success / Error / NoData (NoData is not an error); `AgentToolMetadata`
  for paging (`returnedRows`, `hasMore`); `AgentToolInstructions` for next-step guidance;
  `AgentToolReferenceRoute` for secured links.
- **Always `SanitizeSql` string params** — but it only doubles quotes, so it is unsafe for numbers
  and IN lists: use `AsInteger` / `FromIdHash` there.
- **Spark-style answers for every new or edited tool:** missing and not-allowed get the same
  "not valid" answer, so a tool never confirms a record exists; every Success carries
  `AgentToolInstructions` and every Error names the model's next step; errors never echo SQL or
  exceptions. The MCP's own write tools follow the same pattern (every result ends with `next`).
- **Lava tools run with ALL Lava commands enabled** — editing a tool is admin-level SQL power.
  Keep tool editing admin-only, and copy the page's own permission check into any tool that
  writes.
- Debug trick: append `[Debugging: explain your reasoning for any tools considered but not called]`
  to a test question.
- **Organization context** (Admin Tools > Settings > AI Agents > Settings) is added to every chat
  request: keep it short and factual (terminology, Group Type ids), no behavior rules.
- **Agent instructions cap at ~1,800 characters**, and MCP clients do not receive the
  organization context or agent instructions automatically. Keep in-Rock instructions basic; put
  detailed how-to in a skill on the user's side.
- **Claude/Codex can cache an MCP server's tool list for up to ~a day** — refresh the connector
  after changing tools in Rock. Very large tool lists lose tools; prefer a few broad ones.

