# Portability and provenance

Based on the latest upstream default-branch commit fetched on 2026-11-03: `b46b2aff5b2c7f80930f260fe56f20d209578633`. The original repository is identified only in UPSTREAM.json. This repository starts a new history and contains no original .git directory, local configuration, keys, logs, or dev data dumps.

Retained: every MCP tool implementation, build library, validators, preview tokens, audit/snapshot/restore system, schema/OpenAPI reference, offline regression tests, full construction recipes, Lava/attribute CLI tools, optional graphify skill, and browser cache/job/route/shortcode/security helpers.

Adapted: page layout, HTML block and Page entity IDs are discovered before writes; phone/address/tag IDs resolve by metadata; metric SQL-source type resolves by name; dev bundle gate is configured rather than bound to an original host; launcher uses explicit credentials and separate target logs. Added local installer, browser bootstrap skill, read-only doctor/discovery, MCP transport tests, release scanner/packager, and HTTPS deployment.

Replaced: live person-specific smoke tests and dev snapshots with offline tests and a data-minimal doctor; private reference histories with portable guides; church-specific Azure VM/database deployment/sanitization scripts with documented host-specific procedures and portable packaging/planning helpers. They cannot safely be universal executable scripts because they depend on a particular plugin, host topology, database, backup policy, and integration inventory. No original tenant/server names or credentials are required. The missing upstream Codex launcher is replaced by a cross-platform Node launcher.

Upstream observations came from Rock 17–19-era installations. Not every endpoint works on every version, nor is a full v1 fallback implemented for every tool. Discover actual capabilities; do not call a missing plugin a setup failure. `reference/` documents retained observations, not guarantees about your church. Pin and review future upstream changes before importing; never copy upstream config/data blindly.
