/**
 * Attendance Tools for Rock RMS — v2 endpoints (Linq.Dynamic where expressions).
 */

import { RockClient } from '../rock-client.js';
import { runLegacyWrite } from '../safety/index.js';
import { idFrom, createdRowExists, CREATE_CALL_PROPS, CREATE_NOTE, type WriteCallParams } from './legacy-helpers.js';

function whereAnd(clauses: Array<string | undefined>): string | undefined {
  const kept = clauses.filter((c): c is string => !!c && c.length > 0);
  return kept.length === 0 ? undefined : kept.join(' && ');
}

/** Format a YYYY-MM-DD or ISO timestamp into a Linq.Dynamic DateTime("...") literal. */
function dt(iso: string): string {
  return `DateTime("${iso}")`;
}

// -----------------------------
// search_attendance
// -----------------------------

export interface SearchAttendanceParams {
  personId?: number;
  groupId?: number;
  startDate?: string;
  endDate?: string;
  limit?: number;
}

export const searchAttendanceSchema = {
  name: 'search_attendance',
  description: 'Search attendance records by person, group, or date range',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'Filter by Person ID' },
      groupId: { type: 'number', description: 'Filter by Group ID' },
      startDate: { type: 'string', description: 'Start date for date range filter (YYYY-MM-DD or ISO 8601)' },
      endDate: { type: 'string', description: 'End date for date range filter (YYYY-MM-DD or ISO 8601)' },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 50)' },
    },
  },
};

export async function searchAttendance(
  client: RockClient,
  params: SearchAttendanceParams
): Promise<unknown> {
  // Attendance is linked to PersonAlias (not Person), so resolve alias IDs first.
  let personClause: string | undefined;
  if (params.personId !== undefined) {
    const aliases = await client.v2Search<Array<{ id: number }>>('personaliases', {
      where: `PersonId == ${params.personId}`,
      limit: 50,
    });
    if (!aliases || aliases.length === 0) {
      return [];
    }
    const ids = aliases.map((a) => a.id);
    personClause = `(${ids.map((id) => `PersonAliasId == ${id}`).join(' || ')})`;
  }

  const where = whereAnd([
    personClause,
    params.groupId !== undefined ? `Occurrence.GroupId == ${params.groupId}` : undefined,
    params.startDate ? `StartDateTime >= ${dt(params.startDate)}` : undefined,
    params.endDate ? `StartDateTime <= ${dt(params.endDate)}` : undefined,
  ]);

  return client.v2Search('attendances', {
    where,
    limit: params.limit ?? 50,
    sort: 'StartDateTime descending',
  });
}

// -----------------------------
// record_attendance
// -----------------------------

export interface RecordAttendanceParams extends WriteCallParams {
  personId: number;
  groupId: number;
  scheduleId?: number;
  locationId?: number;
  startDateTime: string;
  didAttend?: boolean;
}

export const recordAttendanceSchema = {
  name: 'record_attendance',
  description:
    'Record an attendance entry for a person in a group in Rock RMS. ' +
    'startDateTime should be ISO 8601 format (e.g., "2026-04-12T09:00:00"). ' +
    'didAttend defaults to true.' + CREATE_NOTE,
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person ID' },
      groupId: { type: 'number', description: 'The Group ID' },
      scheduleId: { type: 'number', description: 'Schedule ID (optional)' },
      locationId: { type: 'number', description: 'Location ID (optional)' },
      startDateTime: { type: 'string', description: 'Attendance date/time in ISO 8601 format' },
      didAttend: { type: 'boolean', description: 'Whether the person attended (default: true)' },
      ...CREATE_CALL_PROPS,
    },
    required: ['personId', 'groupId', 'startDateTime', 'reason'],
  },
};

export async function recordAttendance(
  client: RockClient,
  params: RecordAttendanceParams
): Promise<unknown> {
  return runLegacyWrite('record_attendance', params, async () => {
    const person = await client.v2Get<{ primaryAliasId: number }>(`people/${params.personId}`);

    const occurrenceDate = params.startDateTime.split('T')[0];
    const occurrences = await client.v2Search<Array<{ id: number }>>('attendanceoccurrences', {
      where: `GroupId == ${params.groupId} && OccurrenceDate == ${dt(occurrenceDate)}`,
      limit: 1,
    });
    const existingOccurrenceId = occurrences && occurrences.length > 0 ? occurrences[0].id : null;
    const occurrenceBody = {
      GroupId: params.groupId,
      OccurrenceDate: occurrenceDate,
      ScheduleId: params.scheduleId ?? null,
      LocationId: params.locationId ?? null,
    };

    return {
      verb: 'create',
      entityType: 'Attendance',
      rowCount: existingOccurrenceId == null ? 2 : 1,
      intended: {
        person: params.personId,
        group: params.groupId,
        startDateTime: params.startDateTime,
        occurrence: existingOccurrenceId ?? { create: occurrenceBody },
      },
      apply: async () => {
        // v2 writes on Attendance / AttendanceOccurrence enforce per-entity edit and require
        // extra non-nullable fields; v1 is permissive with the same REST key.
        let occurrenceId: number;
        const extraCreates: Array<{ entityType: string; id: number; body: unknown; label: string }> = [];
        if (existingOccurrenceId != null) {
          occurrenceId = existingOccurrenceId;
        } else {
          const id = idFrom(await client.v1Post<unknown>('AttendanceOccurrences', occurrenceBody));
          if (id == null) throw new Error('AttendanceOccurrences POST returned no Id; no attendance was recorded.');
          occurrenceId = id;
          extraCreates.push({ entityType: 'AttendanceOccurrence', id, body: occurrenceBody, label: 'AttendanceOccurrence' });
        }

        const attendanceId = idFrom(
          await client.v1Post<unknown>('Attendances', {
            OccurrenceId: occurrenceId,
            PersonAliasId: person.primaryAliasId,
            StartDateTime: params.startDateTime,
            DidAttend: params.didAttend ?? true,
          })
        );

        return {
          result: {
            success: true,
            message: `Recorded attendance for person ${params.personId} in group ${params.groupId}`,
            attendanceId,
            occurrenceId,
          },
          newId: attendanceId ?? undefined,
          extraCreates,
          readBack: () => createdRowExists(client, 'Attendances', attendanceId),
        };
      },
    };
  });
}
