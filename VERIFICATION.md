# Verification — 2026-11-03

- Upstream origin/main re-fetched and confirmed at `b46b2aff5b2c7f80930f260fe56f20d209578633`.
- All 55 MCP tools retained and enumerated; stdio and HTTP handshakes tested against a local fake Rock server.
- HTTP rejects unauthenticated requests; both supported credential transport forms tested. No live Rock request made by these tests.
- Dynamic layout, HTML BlockType and Page EntityType resolution tested with deliberately different IDs; ambiguous metadata fails before writes.
- 13 offline suites pass, including source regression tests, preview/restore behavior, SQL rejection, transport, dynamic IDs and syntax/CLI startup.
- Source ZIP extracted into a fresh directory with spaces in its path, without Git history, credentials, node_modules or generated config. Full installer succeeds, compiles MCP, installs project skills and browser tools; the same 13 suites pass.
- Playwright Chromium actually launches, opens a local test page and reads its title.
- Tests/install run on macOS with Node 26.7.0. Windows/Linux were not executed locally.
- Both npm dependency audits report zero known vulnerabilities after updating the inherited lockfile.
- Release scanner checks tracked paths, secret patterns and original organization references; only UPSTREAM.json intentionally identifies the original source repository. ZIP entry inspection confirms no runtime secrets, logs, local config, dependencies or .git directory.
- Missing development credentials cause the launcher to fail; no production fallback or unrelated credential import.

Not claimed: connectivity, permissions or browser rendering on the recipient's church; a real remote deployment/TLS/DNS test; Docker image execution (Docker unavailable on the build host); feature support for every Rock version/client plan. Follow SETUP.md's live checks before using those capabilities.
