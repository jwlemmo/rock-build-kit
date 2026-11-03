# Rock Build Kit — agent entry point
Read START-HERE.md and SETUP.md before installing or connecting. Read PORTABILITY.md before editing kit code.
This is a portable kit for the user's church. Never use another church's URL, key, numeric IDs, people, or hosting account. Never read unrelated local MCP configurations to find credentials.

Use skills/rock-onboard/SKILL.md for installation and browser setup. Use skills/rock-build/SKILL.md before construction, rock-query for reads, rock-grant-access for permissions, and rock-ui for browser-only operations. Resolve skill references from this repository root; installed skill folders include this root in KIT-LOCATION.txt.

Honor the user's authorized scope. Existing-record edits/deletes/restores require the MCP's preview, user review, then the identical call with its token. Some older data-specific tools write immediately; describe their changes before calling. New-object tools also write immediately. execute_sql accepts reads only. SQL-through-Lava is privileged database access; MCP validators are not a database security boundary.

Never put keys in chat, tracked files, screenshots, command arguments, logs, or shell history. Use local ignored mcp/.env files or hosting secrets. Default target is dev; absence of a dev configuration must fail, never fall back to production. Production is explicit. Keep environment audit logs separate.

Run `node scripts/install.mjs --skip-browser` to build and prepare workspace configuration. Full install includes browser binaries. It does not register global clients unless --register is explicitly selected. Use `node scripts/doctor.mjs --env dev` for read-only checks after local credentials exist. Do not run live write tests on real people or gifts. Run `cd mcp && npm test` for offline tests. After builds, verify rendering and effective permissions in the browser. Never claim a friend's instance was verified from offline tests.
