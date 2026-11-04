# Setup for your church

## 1. Install locally

Requirements: Node.js **22+** (LTS recommended), npm, internet access for packages, and a local agent that can run commands. Git is optional for ZIP users. Windows, macOS, and Linux use the same Node installer. Linux may need Playwright system libraries installed by an administrator.

```sh
node scripts/install.mjs
```

This builds the MCP with `npm ci`, installs the browser helper and Chromium, creates ignored credential examples, generates project `.mcp.json` and client config snippets in `local/`, and installs self-contained copies of the skills in `.claude/skills/` and `.agents/skills/`. Existing local credential files are preserved. No Rock calls happen during installation. Use `--skip-browser` on a headless host or `--skip-skills` if importing the plugin. `--register codex`, `--register claude`, or `--register both` adds local user MCP entries via the installed CLI (existing same-name entries cause a stop; use their settings to resolve the conflict). Registration happens only when selected.

The server name is `rock-rms-v2` for production and `rock-rms-dev` for development. Production registration is not a default target for helper scripts. The generated entries explicitly select an environment. Restart/reload the client after registration. Keep this folder in a permanent location; moving it requires regenerating the configuration.

## 2. Browser bootstrap — before there is an API key

Your agent should use the browser tooling available in its own client. Sign in yourself, including SSO/MFA, to your **own church's** Rock administrator account. The included rock-ui helper cannot bootstrap its own permissions; it requires a key and impersonation rights already set up. If your agent has no browser control, it should give you the same steps to perform.

1. Record your Rock base URL and actual version. Check Admin Tools or `GET /api/Utility/GetRockSemanticVersionNumber`. Record whether a sandbox exists. Never assume a production key works on a sandbox. Ask your hosting administrator if a sandbox must be provisioned.
2. In Admin Tools → Security, locate **REST Keys** (use the admin search if menu names differ). Create a dedicated named REST identity/key for this operator/integration. Use the UI's REST-key creation, not a normal person's password. Keep a distinct production key and dev key. Copy the secret straight into the local file editor; do not send it through chat or an agent tool transcript.
3. Create a dedicated security-role group for the builder. Add the REST identity to it. Discover the identity and group's real IDs by their names in the UI. Do not assume an existing administrator role automatically grants v2 access.
4. Locate **REST Controllers** / REST API Security. Grant only the needed controller actions to that role. Start with read access and the matrix below. Review effective allow/deny ordering and entity security. Classic page access is separate from REST access. For building, expand permissions explicitly with the church's administrator.
5. Under System Settings → **Global Attributes**, inspect **Default Enabled Lava Commands**. The full SQL/build features require `Sql` for `/api/Lava/RenderTemplate`. This affects more than this key. Explain that scope and obtain the administrator's approval before enabling; append to the existing list, never replace other commands. First test ordinary Lava rendering, then `SELECT 1 AS Ready`. If the church does not permit SQL-through-Lava, leave it disabled: many entity REST tools still work, but full builder/schema/restore features will be limited.
6. Save permissions/settings and clear the applicable cache through the admin UI. Test with the actual integration key, not the browser's administrator session.

### Which endpoints are needed?

These are **native Rock routes**. You normally grant access to existing endpoints; do not create duplicate controller rows or a custom public SQL endpoint. Use the site's REST documentation (often `/api/docs`), controller UI, and actual responses to identify installed routes. V2 availability varies with Rock version. Plugins such as Room Management are optional.

| Purpose | Existing route family / controller | Initial access |
|---|---|---|
| Version, identity, metadata | Utility; People/GetCurrentPerson; EntityTypes, DefinedTypes, DefinedValues, Campuses | Read |
| SQL/schema, build impact and restore | POST `/api/Lava/RenderTemplate` with Sql enabled | Privileged render permission; review scope |
| Read entities | `/api/v2/models/{entity}/search` (POST); v1 `/api/{Controller}` fallback where implemented | Exact v2 read action shown in UI; typically ExecuteUnrestrictedRead; classic View |
| Build pages | Pages, Blocks, BlockTypes, HtmlContents, PageRoutes, Layouts | Reads plus classic create/edit; apply only when building approved |
| Workflows | WorkflowTypes, WorkflowActivityTypes, WorkflowActionTypes, WorkflowActionForms, Workflows/WorkflowEntry | Appropriate read/write; action insertion may use guarded SQL |
| Metrics | Metrics, MetricPartitions, MetricValues, Categories | Read; writes when needed |
| Permission configuration | Auths, Groups, GroupMembers, RestControllers, EntityTypes | Administrator only during provisioning |
| Optional browser helper | People/GetImpersonationParameter and the operator's admin pages | Explicit impersonation permission; otherwise use signed-in browser manually |
| Optional feature tools | People, PhoneNumbers, Locations, GroupLocations, Attendance, Steps, Notes, Tags, Communications, ContentChannels, ContentChannelItems, Schedules, Reservations | Match each actual feature; Reservations needs the church's plugin |

In v2, inspect all listed actions (including restricted vs unrestricted read/write). Names and semantics differ from v1 View/Edit. `401` can mean either missing/invalid credentials **or** insufficient permissions; compare a known working route before diagnosing. Granting page View alone does not grant API access. No blanket all-controller grants are required by the installer.

A genuinely missing **custom** endpoint needs server-side Rock plugin development/deployment; it cannot be implemented by inventing a row in REST Controllers. See `ops/rock-plugin-deploy/`. The agent should first check whether an existing native endpoint already solves the task.

