/**
 * Defined Types / Defined Values Tools for Rock RMS.
 *
 * Defined Values are the universal lookup table for Rock — Connection Statuses,
 * Marital Statuses, Suffixes, Genders, Group Roles, Communication Statuses,
 * Phone Number Types, and hundreds more. Almost every enum-like FK in the schema
 * resolves to a DefinedValueId.
 *
 * Use list_defined_types to find a category, then list_defined_values to see the
 * options. Particularly useful when writing SQL — knowing the DefinedValueId is
 * usually faster than joining DefinedValue to filter by Value text.
 */

import { RockClient } from '../rock-client.js';

function lq(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function whereAnd(clauses: Array<string | undefined>): string | undefined {
  const kept = clauses.filter((c): c is string => !!c && c.length > 0);
  return kept.length === 0 ? undefined : kept.join(' && ');
}

// ---------------- list_defined_types ----------------

export interface ListDefinedTypesParams {
  name?: string;
  category?: string;
  limit?: number;
}

export const listDefinedTypesSchema = {
  name: 'list_defined_types',
  description:
    'List Defined Types (e.g. "Connection Status", "Marital Status", "Phone Number Type"). ' +
    'Filter by name substring or category. Returns the type id you need for list_defined_values.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Substring of the type name (case-insensitive)' },
      category: { type: 'string', description: 'Category name substring (e.g. "Person", "Group")' },
      limit: { type: 'number', description: 'Max results (default 50)' },
    },
  },
};

export async function listDefinedTypes(
  client: RockClient,
  params: ListDefinedTypesParams
): Promise<unknown> {
  const where = whereAnd([
    params.name ? `Name.Contains(${lq(params.name)})` : undefined,
    // Category name filter via navigation: Category.Name.Contains("...")
    params.category ? `Category != null && Category.Name.Contains(${lq(params.category)})` : undefined,
  ]);
  return client.v2Search('definedTypes', {
    where,
    sort: 'Name',
    limit: params.limit ?? 50,
  });
}

// ---------------- list_defined_values ----------------

export interface ListDefinedValuesParams {
  definedTypeId?: number;
  definedTypeName?: string;
  value?: string;
  limit?: number;
}

export const listDefinedValuesSchema = {
  name: 'list_defined_values',
  description:
    'List Defined Values within a Defined Type. Pass definedTypeId (preferred) or ' +
    'definedTypeName (will resolve via list_defined_types). Optionally filter by value text.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      definedTypeId: { type: 'number', description: 'Defined Type ID' },
      definedTypeName: { type: 'string', description: 'Exact Defined Type name (used if definedTypeId omitted)' },
      value: { type: 'string', description: 'Filter values by Value substring' },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
  },
};

export async function listDefinedValues(
  client: RockClient,
  params: ListDefinedValuesParams
): Promise<unknown> {
  let typeId = params.definedTypeId;
  if (!typeId && params.definedTypeName) {
    const matches = await client.v2Search<Array<{ id: number; name: string }>>('definedTypes', {
      where: `Name == ${lq(params.definedTypeName)}`,
      limit: 1,
    });
    if (Array.isArray(matches) && matches.length > 0) {
      typeId = matches[0].id;
    } else {
      return { error: `No Defined Type found with name "${params.definedTypeName}"` };
    }
  }
  if (!typeId) {
    return { error: 'Provide either definedTypeId or definedTypeName' };
  }

  const where = whereAnd([
    `DefinedTypeId == ${typeId}`,
    params.value ? `Value.Contains(${lq(params.value)})` : undefined,
  ]);
  return client.v2Search('definedValues', {
    where,
    sort: 'Order, Value',
    limit: params.limit ?? 100,
  });
}

// ---------------- get_defined_value ----------------

export interface GetDefinedValueParams {
  id: number;
}

export const getDefinedValueSchema = {
  name: 'get_defined_value',
  description: 'Get a single Defined Value by its numeric id.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The DefinedValue Id' },
    },
    required: ['id'],
  },
};

export async function getDefinedValue(
  client: RockClient,
  params: GetDefinedValueParams
): Promise<unknown> {
  return client.v2Get(`definedValues/${params.id}`);
}
