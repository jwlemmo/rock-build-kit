# MCP server

55 inherited Rock tools plus get_build_guide (56 total), stdio and Streamable HTTP. Chat and Work setup is in ../CHATGPT-WORK.md. Build with `npm ci && npm run build`; offline tests `npm test` (includes the write-safety suites in `test/offline/`, also runnable alone with `npm run test:offline`). Use `../scripts/run.mjs --env dev` for local launch so credentials and logs are isolated. Read ../SETUP.md before connecting. The source is included; no private MCP package or original machine is needed.

Write rules (reason required, two-phase edits, bulk cap, SQL preflight, Auth lockout guard) are summarized in ../TOOLS.md. Set `ROCK_TIMEZONE` to your Rock server's Windows time-zone id (for example `Eastern Standard Time`) so SQL writes can stamp times correctly; without it, GETDATE-style SQL is refused and audit times are not filled in.
