/**
 * Capture the before-state of an entity prior to an edit/delete.
 *
 * The REST capture doubles as the existence check (a 404 means "nothing to edit"). The
 * snapshot is the revert source: for edits we PATCH the old field values back; for deletes
 * we can re-create the row from the captured data.
 */

import { RockClient } from '../rock-client.js';
import type { SnapshotResult } from './types.js';

/** GET controller/{id} via v1. Throws a clear error if the target doesn't exist. */
export async function captureRestSnapshot(
  client: RockClient,
  controller: string,
  id: string | number,
  capturedAt: string
): Promise<SnapshotResult> {
  let data: unknown;
  try {
    data = await client.v1Get<unknown>(`${controller}/${id}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/→\s*404/.test(msg)) {
      throw new Error(`Target ${controller}/${id} not found — nothing to edit/delete.`);
    }
    throw e;
  }
  if (data === null || data === undefined) {
    throw new Error(`Target ${controller}/${id} returned no data — refusing to edit/delete.`);
  }
  return { ref: 'inline', capturedAt, kind: 'rest', data };
}

/** Run a SELECT to capture the rows a SQL UPDATE/DELETE will affect. Refuses on 0 rows. */
export async function captureSqlSnapshot(
  client: RockClient,
  selectSql: string,
  capturedAt: string
): Promise<SnapshotResult> {
  const rows = await client.executeSql<unknown>(selectSql);
  const arr = Array.isArray(rows) ? rows : rows == null ? [] : [rows];
  if (arr.length === 0) {
    throw new Error('Snapshot SELECT matched 0 rows — nothing to edit/delete. Refusing.');
  }
  return { ref: 'inline', capturedAt, kind: 'sql', data: arr };
}
