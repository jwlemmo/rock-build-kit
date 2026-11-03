/**
 * Schedules Tools for Rock RMS.
 *
 * Schedules define recurring events (Sunday 9:30 service, Wednesday 6:30 Life Group)
 * and are referenced by Groups, Attendances, and Reservations. The recurrence is
 * stored as an iCalendar string on the Schedule record.
 *
 * Tools:
 *   - list_schedules — search/list schedules
 *   - get_schedule — get a single schedule by id (includes iCal)
 */

import { RockClient } from '../rock-client.js';

function lq(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function whereAnd(clauses: Array<string | undefined>): string | undefined {
  const kept = clauses.filter((c): c is string => !!c && c.length > 0);
  return kept.length === 0 ? undefined : kept.join(' && ');
}

// ---------------- list_schedules ----------------

export interface ListSchedulesParams {
  name?: string;
  isActive?: boolean;
  categoryId?: number;
  limit?: number;
}

export const listSchedulesSchema = {
  name: 'list_schedules',
  description: 'List Schedules. Filter by name, active status, or category.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Schedule name substring' },
      isActive: { type: 'boolean', description: 'Filter by active status' },
      categoryId: { type: 'number', description: 'Restrict to a Category Id (e.g. Service Times)' },
      limit: { type: 'number', description: 'Max results (default 50)' },
    },
  },
};

export async function listSchedules(
  client: RockClient,
  params: ListSchedulesParams
): Promise<unknown> {
  const where = whereAnd([
    params.name ? `Name.Contains(${lq(params.name)})` : undefined,
    params.isActive !== undefined ? `IsActive == ${params.isActive ? 'true' : 'false'}` : undefined,
    params.categoryId !== undefined ? `CategoryId == ${params.categoryId}` : undefined,
  ]);
  return client.v2Search('schedules', {
    where,
    sort: 'Order, Name',
    limit: params.limit ?? 50,
  });
}

// ---------------- get_schedule ----------------

export interface GetScheduleParams {
  id: number;
}

export const getScheduleSchema = {
  name: 'get_schedule',
  description: 'Get a single Schedule by id, including its iCalendarContent.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The Schedule Id' },
    },
    required: ['id'],
  },
};

export async function getSchedule(
  client: RockClient,
  params: GetScheduleParams
): Promise<unknown> {
  return client.v2Get(`schedules/${params.id}`);
}
