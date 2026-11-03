/**
 * Tags Tools for Rock RMS.
 *
 * Tags are lightweight labels you can attach to any entity (most commonly Person).
 * Each Tag is scoped to an EntityTypeId. There are organizational tags (no owner)
 * and personal tags (ownerPersonAliasId set).
 *
 * The existing add_person_tag / remove_person_tag tools (in people.ts) handle
 * applying/removing tags to a Person. This module provides discovery.
 */

import { RockClient } from '../rock-client.js';

function lq(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function whereAnd(clauses: Array<string | undefined>): string | undefined {
  const kept = clauses.filter((c): c is string => !!c && c.length > 0);
  return kept.length === 0 ? undefined : kept.join(' && ');
}

// Cache: friendly entity-type name → entity type id
const entityTypeIdCache = new Map<string, number>();
async function resolveEntityTypeId(client: RockClient, name: string): Promise<number | undefined> {
  const key = name.toLowerCase();
  if (entityTypeIdCache.has(key)) return entityTypeIdCache.get(key);
  const fq = name.includes('.')
    ? name
    : `Rock.Model.${name.charAt(0).toUpperCase()}${name.slice(1)}`;
  const matches = await client.v2Search<Array<{ id: number; name: string }>>('entityTypes', {
    where: `Name == ${lq(fq)} || FriendlyName == ${lq(name)}`,
    limit: 1,
  });
  if (Array.isArray(matches) && matches.length > 0) {
    entityTypeIdCache.set(key, matches[0].id);
    return matches[0].id;
  }
  return undefined;
}

// ---------------- list_tags ----------------

export interface ListTagsParams {
  entityType?: string;
  entityTypeId?: number;
  name?: string;
  organizationalOnly?: boolean;
  isActive?: boolean;
  limit?: number;
}

export const listTagsSchema = {
  name: 'list_tags',
  description:
    'List available Tags. Defaults to organizational (no owner) tags for the Person entity. ' +
    'Filter by entity type (e.g. "Person", "Group"), name substring, etc.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      entityType: { type: 'string', description: 'Entity type friendly name (default: "Person")' },
      entityTypeId: { type: 'number', description: 'Entity type id (overrides entityType)' },
      name: { type: 'string', description: 'Tag name substring' },
      organizationalOnly: {
        type: 'boolean',
        description: 'When true (default), only org tags (no ownerPersonAliasId)',
      },
      isActive: { type: 'boolean', description: 'Filter by active status (default: true)' },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
  },
};

export async function listTags(client: RockClient, params: ListTagsParams): Promise<unknown> {
  let entityTypeId = params.entityTypeId;
  if (!entityTypeId) {
    entityTypeId = await resolveEntityTypeId(client, params.entityType ?? 'Person');
  }

  const organizationalOnly = params.organizationalOnly ?? true;
  const isActive = params.isActive ?? true;

  const where = whereAnd([
    entityTypeId !== undefined ? `EntityTypeId == ${entityTypeId}` : undefined,
    params.name ? `Name.Contains(${lq(params.name)})` : undefined,
    organizationalOnly ? `OwnerPersonAliasId == null` : undefined,
    `IsActive == ${isActive ? 'true' : 'false'}`,
  ]);

  return client.v2Search('tags', {
    where,
    sort: 'Name',
    limit: params.limit ?? 100,
  });
}
