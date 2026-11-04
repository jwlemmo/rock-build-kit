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