## 3. Local credentials

The installer creates `mcp/.env.dev.example` and `mcp/.env.example`. Create **only the environments you actually have** as `mcp/.env.dev` and `mcp/.env`. Enter values with your editor:

```dotenv
ROCK_API_URL=https://rock-dev.your-church.example/api
ROCK_API_KEY=replace-locally
ROCK_OPERATOR_EMAIL=builder@your-church.example
ROCK_OPERATOR_NAME=Your Name
# Optional, only for the headless browser helper:
ROCK_UI_PERSON_ID=your-real-person-id
```

The files contain dotenv data, never shell commands. The launcher loads exactly the chosen file without reading other clients' configs, isolates logs by target, and requires an HTTPS URL ending in `/api`. It refuses placeholder hosts/keys. If you only have production, run tools with `--env prod` / browser helper `--prod` explicitly. Don't put the production URL into a dev file.

## 4. Register your client

- **Claude Code:** trust this folder and approve its generated `.mcp.json`, or run `node scripts/install.mjs --skip-browser --register claude` for user scope. Read `CLAUDE.md`.
- **Codex:** run `node scripts/install.mjs --skip-browser --register codex`; or merge `local/codex.toml` into your user `~/.codex/config.toml`. The CLI and app share this user config. Reopen the chat and read `AGENTS.md`.
- **Claude Desktop Chat:** merge `local/claude-desktop.json` into the existing config, preserving unrelated entries. Typical paths: macOS `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows `%APPDATA%/Claude/claude_desktop_config.json`. Restart the app. Do not assume these entries appear in Cowork.
- **Claude Cowork:** import this folder as a local plugin using `.claude-plugin/plugin.json` where local plugins are supported. Keep `.mcp.json` generated in the folder. Otherwise use the remote connector below. Give Cowork access to this folder and read START-HERE.md.
- **ChatGPT Work:** when running on a local/remote execution host with local MCP support, install on that host and register there. A local folder attachment alone is not a remote server connection. For ordinary ChatGPT, use the remote route below.

If your client does not support loading custom skills, attach START-HERE.md, AGENTS.md, and the relevant skill/reference documents as project instructions/files. The remote server also provides core safety instructions in its MCP initialization response.

## 5. Read-only validation

```sh
node scripts/doctor.mjs --env dev
node scripts/discover.mjs --env dev
```

Doctor tests version, identity, v2 campus read, plain Lava, and SQL `SELECT 1`, without creating/updating records or printing returned member data. Each failed capability is reported separately. Discover writes ignored local metadata to `local/discovery-dev.json`: layouts, HTML block types, entity types, and controller metadata. It does not dump people or gifts. If metadata access is denied, discover the IDs in the browser instead.

Then ask the client to list tools and call `list_campuses`. Confirm the reported target. Offline verification is `cd mcp && npm test`. Once you approve a test build, create a disposable page beneath a reviewed parent, verify its content and effective permissions in the browser, and use the guarded restore preview to remove it. Never test by editing a real person or gift.

## 6. Private GitHub change log

Follow [CHANGELOG-SETUP.md](CHANGELOG-SETUP.md) to create your church's private repository, connect each operator and host, verify a tracking-only record, and optionally enable the sandbox bundle prerequisite. The setup helper and complete repository template are included.

## 7. Web and Work connections

**For ChatGPT Chat and Work use [CHATGPT-WORK.md](CHATGPT-WORK.md)**. That is the supported private-tunnel/plugin path and includes separate verification in both modes. The older hosted HTTP option below is useful for compatible clients; it does not implement OAuth for ChatGPT.

### Optional hosted HTTPS connector

The included server supports Streamable HTTP with a separate MCP bearer secret. Use your own always-on host reachable by your client, DNS, and TLS. The Docker example uses Caddy HTTPS. Keep the Rock key only on the server. The bearer secret is a different random secret (32+ random bytes recommended). Remote access has the permissions of that single configured operator; use separate deployments/keys for different users or churches.

```sh
node scripts/prepare-remote.mjs
# Edit ignored deploy/.env with your domain, Rock URL, Rock key, and operator.
docker compose --env-file deploy/.env -f deploy/compose.yml up --build -d
```

The preparation script generates a random MCP secret locally and never prints it. HTTPS is terminated by Caddy; only ports 80/443 are published. Persisted logs need backup/access controls. Ensure the Docker volume is writable by UID 1000 (the image's node user). Check `https://YOUR_DOMAIN/healthz`, then run `node scripts/verify-remote.mjs https://YOUR_DOMAIN/mcp` with `MCP_BEARER_TOKEN` provided securely in the environment. This verifies the MCP handshake and tool listing, without writing to Rock.

For clients that explicitly support fixed bearer credentials, configure the HTTPS endpoint and enter the secret privately. Do not assume a fixed bearer header or secret URL works in ChatGPT's custom MCP form. Use CHATGPT-WORK.md's tunnel setup for ChatGPT, or provide a reviewed OAuth gateway for a public server. Account/workspace policy still applies.

## Sources checked for this edition

- [Rock Admin Hero Guide: REST keys, v1/v2 permissions](https://www.rockrms.com/documentation/bookcontent/9)
- [Codex MCP configuration](https://developers.openai.com/codex/mcp)
- [ChatGPT custom MCP / developer mode](https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt)
- [Claude local vs remote connectors](https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors)

Account UIs and Rock versions change. Inspect the live UI; do not silently treat an unavailable capability as installed.
