# Give this folder or repository to your agent

Copy this prompt into **Claude Code, Claude Cowork with local folder access, or Codex/ChatGPT Work with a local execution environment**:

> Set up this Rock Build Kit for my church. Read AGENTS.md, SETUP.md, and skills/rock-onboard/SKILL.md. Inspect what is installed, install the dependencies and skills, then help me configure my own Rock development and production connections. Use my signed-in browser to guide the REST key, controller permissions, and Lava settings setup. Ask me for my church's Rock URL and preferred sandbox. Keep the key out of chat and committed files. Run the read-only doctor and verify the tools before building anything. For ChatGPT Chat and Work, follow CHATGPT-WORK.md: connect a private Secure MCP Tunnel, install the app, and verify actual tool calls separately in both modes. For Claude web chat, use the hosted connection instructions. Tell me precisely which checks passed and which need my administrator.

With plain web chat, upload this ZIP for guidance or connect the GitHub repo. Web chat does not itself install programs on your computer. Start from a local agent for installation, or deploy the remote service in SETUP.md.

The full server source, lockfiles, skills, reference notes, local installer, browser helpers, Docker deployment, and offline tests are included. Your own API key, browser sign-in, allowed client features, network access, and (for remote chat) hosting are the remaining inputs.

For ChatGPT specifically, start with [CHATGPT-WORK.md](CHATGPT-WORK.md). No public server is required with the supported private tunnel path.
