# Rock in ChatGPT Chat and Work

This is the main ChatGPT setup path for version 1.1.0. A local Codex registration alone does not connect web Chat or web Work. The setup below gives both modes the same registered MCP app and all 56 tools: the 55 inherited Rock tools plus `get_build_guide`.

## Recommended: private Secure MCP Tunnel

A host that can reach your Rock site runs this kit and OpenAI's official tunnel-client. The tunnel opens an outbound connection to OpenAI and forwards MCP over local stdio. No public port, DNS, TLS certificate, Docker deployment or API key in a URL is needed. The host must stay awake and the tunnel process must stay healthy for web/mobile requests.

You need your own Rock REST key plus a separate OpenAI **Platform runtime key** with Tunnels Read + Use. A ChatGPT login/subscription is not itself that key. The person creating the tunnel needs Tunnels Read + Manage. Associate the tunnel with both the intended Platform organization and the intended ChatGPT workspace. Access remains subject to the account's custom-plugin and workspace policies.

### 1. Install and connect Rock locally

Run `node scripts/install.mjs` and follow SETUP.md's browser REST bootstrap. Create `mcp/.env.dev` or `mcp/.env` using only your church's values. Verify with `node scripts/doctor.mjs --env dev` (or explicit `prod`). No Rock write is needed for connection testing.

### 2. Install tunnel-client

If already installed, run `tunnel-client help quickstart`. Otherwise:

```sh
node scripts/install-tunnel.mjs
```

