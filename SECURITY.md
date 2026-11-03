# Security model

Keep one church/operator/environment per connection. The launcher reads only its own explicit environment file. No credential fallback, inherited keys, or production fallback is provided. `mcp/.env*` (except examples), `local/`, audit logs and browser sessions are excluded from releases.

The kit does not make a privileged Rock key least-privileged. In particular SQL-through-Lava can bypass normal entity permission checks. The read-only SQL validator and confirmation tokens are client/server safety measures, not SQL Server authorization. Review this access with the church administrator; revoke/rotate keys if exposed.

New-object tools and several inherited data tools execute immediately. Guarded edit/delete/content-edit/restore tools require a preview token; the human review is still an agent/client responsibility. A compromised agent holding the key can use other HTTP clients. Do not auto-approve all MCP tools. Review the actual tool descriptions and target before writes.

Audit logs and snapshots may contain private church data. Protect the disk and backups; never share the installed folder as a ZIP. Use `node scripts/package.mjs` to export the allowlisted source files. Restore is best effort and can fail because of changed data or foreign keys; it is not a database backup.

Remote MCP: a bearer secret is full access to that deployment. Use TLS, keep it out of logs, and rotate it after exposure. This example is single-operator; do not share one endpoint credential with an entire team. Public multi-user service needs independently audited OAuth and per-user authorization. No live church access is used by offline tests.
