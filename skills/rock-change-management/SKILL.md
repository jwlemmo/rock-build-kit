---
name: rock-change-management
description: Record and review Rock changes in local bundles before sandbox builds and production promotion.
---
# Rock change management
For first-time setup, resolve the kit root and follow CHANGELOG-SETUP.md. Use scripts/setup-changelog.mjs and the included templates/changelog repository, verify private GitHub visibility and a tracking-only record before any build. Web-only clients need separate GitHub access or a local execution host.
Set ROCK_CHANGELOG_DIR locally to a dedicated folder. Open a bundle with `node ops/rock-change-management/change.mjs open slug "Title" operator@example.org`. Record the actual objects, target, IDs, before state, audit IDs, intended deltas, verification and rollback plan in the JSON file. Do not put secrets or member data in Git.

Build and test on the sandbox; record browser evidence. Before promotion, rediscover production IDs, compare actual state to the expected before state, show the exact delta and dependencies for review, and execute only the authorized change. A sandbox database copy does not guarantee equal IDs later. Stop if the before state differs. Mark the bundle pushed only after production verification; use cancel when intentionally abandoned.

The optional MCP gate requires ROCK_REQUIRE_CHANGE_BUNDLE=1 and ROCK_DEV_HOST matching the configured sandbox host. It checks for an open bundle for the operator; it does not implement automatic promotion or replace review. The JSON log is process evidence; the MCP audit ledger contains the authoritative operations/restore references.
