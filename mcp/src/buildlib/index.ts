/**
 * src/buildlib/ — a shared Rock build-script library, compiled to dist/buildlib/ and
 * imported by plain .mjs build scripts (NOT an MCP tool — nothing here is wired into
 * src/index.ts or the tool inventory).
 *
 * Why this exists: the source church has two proven Rock build-script corpora —
 * ~/new-hire-onboarding/build/ (modular: rock.mjs/wf.mjs/refs.mjs/task.mjs) and
 * ~/room-calendar/build/deploy.mjs (single-file) — and every new script re-implements
 * the same idioms (ensure-or-create, ForeignKey tagging, the Allow-then-Deny Auth shape,
 * the WorkflowActionType SQL-insert workaround, …) by hand. Batch builds are "Lane B" of
 * the two-lane model — MCP tools (rock_create/rock_edit/…) for interactive/risky single
 * writes, build scripts for batch/scripted builds — but until now, script writes were
 * INVISIBLE to the audit ledger: an MCP write shows up in rock_restore's list, a script
 * write did not. This library closes that gap: every write method here flows through the
 * SAME ledger + snapshot machinery the MCP tools use (src/safety/*), so a build-script
 * write is just as undoable via rock_restore as an MCP one.
 *
 * Architecture (fixed, see the task brief for the full rationale):
 *   - Transport is the repo's existing RockClient (src/rock-client.ts) — this library adds
 *     only the higher-level idioms (ensure/upsert/lock/etc.), never a second fetch wrapper.
 *   - NO retry/backoff wrapper anywhere in this library. Repo policy: never auto-retry a
 *     Rock write (a timed-out POST may still have landed) — RockClient already encodes
 *     this (writes default to zero retries; see rock-client.ts's `request()` comment).
 *   - Every write is ledgered via src/safety/ (appendAudit/writeSnapshotFile/
 *     captureRestSnapshot/recordCreated/resolveGitIdentity), tool: `build-script:
 *     <projectSlug>`. Patches are ledgered in the EXACT shape rock_edit writes
 *     (phase 'executed', payload { label, body }) so rock_restore's classifyRestore can
 *     patch them back with no special-casing — see the restore-compat test in
 *     test/verify-buildlib.mjs.
 *   - DRY-RUN by default (createBuildContext's `go` option, default false): every write
 *     method logs the operation it WOULD perform and returns { dryRun: true, op, detail }
 *     without touching Rock or the ledger. Pass go:true (usually via
 *     parseBuildArgs(process.argv.slice(2)).go, the corpora's `--go` flag) to write for
 *     real.
 *
 * Modules:
 *   - types.ts     shared TS types (BuildContextOptions, per-method result shapes)
 *   - helpers.ts    pure functions: sqlLiteral helpers (esc/bit/sqlVal), localISO (the
 *                   wall-clock, non-UTC datetime formatter Rock's columns need), and the
 *                   log/ok/skip/fail console vocabulary (✓/·/✗)
 *   - args.ts       parseBuildArgs(argv) → { go, flags }
 *   - context.ts    createBuildContext(opts) → BuildContext, with every write method
 *
 * Scope cuts (v1 — not oversights, intentionally deferred):
 *   - No deletes. Bulk-delete through this library is out of scope for this pass; a script
 *     that needs to delete still calls RockClient/rock_delete directly.
 *   - No createTaskActivity composite. new-hire-onboarding/build/wf.mjs + task.mjs's
 *     multi-action "task activity" builder (assignment + form + outcome logic in one call)
 *     is domain-specific to that workflow's shape; porting it here is deferred until a
 *     second consumer needs the same shape.
 *   - No per-block attribute-id resolution helper. Every call site that needs a block's
 *     AttributeId (e.g. setBlockAttr in 04-entry-page.mjs) still looks it up by hand
 *     (or via the MCP's list_attributes) — this library takes attributeId as a plain
 *     number param, it does not resolve Key → Id.
 *   - Block OutputCacheDuration is inconsistently modeled across the corpora: some blocks
 *     set it as a literal REST field on the Blocks POST body (04-entry-page.mjs:34
 *     `OutputCacheDuration: 0`), others as an AttributeValue (deploy.mjs's
 *     cacheDurationAttrId 160, set via a plain AttributeValues POST). This library does
 *     NOT abstract that difference — callers set whichever shape their block type uses,
 *     directly via create()/upsertAttributeValue().
 *   - The corpora themselves (new-hire-onboarding/build/, room-calendar/build/) are NOT
 *     migrated to use this library in this pass — they keep their own rock.mjs/deploy.mjs.
 *     Only FUTURE build scripts are expected to import from dist/buildlib/.
 */

export * from './types.js';
export { esc, bit, sqlVal, localISO, log, ok, skip, fail } from './helpers.js';
export { parseBuildArgs } from './args.js';
export { createBuildContext, type BuildContext } from './context.js';
