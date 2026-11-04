# Our Rock change log

Private review history for our church's Rock changes. This repository does not deploy to Rock or replace the MCP audit ledger.

1. Read AGENTS.md before editing. Sync the repository before opening a bundle.
2. From the Rock Build Kit, run `node ops/rock-change-management/change.mjs open short-slug "Change title" operator@example.org` with ROCK_CHANGELOG_DIR set to this repository's absolute path.
3. Fill in the JSON record under open/: exact environment, affected objects/IDs, intended delta, sanitized before-state summary, dependencies, verification and rollback plan. Keep personal data and raw snapshots in approved local storage; record only references here.
4. Review and commit only the intended record. Push it for team review. An open record is not deployment approval.
5. Build/test in the sandbox. Rediscover production IDs and review current state before an authorized production change.
6. Only after successful production verification, run `node ops/rock-change-management/change.mjs pushed short-slug` from the kit. For abandoned work use `cancel short-slug`. Commit the new changes/ record AND deletion from open/ in one commit, then push.

This process requires a local agent/execution host or a GitHub connector with the necessary repository access. A web conversation with only the Rock MCP cannot write this repository.
