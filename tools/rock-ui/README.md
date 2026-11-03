---
name: rock-ui
description: Use the included browser helper or a signed-in browser to clear Rock cache, run jobs, resave routes/shortcodes and refresh permissions on the selected church.
---
# Browser operations
For initial REST-key and permission setup, use the client's signed-in browser and SETUP.md. The helper below requires an already-authorized key, ROCK_UI_PERSON_ID and impersonation access.

From the kit root:
```
node tools/rock-ui/rock-ui.mjs cache clear
node tools/rock-ui/rock-ui.mjs job run "Job Name" --wait --timeout 600
node tools/rock-ui/rock-ui.mjs route save <PageRouteId>
node tools/rock-ui/rock-ui.mjs shortcode save <LavaShortcodeId>
node tools/rock-ui/rock-ui.mjs security resave page <PageId>
```
Default dev uses mcp/.env.dev; explicit --prod uses mcp/.env. Use numeric IDs discovered here. UI routes/selectors vary by Rock version; when automation cannot verify a control, inspect the browser rather than guessing. Job runs and security resaves have real effects; use authorized scope. Security resave temporarily toggles a rule and restores it, so prefer a normal admin save/cache clear when possible. Verify all rules after the action. Browser logs are private.
