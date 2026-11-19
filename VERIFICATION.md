# Verification — 2026-11-03

- Upstream origin/main re-fetched and confirmed at `b46b2aff5b2c7f80930f260fe56f20d209578633`.
- All 55 original MCP tools retained; get_build_guide added for 56 total tools; stdio and HTTP handshakes tested against a local fake Rock server.
- HTTP rejects unauthenticated requests; both supported credential transport forms tested. No live Rock request made by these tests.
- Dynamic layout, HTML BlockType and Page EntityType resolution tested with deliberately different IDs; ambiguous metadata fails before writes.
- 14 offline suites pass, including source regression tests, preview/restore behavior, SQL rejection, transport, dynamic IDs and syntax/CLI startup.
- Source ZIP extracted into a fresh directory with spaces in its path, without Git history, credentials, node_modules or generated config. Full installer succeeds, compiles MCP, installs project skills and browser tools; the same 14 suites pass.
- Playwright Chromium actually launches, opens a local test page and reads its title.
- Tests/install run on macOS with Node 26.7.0. Windows/Linux were not executed locally.
- Both npm dependency audits report zero known vulnerabilities after updating the inherited lockfile.
- Release scanner checks tracked paths, secret patterns and original organization references; only UPSTREAM.json intentionally identifies the original source repository. ZIP entry inspection confirms no runtime secrets, logs, local config, dependencies or .git directory.
- Missing development credentials cause the launcher to fail; no production fallback or unrelated credential import.

Not claimed: connectivity, permissions or browser rendering on the recipient's church; a real remote deployment/TLS/DNS test; Docker image execution (Docker unavailable on the build host); feature support for every Rock version/client plan. Follow SETUP.md's live checks before using those capabilities.

## Chat and Work support added in v1.1.0

The private tunnel profile, environment isolation, app-ID normalization, no-local-MCP plugin packaging, guide delivery and trusted binary download selection are covered by the added chatgpt.mjs suite. All 14 suites pass. The tunnel-client installer downloaded the current official release and verified its published SHA256. The existing local tunnel-client also passed profile validation and established healthy/ready status with the authorized account.

Live read-only calls to get_build_guide and list_campuses succeeded through the installed custom plugin in a Chat conversation and a separate Work conversation on the authorized account. These are integration checks for this account, not a claim that the recipient's unconfigured church/account is already connected. No Rock data was written by the checks.

## Private GitHub change log added in v1.2.0

- Included first-run guide, private repository template and `scripts/setup-changelog.mjs`.
- All 15 offline suites passed, including local Git initialization in a path with spaces, rejection of existing folders/invalid repository names, open/cancel bundle lifecycle, private-only GitHub command arguments and privacy readback failure handling with a stubbed GitHub CLI, and delivery of the guide through MCP.
- No test repository was created on GitHub and no Rock records were changed. Actual GitHub creation occurs during the recipient's signed-in onboarding.

## Version 1.3.0 guidance — 2026-11-08

Documentation and skill changes (skills, reference, ops, config examples), plus the MCP-served guides re-synced from the updated skills. Results from 2026-11-08:

- `cd mcp && npm run build` completed cleanly.
- `cd mcp && npm test` passed 16 of 16 suites. That run now includes `test/offline/run-all.mjs` (9 of 9 files passed when also run on its own).
- An earlier run the same day exited 1 at 14 of 15 suites. The failing suite was `test/verify-mining-batch.mjs`, not `verify-fixes.mjs`: its two verify-step checks called `rockCreate` with a stub that had no schema, so the new SQL preflight refused first ('Table AttributeValue was not found in the database'). The test was out of date with the preflight, not a regression in the verify messages; its stub now answers the preflight's schema query and both checks pass.
- `mcp/guides/build.md`, `query.md` and `access.md` are byte copies of `skills/rock-build`, `skills/rock-query` and `skills/rock-grant-access`, so `get_build_guide` serves the 1.3.0 guidance. No guide or shipped document names a dev host or a private memory.
- `node scripts/package.mjs --check` passed (193 tracked files after staging the new MCP and test files; release paths and secret patterns clean).
- The 19.8 REST, Lava/text, nested-record (#7144) and WorkflowActionType (#6954) field notes are tagged `traced` only: they come from release notes and issue trackers and were not tested live.
- No Rock server was contacted for these changes.

## Version 1.3.0 MCP write safety — 2026-11-08

- Every write tool requires a `reason`; older data tools preview before update/remove and ledger creates for `rock_restore`; 25-row bulk cap with `allowBulk`; refusals ledgered; read-back `verified` on every write; `flush_cache` ledgered.
- `mode:"sql"` preflight and Auth lockout guard. Time stamps use `ROCK_TIMEZONE` (a Windows time-zone id); with it unset, `GETDATE()` is refused with instructions and no time columns are added. Nothing assumes a particular zone.
- Offline coverage: 9 new suites under `mcp/test/offline/` (two-phase, bulk cap, bundle gate, creates and restore, schemas, SQL preflight, SQL row guard, Auth guard, security-role restore), all passing inside `npm test`.
- The upstream installation live-tested the same safety layer against its own development Rock 19.8.1 server on 2026-11-08; that test is not a claim about your church's server. Run your own dev checks per SETUP.md.

## Version 1.4.0 — 2026-11-19

- `cd mcp && npm run build` completed cleanly; `npm test` passed 16 of 16 suites, and `test/offline/run-all.mjs` passed 10 of 10 files, including the new `role-member-and-next-step.test.mjs` (24 checks: role adds refused without the endpoint, routed to it with person/group/reason when set, no v1 REST or SQL write, read-back and undo id, reactivation says it cannot be undone by rock_restore; next-step text, including the real uncertain-outcome note; merged-record warning).
- `get_build_guide` returned content for `build`, `build-cache-flush`, `build-pages-and-blocks` and `access` from `dist/`. `mcp/guides/build.md` and `build-*.md` are byte copies of `skills/rock-build/SKILL.md` and its `reference/` files; `query.md` and `access.md` are byte copies of their skills.
- The rock-build split was checked line by line: every non-blank line of the 812-line guide appears in the new `SKILL.md` or a reference file.
- The role-member endpoint's Lava was tested on one installation's sandbox and production (19.8.1). This kit's copy adds one guard after an independent review (a reason containing `[[` or `]]` is refused, since it would be parsed as entity-command markup); that guard was not run against a server for this release.
- No Rock server was contacted for these changes.