The installer downloads only the matching official binary from [OpenAI's latest release](https://github.com/openai/tunnel-client/releases/latest), verifies the GitHub-published SHA256, and extracts it into ignored `local/bin`. Automatic extraction needs Python 3; manual download is also supported. It does not create a tunnel or account.

### 3. Create your dedicated tunnel in the browser

Open [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels). Create a tunnel named for your church/environment. Select the organization and your ChatGPT workspace. Copy the non-secret `tunnel_...` ID. Do not reuse an unrelated integration's tunnel.

In [Platform runtime API keys](https://platform.openai.com/settings/organization/api-keys), use a runtime key with Tunnels Read + Use. Use neither a Rock key nor an OpenAI admin key here. Enter it privately in the next file or use a macOS Keychain reference. Never paste keys in chat.

Create `local/openai-dev.env` or `local/openai-prod.env` from `config/openai-tunnel.env.example`:

```dotenv
CONTROL_PLANE_TUNNEL_ID=tunnel_your_id
CONTROL_PLANE_API_KEY=enter-your-runtime-key-privately
# TUNNEL_CLIENT_BIN=/absolute/path/to/tunnel-client
```

On macOS, `CONTROL_PLANE_KEYCHAIN_SERVICE=your-keychain-service` can replace the literal key. The script uses your logged-in username for the Keychain account. Each process reads only its explicitly selected environment file.

### 4. Start and verify the connection

```sh
node scripts/chatgpt-tunnel.mjs init --env dev
node scripts/chatgpt-tunnel.mjs doctor --env dev
node scripts/chatgpt-tunnel.mjs run --env dev
```

Keep `run` open. In another terminal run `node scripts/chatgpt-tunnel.mjs status --env dev`. Both `healthz` and `readyz` must report 200. The status command also prints the local admin UI address. Inspect the UI's MCP discovery result; it must contain `get_build_guide` and `list_campuses`. A healthy process alone is not proof of a working Rock key.

On macOS, after foreground validation, stop that foreground process and run `node scripts/chatgpt-tunnel.mjs service --env dev` to install a user LaunchAgent. It starts at login and restarts after failure. Then run status again. On Linux/Windows, supervise the same `run` command with your service manager. Do not start two pollers for the same single-host profile while testing. Store only paths/reference names in service configuration, not literal keys.

### 5. Create and install the ChatGPT app

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins) in the same workspace associated with the tunnel.
2. Choose **+ → Add custom MCP server**. Name it **Rock Builder — your church**.
3. Under **Connection**, select **Tunnel** and the exact Rock tunnel. With this private stdio-backed connection, select **No authentication** for the inner MCP server: OpenAI tunnel access and the local runtime key provide the transport authorization. This does not mean exposing Rock or an unauthenticated public HTTP server.
4. Review the capabilities/risk notice and choose **Create as a plugin**. Install the resulting private plugin. Keep it personal unless your administrator authorizes wider access.
5. If the tunnel is absent, fix the workspace association and Tunnels Read + Use; do not substitute a public URL or put a key in a URL.

### 6. Verify separately in Chat and Work

Start a **new Chat** conversation, mention the installed plugin with `@`, and send:

> Call get_build_guide with topic start, then list_campuses with isActive true. Report the connected church and the result. Do not change any Rock records.

Then start a **new Work** conversation and send the same prompt with the same plugin. Verify an actual tool result in **each** mode. A reply that merely describes the tools or says it can use them does not count. For the first build ask it to call `get_build_guide` with topic build. This loads the bundled instructions even when Chat cannot read the local folder.

Record both results locally, without member data. Check the plugin's action permissions before a write; the server preserves its own edit/delete/restore preview-token gates. The tunnel does not expand the underlying Rock key permissions.

### 7. Bundle the skills with your registered app

The live tools now work in Chat and Work. To install the richer skill package as well, copy your app ID from the created plugin's details/URL and run:

```sh
node scripts/prepare-chatgpt-plugin.mjs --app-id asdk_app_YOUR_ACTUAL_ID
```

The script also accepts a `plugin_asdk_app_...` ID or its ChatGPT URL and removes the `plugin_` prefix for `.app.json`. It generates `local/chatgpt-marketplace/plugins/rock-build-kit` containing skills, references, a supported manifest, and the registered app mapping. It deliberately includes no `.mcp.json`, `mcp.json`, local command, secret or lifecycle hook; raw MCP declarations can cause a Desktop only label.

To upload directly in ChatGPT, run `node scripts/package-chatgpt-plugin.mjs` (requires Python 3), then **Plugins → + → Upload plugin archive**, select `local/rock-build-kit-chatgpt-plugin.zip`, review and install the private plugin. Verify that it uses the existing Rock app and is not marked Desktop only. The upload option may depend on workspace permissions.

For a local desktop catalog, add `local/chatgpt-marketplace` using `codex plugin marketplace add /absolute/path/to/local/chatgpt-marketplace`, refresh the desktop Plugins Directory, and install **Rock Build Kit**. This is a local convenience, not a way to publish to web Chat.

For your workspace's web Chat/Work, use **@Plugin Creator** to create/update a private skill plugin with these skill/reference files and the existing registered app. Administrators can instead import a private GitHub copy of the generated marketplace through **Admin → Plugins → Add → Import marketplace**. This needs GitHub access and does not carry over automatically from a local install. Confirm it is not labeled Desktop only, install it, then repeat both mode tests. Do not put your church-specific `.app.json` into the generic kit supplied to another church.

## Alternate: hosted HTTPS

The Docker/Caddy example remains for clients that accept its authentication. ChatGPT's custom-MCP form currently documents OAuth, no authentication, or mixed OAuth. A bare fixed bearer token is not an OAuth implementation, and an API-key-in-URL workaround is not the recommended ChatGPT setup. For a public hosted endpoint, add a reviewed OAuth 2.1 gateway/provider and test the real sign-in flow. This kit does not claim to supply that gateway. Prefer the private stdio tunnel above for this use case.

## What is and is not automatic

The scripts build tools, install the official tunnel binary, prepare a profile, supervise it on macOS, check health, and package an existing app's skills. The user's organization/workspace selection, account access, runtime key entry, and ChatGPT app installation remain real account setup. The agent can help in the signed-in browser. Installing a ZIP alone does not create those accounts or permissions.

Official references checked November 3, 2026: [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels), [Add custom MCP server](https://developers.openai.com/api/docs/guides/custom-mcp-server), [Plugin packaging](https://developers.openai.com/plugins/build/plugins), [Workspace import](https://learn.chatgpt.com/docs/enterprise/plugin-management), [Chat and Work plugin use](https://learn.chatgpt.com/docs/build-plugins).
