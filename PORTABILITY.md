# Portability and provenance

Based on the latest upstream default-branch commit fetched on 2026-11-03: `b46b2aff5b2c7f80930f260fe56f20d209578633`. The original repository is identified only in UPSTREAM.json. This repository starts a new history and contains no original .git directory, local configuration, keys, logs, or dev data dumps.

Retained: every MCP tool implementation, build library, validators, preview tokens, audit/snapshot/restore system, schema/OpenAPI reference, offline regression tests, full construction recipes, Lava/attribute CLI tools, optional graphify skill, and browser cache/job/route/shortcode/security helpers.

Adapted: page layout, HTML block and Page entity IDs are discovered before writes; phone/address/tag IDs resolve by metadata; metric SQL-source type resolves by name; dev bundle gate is configured rather than bound to an original host; launcher uses explicit credentials and separate target logs. Added local installer, browser bootstrap skill, read-only doctor/discovery, MCP transport tests, release scanner/packager, and HTTPS deployment.

Replaced: live person-specific smoke tests and dev snapshots with offline tests and a data-minimal doctor; private reference histories with portable guides; church-specific Azure VM/database deployment/sanitization scripts with documented host-specific procedures and portable packaging/planning helpers. They cannot safely be universal executable scripts because they depend on a particular plugin, host topology, database, backup policy, and integration inventory. No original tenant/server names or credentials are required. The missing upstream Codex launcher is replaced by a cross-platform Node launcher.

Upstream observations came from Rock 17–19-era installations. Not every endpoint works on every version, nor is a full v1 fallback implemented for every tool. Discover actual capabilities; do not call a missing plugin a setup failure. `reference/` documents retained observations, not guarantees about your church. Pin and review future upstream changes before importing; never copy upstream config/data blindly.

Version 1.1.0 adds the private Secure MCP Tunnel workflow, real Chat/Work plugin manifests, per-church app-binding generator, and a read-only get_build_guide tool served by MCP. Church-specific tunnel IDs, app IDs and keys are generated only under ignored local paths.

Version 1.2.0 adds guided per-church private GitHub change-log setup, a fresh repository template, privacy verification, and a changelog guide available through MCP. It contains no preconfigured repository owner or church credentials.

## Version 1.3.0 — 2026-11-08

Adds church-neutral guidance learned on Rock 19.8.1. Measured facts are labeled "observed on Rock 19.8.1" (one installation, one date); they do not assume your church runs that version.

- Field notes gain a provenance tier on newer entries (`measured` | `traced` | `summarized`, plus "verified on <version>, <date>"), the 19.8.1 observations (the Lava `/-` block-comment trap, int-vs-string `==`, truthiness and `AsInteger`, security-role membership by raw SQL vs `{% modifygroupmember %}`, REST refusing role membership), the 19.8 REST and Lava changes (traced from release notes and issue trackers, not tested live), field-validation logging, the v20/v21 removals, AI agent chat retention, MCP agent notes, and a "From other Rock builders" section restated in this kit's own words with attribution to the public repositories.
- rock-build: prompt-injection rule, required `reason` and two-phase data edits, bulk cap, SQL preflight rules, a configured time-zone rule (`ROCK_TIMEZONE`, a Windows time-zone name; no default zone is assumed), Spark's SQL insert checklist, workflow, cache, entity-command and Lava traps, agent tool conventions, and a Lava Applications recipe.
- rock-query: SQL performance and schema shortcuts. rock-grant-access: Auth ordering, `NOT EXISTS` record-level guards, `EntityId = 0`, no core self-lockout protection, test as a normal staff user, 19.8 REST hardening.
- rock-change-management and rock-test: reason on writes, and pre-promotion checks (versions, low-rights test, field-validation log, 19.8 REST rules, security review) recorded in the church's own change-log bundle. The existing configurable bundle gate and runtime ID discovery are unchanged.
- `config/.env.example` documents `ROCK_TIMEZONE` and `ROCK_MCP_BULK_WRITE_MAX`.

No church-specific IDs, hosts, people or counts were imported.

## Version 1.4.0 — 2026-11-19

Adds church-neutral lessons from 2026-11-09 to 2026-11-18. Measured facts are again labeled "observed on Rock 19.8.1" (one installation).

- MCP: every write result and refusal ends with a next step for the agent (`src/safety/nextStep.ts`). `execute_sql` adds a `mergedRecordWarning` when a giving or attendance query filters on one `PersonAliasId`. `add_group_member` routes security-role groups through an optional admin-only Lava endpoint (`ROCK_ROLE_MEMBER_ENDPOINT`, source and setup in `ops/rock-role-member-endpoint/`) and refuses them without it, instead of a v1 REST call Rock rejects. New offline suite `role-member-and-next-step.test.mjs`.
- rock-build: split into a short `SKILL.md` plus ten topic files under `skills/rock-build/reference/`, following Anthropic's skill guidance (short main file, detail read on demand, contents lists on long files). Text moved verbatim. `get_build_guide` serves each topic as `build-<topic>`. New rules: lock View, Edit and Administrate together (with a page-chain query to find inherited Edit), an explicit Deny All Users also locks out admins, staff pages must work on phones and in Rock's dark mode, filter person records on `PersonId`, Spark-style tool answers.
- rock-change-management: two extra checks when locking a page or block to a short list, and a phone/dark-mode check for staff pages. rock-grant-access and rock-query match.
- rock-sandbox-refresh: "Lessons from real refreshes" — guide-only rule, sandbox-only work, data age and version checks, copy and file-move traps, production domains still in the restored database, SMS/push mediums and jobs that stay on, and putting the financial gateway in test mode.
- Field notes: five new observations from 19.8.1.

No church-specific IDs, hosts, people or counts were imported.
