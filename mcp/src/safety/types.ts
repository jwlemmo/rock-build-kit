/**
 * Shared types for the write-safety layer.
 *
 * These back the three guarded write tools (rock_create / rock_edit / rock_delete)
 * and the safety module that enforces the team rule: "create = light, edit/delete = stop".
 */

export type Verb = 'create' | 'edit' | 'delete';
export type Mode = 'rest' | 'sql';

/**
 * Who performed a write, from the operator's git identity. When each operator has their own
 * Rock REST key, Rock also records the write against that person; the git
 * identity is stamped on every ledger record so the local ledger says who ran it too.
 */
export interface GitIdentity {
  email: string;
  name: string;
  source: 'git' | 'env' | 'unknown';
}

/** A canonical, restart-stable description of an intended write — the basis for the confirmation token. */
export interface WriteOp {
  verb: Verb;
  mode: Mode;
  controller?: string; // REST controller, e.g. "Blocks"
  id?: string | number; // target id for edit/delete (rest)
  table?: string; // SQL table for sql writes
  body?: unknown; // REST body for create/edit
  sql?: string; // SQL statement for sql writes
  /**
   * Why the write is being made. Part of the token, so changing the reason between preview and
   * execute needs a fresh preview. When omitted, deriveToken uses the reason of the write call
   * in progress (see safety/writeGuard.ts), so every tool's token covers its reason.
   */
  reason?: string;
}

/** A captured before-state (the revert source for edits/deletes). */
export interface SnapshotResult {
  ref: string; // repo-relative path under logs/snapshots/, or 'inline'
  capturedAt: string; // ISO
  kind: 'rest' | 'sql';
  data: unknown; // the captured before-state (full row(s))
}

export interface ImpactReference {
  kind: string; // what kind of dependent, e.g. "Block", "Report", "ActiveWorkflowInstance"
  detail?: string; // human description
  count?: number; // when the query is a count
  items?: unknown[]; // sample rows
}

/** Result of the pre-edit/delete reference analysis ("what might this break"). */
export interface ImpactResult {
  ran: boolean; // false when no catalog entry exists for the entity type
  summary: string; // one-line human summary
  references: ImpactReference[];
  queriesRun: string[]; // the SELECTs executed, for transparency
}

/** One append-only audit ledger record (logs/changes.jsonl). */
export interface AuditRecord {
  auditId: string;
  ts: string;
  /**
   * 'denied' = a write call that was refused before anything was written (missing reason, bulk
   * cap, token mismatch, bundle gate, SQL preflight...). Denied records are never restore
   * candidates: findLedgerRecord / laterWritesToTarget / list mode only look at the other phases.
   */
  phase: 'create' | 'preview' | 'executed' | 'denied';
  operator: GitIdentity;
  /**
   * Optional per-call session identifier, so "did my session touch prod?" is answerable
   * without enumerating your own auditIds and diffing against everyone else's. `operator`
   * only ever carries the git identity of whoever set up this Mac's Rock MCP config —
   * it is the SAME value for every concurrent Claude Code session, scheduled task, and build
   * script on the box, so it cannot distinguish "my session" from "a different session
   * running at the same time" (see reference/rock-sessions-lessons L4/L3 for the incident
   * this caused: 20 auditIds from one session had to be manually diffed against 68 same-day
   * prod entries from other sessions).
   *
   * Investigated and rejected as unreliable, in order:
   *   1. Env vars the harness passes at MCP-server spawn — `ps eww <pid>` against a live
   *      rock-v2 process shows ONLY ROCK_API_URL/ROCK_API_KEY (and ROCK_LOGS_DIR for
   *      rock-dev) reach the child process; no session-identifying var is inherited even
   *      though the launching CLI process itself has one (CLAUDE_CODE_SESSION_ID) —
   *      whatever spawns MCP subprocesses does not forward it.
   *   2. MCP `initialize` handshake `clientInfo` — per the SDK's own schema
   *      (InitializeRequestSchema), clientInfo is only {name, version, title, description,
   *      websiteUrl, icons}. It identifies the CLIENT APPLICATION ("claude-code", a CLI
   *      version) which is identical across every session on this machine — not a
   *      per-conversation id. `_meta` on the initialize/tool-call requests carries only a
   *      progressToken and an unrelated task-linkage field, neither of which is a stable
   *      per-session identifier a server could rely on.
   * With neither signal available, this field is caller-supplied (see `session_tag` on each
   * write tool's params) — best-effort, present only when the caller passes one. Skills/
   * CLAUDE.md should tell sessions to pass their Claude session id here on write calls.
   */
  sessionTag?: string;
  tool: string;
  verb: Verb;
  mode: Mode;
  target: { entityType: string; id?: string | number; table?: string };
  snapshotRef?: string;
  impactSummary?: string;
  payload?: unknown;
  confirmationToken?: string;
  /** Why the write was made (required on every write tool since 2026-11). */
  reason?: string;
  /** phase 'denied' only: why the call was refused. */
  denial?: string;
  /**
   * How (or whether) rock_restore can undo this record. Absent = the generic plans in
   * rock-restore.ts apply. supported:false makes rock_restore refuse with `why`.
   * kind:'attribute-value' = set a Person attribute back to `value` (set_person_attribute).
   */
  undo?:
    | { supported: false; why: string }
    | { supported: true; how: string; kind?: 'attribute-value'; personId?: number; key?: string; value?: string };
  result: {
    success: boolean;
    newId?: string | number;
    rowsAffected?: number;
    error?: string;
    /** true when a re-read after the write confirmed it landed; false when it did not or could not. */
    verified?: boolean;
  };
}
