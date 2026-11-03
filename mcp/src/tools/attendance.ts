/**
 * Attendance Tools for Rock RMS — v2 endpoints (Linq.Dynamic where expressions).
 */

import { RockClient } from '../rock-client.js';

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

export interface RecordAttendanceParams {
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
    'didAttend defaults to true. Always confirm with the user before calling.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person ID' },
      groupId: { type: 'number', description: 'The Group ID' },
      scheduleId: { type: 'number', description: 'Schedule ID (optional)' },
      locationId: { type: 'number', description: 'Location ID (optional)' },
      startDateTime: { type: 'string', description: 'Attendance date/time in ISO 8601 format' },
      didAttend: { type: 'boolean', description: 'Whether the person attended (default: true)' },
    },
    required: ['personId', 'groupId', 'startDateTime'],
  },
};

export async function recordAttendance(
  client: RockClient,
  params: RecordAttendanceParams
): Promise<unknown> {
  const person = await client.v2Get<{ primaryAliasId: number }>(`people/${params.personId}`);

  const occurrenceDate = params.startDateTime.split('T')[0];
  const occurrences = await client.v2Search<Array<{ id: number }>>('attendanceoccurrences', {
    where: `GroupId == ${params.groupId} && OccurrenceDate == ${dt(occurrenceDate)}`,
    limit: 1,
  });

  // v2 writes on Attendance / AttendanceOccurrence enforce per-entity edit and require
  // extra non-nullable fields; v1 is permissive with the same REST key.
  let occurrenceId: number;
  if (occurrences && occurrences.length > 0) {
    occurrenceId = occurrences[0].id;
  } else {
    occurrenceId = await client.v1Post<number>('AttendanceOccurrences', {
      GroupId: params.groupId,
      OccurrenceDate: occurrenceDate,
      ScheduleId: params.scheduleId ?? null,
      LocationId: params.locationId ?? null,
    });
  }

  const attendanceId = await client.v1Post<number>('Attendances', {
    OccurrenceId: occurrenceId,
    PersonAliasId: person.primaryAliasId,
    StartDateTime: params.startDateTime,
    DidAttend: params.didAttend ?? true,
  });

  return {
    success: true,
    message: `Recorded attendance for person ${params.personId} in group ${params.groupId}`,
    attendanceId,
    occurrenceId,
  };
}
