/**
 * Attribute Values Tools for Rock RMS.
 *
 * Rock's Attribute system is the universal extension mechanism — custom fields on
 * Person, Group, GroupMember, financial transactions, basically everything. Each
 * Attribute has a Key (camelCase or PascalCase string) and is scoped to an
 * EntityType + optional qualifier (e.g. a specific GroupType).
 *
 * Tools:
 *   - list_attributes — search Attribute definitions
 *   - get_person_attributes — read all attribute values for a person
 *   - set_person_attribute — write one attribute value on a person
 *
 * Person attribute reads via v2: GET /people/{id}?loadAttributes=Expanded returns
 * `attributeValues` keyed by Attribute Key.
 *
 * Person attribute writes via v1: POST /api/People/AttributeValue/{personId}?
 *   attributeKey=...&attributeValue=...
 * (v2 PATCH on per-entity AttributeValue records hits the strict per-entity edit
 * check that returns 401 for the REST key.)
 */

import { RockClient } from '../rock-client.js';

function lq(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function whereAnd(clauses: Array<string | undefined>): string | undefined {
  const kept = clauses.filter((c): c is string => !!c && c.length > 0);
  return kept.length === 0 ? undefined : kept.join(' && ');
}

// ---------------- list_attributes ----------------

export interface ListAttributesParams {
  entityType?: string; // e.g. "Person", "Group", "GroupMember"
  entityTypeId?: number;
  name?: string;
  key?: string;
  categoryName?: string;
  limit?: number;
}

export const listAttributesSchema = {
  name: 'list_attributes',
  description:
    'Search Attribute definitions. Filter by entity type (e.g. "Person", "Group"), name, ' +
    'key, or category. Returns the attribute id, key, name, field type, and qualifier.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      entityType: { type: 'string', description: 'Entity type friendly name (e.g. "Person", "Group", "GroupMember")' },
      entityTypeId: { type: 'number', description: 'Entity type id (overrides entityType)' },
      name: { type: 'string', description: 'Substring of attribute name (case-insensitive)' },
      key: { type: 'string', description: 'Substring of attribute key' },
      categoryName: { type: 'string', description: 'Filter by category name substring' },
      limit: { type: 'number', description: 'Max results (default 50)' },
    },
  },
};

// Best-effort entity-type name → id resolution (cached in-process)
const entityTypeIdCache = new Map<string, number>();
async function resolveEntityTypeId(client: RockClient, name: string): Promise<number | undefined> {
  const key = name.toLowerCase();
  if (entityTypeIdCache.has(key)) return entityTypeIdCache.get(key);
  // Common Rock entity types — short names → fully qualified
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

export async function listAttributes(
  client: RockClient,
  params: ListAttributesParams
): Promise<unknown> {
  let entityTypeId = params.entityTypeId;
  if (!entityTypeId && params.entityType) {
    entityTypeId = await resolveEntityTypeId(client, params.entityType);
    if (!entityTypeId) {
      return { error: `Could not resolve entity type "${params.entityType}"` };
    }
  }

  const where = whereAnd([
    entityTypeId !== undefined ? `EntityTypeId == ${entityTypeId}` : undefined,
    params.name ? `Name.Contains(${lq(params.name)})` : undefined,
    params.key ? `Key.Contains(${lq(params.key)})` : undefined,
    params.categoryName
      ? `Categories.Any(c => c.Name.Contains(${lq(params.categoryName)}))`
      : undefined,
  ]);

  return client.v2Search('attributes', {
    where,
    sort: 'Order, Name',
    limit: params.limit ?? 50,
  });
}

// ---------------- get_person_attributes ----------------

export interface GetPersonAttributesParams {
  personId: number;
  keys?: string[];
}

export const getPersonAttributesSchema = {
  name: 'get_person_attributes',
  description:
    'Get all (or a subset of) Person AttributeValues for a person. Pass keys=[...] to ' +
    'restrict to specific attribute keys. Returns an object keyed by Attribute Key.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person Id' },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional list of attribute keys to restrict to',
      },
    },
    required: ['personId'],
  },
};

export async function getPersonAttributes(
  client: RockClient,
  params: GetPersonAttributesParams
): Promise<unknown> {
  const queryParams: Record<string, string | undefined> = { loadAttributes: 'Expanded' };
  if (params.keys && params.keys.length > 0) {
    queryParams.attributeKeys = params.keys.join(',');
  }
  const person = await client.v2Get<Record<string, unknown>>(
    `people/${params.personId}`,
    queryParams
  );
  const attrs = (person.attributeValues || person.AttributeValues) as Record<string, unknown> | undefined;
  return {
    personId: params.personId,
    attributeValues: attrs ?? {},
  };
}

// ---------------- set_person_attribute ----------------

export interface SetPersonAttributeParams {
  personId: number;
  key: string;
  value: string | number | boolean;
}

export const setPersonAttributeSchema = {
  name: 'set_person_attribute',
  description:
    'Set a Person AttributeValue. Provide attribute key (e.g. "SOM101Completed") and value. ' +
    'Booleans should be passed as "True" / "False" strings to match Rock storage. ' +
    'Always confirm with the user before calling.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person Id' },
      key: { type: 'string', description: 'Attribute Key (case-sensitive)' },
      value: {
        description: 'New value. Numbers/booleans are converted to strings; Rock booleans use "True"/"False".',
      },
    },
    required: ['personId', 'key', 'value'],
  },
};

export async function setPersonAttribute(
  client: RockClient,
  params: SetPersonAttributeParams
): Promise<unknown> {
  const valueStr =
    typeof params.value === 'boolean' ? (params.value ? 'True' : 'False') : String(params.value);
  // v1 endpoint accepts attributeKey & attributeValue as query params
  const path = `People/AttributeValue/${params.personId}?attributeKey=${encodeURIComponent(
    params.key
  )}&attributeValue=${encodeURIComponent(valueStr)}`;
  await client.v1Post(path, {});
  return {
    success: true,
    personId: params.personId,
    key: params.key,
    value: valueStr,
    message: `Set ${params.key} = "${valueStr}" on person ${params.personId}`,
  };
}
