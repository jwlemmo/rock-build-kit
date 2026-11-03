/**
 * Write-safety module barrel.
 *
 * Enforces the team rule "create = light, edit/delete = stop":
 *   - every write is attributed (gitIdentity) and recorded (audit ledger, manifest)
 *   - edits/deletes capture a before-snapshot and run impact analysis, then require a
 *     deterministic confirmation token (two-phase handshake)
 */

export * from './types.js';
export { resolveGitIdentity } from './gitIdentity.js';
export { checkBundleGate, isDevTarget, changelogOpenDir, BUNDLE_GATED_TOOLS } from './bundleGate.js';
export { appendAudit, writeSnapshotFile, AUDIT_FILE, SNAPSHOT_DIR } from './audit.js';
export { readManifest, recordCreated, MANIFEST_FILE } from './manifest.js';
export { deriveToken, validateToken } from './confirm.js';
export { captureRestSnapshot, captureSqlSnapshot } from './snapshot.js';
export { runImpact, normalizeEntityType, type ImpactTarget } from './impact.js';
export {
  readLedgerRecords,
  readLedgerRecordsWithTally,
  recordsForAuditId,
  findLedgerRecord,
  laterWritesToTarget,
  loadSnapshot,
  type LedgerReadResult,
  type LaterWrite,
  type LoadedSnapshot,
} from './ledger.js';
