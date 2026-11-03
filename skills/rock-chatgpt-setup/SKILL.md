---
name: rock-chatgpt-setup
description: Connect a church's Rock Build Kit to both ChatGPT Chat and Work through a private Secure MCP Tunnel, then install its connected skills plugin.
---
# Set up Rock in Chat and Work
Read CHATGPT-WORK.md at the kit root. If already connected, use get_build_guide to load instructions from the server; do not require access to the local repository. Do not assume Codex's local registration makes the server usable in web Chat.

For first setup, use a local execution host with browser access. Verify the user's intended Rock environment, Platform organization and ChatGPT workspace. Run the kit installer and read-only doctor. Install or reuse the official tunnel-client. Keep the Rock key and the separate OpenAI runtime key in their own ignored local files. Create a dedicated tunnel in the intended Platform organization and associate the intended ChatGPT workspace; reuse only a tunnel dedicated to this connection. Runtime needs Tunnels Read and Use, creators need Read and Manage.

Initialize and run scripts/chatgpt-tunnel.mjs. Check healthz, readyz, and a live read-only Rock tool. Keep the runtime supervised on an awake host. In ChatGPT Plugins, create a custom MCP server with Connection: Tunnel and the exact tunnel; for the stdio-backed private server, choose No authentication at this inner layer (the tunnel has its own identity/access controls). Install the created plugin. Test get_build_guide and list_campuses in a new Chat conversation and a separate Work conversation. Do not claim success until the tool is actually called in each mode.

Use the actual app ID to run prepare-chatgpt-plugin.mjs. It builds a skills-plus-app package with no local .mcp.json or mcp.json (to avoid Desktop only). Import it through supported Plugin Creator/workspace import flows, preserving the registered app. Never publish a real church's keys, tunnel profile or app binding in the generic kit. If account policy blocks custom MCP or tunnel association, identify the exact blocked checkpoint and continue independent package work.
