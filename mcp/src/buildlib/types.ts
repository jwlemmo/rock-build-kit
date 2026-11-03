/**
 * Shared types for src/buildlib/ — see index.ts for the module overview.
 */

import type { RockClient } from '../rock-client.js';

/** Options for createBuildContext(). */
export interface BuildContextOptions {
  /** Short, stable slug for this build script (e.g. "room-calendar", "new-hire-onboarding").
   *  Stamped onto created rows' ForeignKey (unless the row already declares one) and used
   *  as the manifest section / ledger tool suffix, so runs of the same script stay
   *  idempotent and distinguishable in the ledger from MCP-tool writes. */
  projectSlug: string;
  /** Defaults to createRockClient(). Tests inject a mock (see test/verify-buildlib.mjs). */
  client?: RockClient;
  /** Defaults to false. false = DRY-RUN: every write method logs the operation it WOULD
   *  perform and returns { dryRun: true, ... } WITHOUT calling Rock or the ledger — the
   *  corpora's `--go` convention (13-cleanup-test-data.mjs:16, deploy.mjs:14-19,
   *  `writes` gate at deploy.mjs:245/261). Pass true (usually via parseBuildArgs(argv).go)
   *  to actually write. */
  go?: boolean;
  /** Optional default label recorded in the audit ledger for every write from this
   *  context (individual calls may override via their own opts.label). */
  label?: string;
}

/** Parsed CLI args, per parseBuildArgs(). */
export interface ParsedBuildArgs {
  /** true iff argv contains "--go" (the corpora's write-gate flag). */
  go: boolean;
  /** Every other argv token (after node/script path), for the script's own flag handling. */
  flags: string[];
}

/** Returned by create(). */
export interface CreateResult {
  id: number | string;
  auditId: string;
}

/** Returned by patch(). */
export interface PatchResult {
  auditId: string;
  snapshotRef: string;
}

/** Returned by ensure(). */
export interface EnsureResult {
  id: number | string;
  created: boolean;
  auditId?: string;
}

/** One resolved MetricPartition-style row target for upsertAttributeValue (SQL-probe result). */
export interface UpsertAttributeValueResult {
  id: number | string;
  created: boolean;
  auditId: string;
}

/** Returned by touchAndFlush(). */
export interface TouchAndFlushResult {
  auditId: string;
  kind: 'htmlcontent' | 'workflowtype';
  id: number;
}

/** Returned by updateBlockContent(). */
export interface UpdateBlockContentResult {
  newHtmlContentId: number | string;
  version: number;
  createAuditId: string;
  flushAuditId: string;
}

/** One row written by lockToGroups()/widenAccess(). */
export interface AuthRowResult {
  id: number | string;
  auditId: string;
}

/** Returned by lockToGroups(). */
export interface LockToGroupsResult {
  rows: AuthRowResult[];
}

/** Returned by widenAccess(). */
export interface WidenAccessResult {
  auditId: string;
  id: number | string;
  order: number;
  movedDenyToBottom?: { authId: number | string; newOrder: number };
}

/** Returned by createWorkflowAction(). */
export interface CreateWorkflowActionResult {
  id: number;
  guid: string;
  auditId: string;
  reminder: string;
}

/** A dry-run stand-in returned by every write method when the context's `go` is false. */
export interface DryRunResult {
  dryRun: true;
  op: string;
  detail: Record<string, unknown>;
}
