/**
 * Campuses Tools for Rock RMS.
 *
 * Read-only utility for listing all campuses with their core fields. Useful when
 * you need a CampusId for a filter, want a roster of locations, or are looking up
 * a campus's leader/short code.
 */

import { RockClient } from '../rock-client.js';

// ---------------- list_campuses ----------------

export interface ListCampusesParams {
  isActive?: boolean;
}

export const listCampusesSchema = {
  name: 'list_campuses',
  description: 'List all campuses. By default returns only active campuses; pass isActive=false to include inactive.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      isActive: { type: 'boolean', description: 'Filter by active status (default: true)' },
    },
  },
};

export async function listCampuses(
  client: RockClient,
  params: ListCampusesParams
): Promise<unknown> {
  const isActive = params.isActive ?? true;
  return client.v2Search('campuses', {
    where: `IsActive == ${isActive ? 'true' : 'false'}`,
    sort: 'Order, Name',
    limit: 200,
  });
}

// ---------------- get_campus ----------------

export interface GetCampusParams {
  id: number;
}

export const getCampusSchema = {
  name: 'get_campus',
  description: 'Get a single campus by its numeric id with full details (location, leader, short code, etc.).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The Campus Id' },
    },
    required: ['id'],
  },
};

export async function getCampus(
  client: RockClient,
  params: GetCampusParams
): Promise<unknown> {
  return client.v2Get(`campuses/${params.id}`);
}
