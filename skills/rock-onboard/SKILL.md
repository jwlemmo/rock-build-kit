---
name: rock-onboard
description: Install and configure this portable Rock Build Kit for a new church, including Claude/Codex clients, browser REST keys and permission setup, capability checks, and optional remote MCP hosting.
---
# Onboard a church

Resolve the kit root from KIT-LOCATION.txt if this skill was installed; otherwise use this repository. Read AGENTS.md, START-HERE.md, SETUP.md, SECURITY.md and the installer --help.

1. Ask only for missing essentials: actual Rock URL, sandbox availability, desired clients, OS/host, and administrator access. Inspect local Node/npm/client availability without reading unrelated secrets. Install dependencies and build with scripts/install.mjs. Keep existing client configurations intact.
2. Use the available browser tool on the URL supplied by the user. Let the user handle sign-in/MFA. Inspect menus and current permissions before acting. Follow SETUP.md's browser bootstrap and endpoint matrix. A human-approved administrator grant is required; don't give all controllers unrestricted access by default. Initial setup can proceed without the MCP because the browser is separate.
3. Have the user enter the REST key directly in an ignored env file or secret store. Do not request the key in chat. Discover actual version, REST identity, roles, controllers, IDs, and Lava-command setting. Explain global Sql scope before changing it.
4. Run read-only doctor and metadata discovery. Diagnose auth vs route vs plugin vs Sql availability independently. Save the capability result locally without member data. Resolve missing permissions in the browser and retest.
5. Register clients explicitly; generated config contains paths, not keys. For local Cowork inspect plugin support, not only Desktop Chat config. For plain web chat deploy the included HTTP server only to the user's authorized host; inspect bearer/OAuth support before connecting. Use official docs linked in SETUP.md if UI differs.
6. Report installed clients, successful tests, unconfigured environments and remaining administrator/hosting inputs. Never claim live rendering or permission checks passed unless actually observed. Invite the first build only after this checklist, and identify the exact target.
