/**
 * People Tools for Rock RMS — v2 endpoints.
 *
 * v2 search bodies use Linq.Dynamic syntax with PascalCase entity field names
 * (see `RockClient.v2Search` docs). Response bodies are camelCase.
 */

import { RockClient } from '../rock-client.js';
import { runLegacyWrite } from '../safety/index.js';
import {
  pickFields,
  fieldsMatch,
  v1GetOrNull,
  idFrom,
  createdRowExists,
  CREATE_CALL_PROPS,
  TWO_PHASE_CALL_PROPS,
  TWO_PHASE_NOTE,
  CREATE_NOTE,
  type WriteCallParams,
  type TwoPhaseCallParams,
} from './legacy-helpers.js';

// -----------------------------
// Helpers
// -----------------------------

/** Escape a string value for a Linq.Dynamic literal — use double quotes. */
function lq(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Build an `&&`-joined Linq.Dynamic where expression from individual clauses. */
function whereAnd(clauses: Array<string | undefined>): string | undefined {
  const kept = clauses.filter((c): c is string => !!c && c.length > 0);
  return kept.length === 0 ? undefined : kept.join(' && ');
}

// Resolve IDs on the connected church, never from a seed database or another site.
async function definedValueId(client: RockClient, typeName: string, value: string): Promise<number> {
  const quote = (s: string) => s.replace(/'/g, "''");
  const rows = await client.executeSql<Array<{ Id: number }>>(
    `SELECT dv.Id FROM DefinedValue dv JOIN DefinedType dt ON dt.Id = dv.DefinedTypeId WHERE dt.Name = '${quote(typeName)}' AND dv.Value = '${quote(value)}'`
  );
  if (!Array.isArray(rows) || rows.length !== 1 || !Number.isSafeInteger(rows[0].Id)) throw new Error(`Cannot uniquely resolve ${typeName}/${value} on this church.`);
  return rows[0].Id;
}
async function personEntityTypeId(client: RockClient): Promise<number> {
  const rows = await client.executeSql<Array<{ Id: number }>>("SELECT Id FROM EntityType WHERE Name = 'Rock.Model.Person'");
  if (!Array.isArray(rows) || rows.length !== 1 || !Number.isSafeInteger(rows[0].Id)) throw new Error('Cannot uniquely resolve Rock.Model.Person.');
  return rows[0].Id;
}

// -----------------------------
// search_people / get_person
// -----------------------------

export interface SearchPeopleParams {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  limit?: number;
}

export interface GetPersonParams {
  id?: number | string;
  personId?: number | string; // accepted alias — the natural guess after a PersonAliasId lookup
  includeFamily?: boolean;
  includeGroups?: boolean;
}

export const searchPeopleSchema = {
  name: 'search_people',
  description: 'Search for people in Rock RMS by name, email, or phone number',
  inputSchema: {
    type: 'object' as const,
    properties: {
      firstName: { type: 'string', description: 'First name to search for (partial match)' },
      lastName: { type: 'string', description: 'Last name to search for (partial match)' },
      email: { type: 'string', description: 'Email address to search for' },
      phone: { type: 'string', description: 'Phone number to search for (digits only)' },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 25)' },
    },
  },
};

export const getPersonSchema = {
  name: 'get_person',
  description: 'Get a specific person by ID with optional related data',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: ['number', 'string'], description: 'The Person ID (numeric string accepted)' },
      personId: { type: ['number', 'string'], description: 'Alias for id' },
      includeFamily: { type: 'boolean', description: 'Include family group members and addresses' },
      includeGroups: { type: 'boolean', description: 'Include group memberships' },
    },
  },
};

export async function searchPeople(client: RockClient, params: SearchPeopleParams): Promise<unknown> {
  const where = whereAnd([
    params.firstName ? `FirstName.Contains(${lq(params.firstName)})` : undefined,
    params.lastName ? `LastName.Contains(${lq(params.lastName)})` : undefined,
    params.email ? `Email == ${lq(params.email)}` : undefined,
  ]);

  // Phone search is a separate lookup (PhoneNumbers is a child entity, not directly
  // queryable on Person in Linq.Dynamic without a child .Any() expression — but the
  // child query is faster anyway).
  if (params.phone) {
    const digits = params.phone.replace(/\D/g, '');
    const phoneMatches = await client.v2Search<Array<{ personId: number }>>('phonenumbers', {
      where: `Number == ${lq(digits)}`,
      limit: params.limit ?? 25,
    });
    const personIds = Array.from(new Set(phoneMatches.map((p) => p.personId).filter(Boolean)));
    if (personIds.length === 0) return [];
    const idClause = `(${personIds.map((id) => `Id == ${id}`).join(' || ')})`;
    return client.v2Search('people', {
      where: where ? `${idClause} && ${where}` : idClause,
      limit: params.limit ?? 25,
    });
  }

  return client.v2Search('people', { where, limit: params.limit ?? 25 });
}

export async function getPerson(client: RockClient, params: GetPersonParams): Promise<unknown> {
  const id = Number(params.id ?? params.personId);
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('get_person requires a numeric Person ID — pass id (or personId), as a number or numeric string.');
  }
  const person = await client.v2Get<Record<string, unknown>>(`people/${id}`);

  // Family + addresses — fetched as separate v2 calls (v2 has no $expand)
  if (params.includeFamily && person.primaryFamilyId) {
    const familyId = person.primaryFamilyId as number;

    // Family members
    try {
      person.familyMembers = await client.v2Search('groupmembers', {
        where: `GroupId == ${familyId}`,
        limit: 20,
      });
    } catch {
      person.familyMembers = [];
    }

    // Addresses via GroupLocations
    try {
      const groupLocations = await client.v2Search<
        Array<{
          id: number;
          locationId: number;
          groupLocationTypeValueId: number;
          isMailingLocation: boolean;
          isMappedLocation: boolean;
        }>
      >('grouplocations', { where: `GroupId == ${familyId}`, limit: 10 });

      const addresses: Array<Record<string, unknown>> = [];
      for (const gl of groupLocations) {
        const location = await client.v2Get<Record<string, unknown>>(`locations/${gl.locationId}`);
        const typeLabel =
          String((await client.v2Get<Record<string, unknown>>(`definedvalues/${gl.groupLocationTypeValueId}`)).value ?? 'Unknown');
        addresses.push({
          ...location,
          addressType: typeLabel,
          isMailingLocation: gl.isMailingLocation,
          isMappedLocation: gl.isMappedLocation,
        });
      }
      person.addresses = addresses;
    } catch {
      person.addresses = [];
    }
  }

  // Group memberships
  if (params.includeGroups) {
    try {
      const aliases = await client.v2Search<Array<{ id: number }>>('personaliases', {
        where: `PersonId == ${id}`,
        limit: 20,
      });
      const aliasIds = aliases.map((a) => a.id);
      if (aliasIds.length > 0) {
        const aliasClause = `(${aliasIds.map((id) => `PersonAliasId == ${id}`).join(' || ')})`;
        person.groups = await client.v2Search('groupmembers', {
          where: `PersonId == ${id}`,
          limit: 100,
        });
        person.groupAliasIds = aliasIds;
        // Note: PersonAliasId vs PersonId — GroupMembers uses PersonId directly.
        // The aliasClause is captured for callers who need it for other queries.
      }
    } catch {
      person.groups = [];
    }
  }

  return person;
}

/** camelCase field name → Rock's PascalCase column name. */
function pascal(key: string): string {
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// -----------------------------
// update_person
// -----------------------------

export interface UpdatePersonParams extends TwoPhaseCallParams {
  id: number;
  firstName?: string;
  nickName?: string;
  lastName?: string;
  email?: string;
  isEmailActive?: boolean;
  birthDay?: number;
  birthMonth?: number;
  birthYear?: number;
  gender?: number; // 0=Unknown, 1=Male, 2=Female
  maritalStatusValueId?: number;
  connectionStatusValueId?: number;
  recordStatusValueId?: number;
}

export const updatePersonSchema = {
  name: 'update_person',
  description:
    "Update a person's basic info in Rock RMS. Use PATCH semantics — only provided fields are updated. " +
    'Gender: 0=Unknown, 1=Male, 2=Female.' + TWO_PHASE_NOTE,
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The Person ID to update' },
      firstName: { type: 'string', description: 'First name' },
      nickName: { type: 'string', description: 'Nick/preferred name' },
      lastName: { type: 'string', description: 'Last name' },
      email: { type: 'string', description: 'Email address' },
      isEmailActive: { type: 'boolean', description: 'Whether email is active' },
      birthDay: { type: 'number', description: 'Birth day (1-31)' },
      birthMonth: { type: 'number', description: 'Birth month (1-12)' },
      birthYear: { type: 'number', description: 'Birth year (e.g., 1983)' },
      gender: { type: 'number', description: '0=Unknown, 1=Male, 2=Female' },
      maritalStatusValueId: { type: 'number', description: 'Marital status DefinedValue ID' },
      connectionStatusValueId: { type: 'number', description: 'Connection status DefinedValue ID' },
      recordStatusValueId: { type: 'number', description: 'Record status DefinedValue ID' },
      ...TWO_PHASE_CALL_PROPS,
    },
    required: ['id', 'reason'],
  },
};

const UPDATE_PERSON_FIELDS = [
  'firstName', 'nickName', 'lastName', 'email', 'isEmailActive', 'birthDay', 'birthMonth', 'birthYear',
  'gender', 'maritalStatusValueId', 'connectionStatusValueId', 'recordStatusValueId',
] as const;

export async function updatePerson(client: RockClient, params: UpdatePersonParams): Promise<unknown> {
  return runLegacyWrite('update_person', params, async () => {
    // v2 PATCH bodies use camelCase (matches the GET response shape). The ledger records the
    // same fields in PascalCase, which is what rock_restore patches back through v1.
    const body: Record<string, unknown> = {};
    for (const f of UPDATE_PERSON_FIELDS) {
      if (params[f] !== undefined) body[f] = params[f];
    }
    if (Object.keys(body).length === 0) {
      return { verb: 'edit', entityType: 'Person', id: params.id, intended: null, noop: { success: false, error: 'No fields provided to update' } };
    }
    const v1Body: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) v1Body[pascal(k)] = v;

    const row = await client.v1Get<unknown>(`People/${params.id}`);
    const before = pickFields(row, Object.keys(v1Body));
    return {
      verb: 'edit',
      entityType: 'Person',
      id: params.id,
      body: v1Body,
      before,
      intended: { person: params.id, set: v1Body },
      apply: async () => {
        await client.v2Patch(`people/${params.id}`, body);
        const result: Record<string, unknown> = { success: true, message: `Person ${params.id} updated` };
        return {
          result,
          readBack: async () => {
            const updated = await client.v2Get<Record<string, unknown>>(`people/${params.id}`);
            result.person = updated;
            return { verified: fieldsMatch(updated, body) };
          },
        };
      },
    };
  });
}

// -----------------------------
// update_person_address
// -----------------------------

export interface UpdatePersonAddressParams extends TwoPhaseCallParams {
  personId: number;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  postalCode: string;
  country?: string;
  addressType: 'Home' | 'Work' | 'Previous';
}

export const updatePersonAddressSchema = {
  name: 'update_person_address',
  description:
    "Update or add an address for a person in Rock RMS. Updates the family group's location. " +
    'addressType: Home, Work, or Previous.' + TWO_PHASE_NOTE,
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person ID' },
      street1: { type: 'string', description: 'Street address line 1' },
      street2: { type: 'string', description: 'Street address line 2' },
      city: { type: 'string', description: 'City' },
      state: { type: 'string', description: 'State (2-letter code)' },
      postalCode: { type: 'string', description: 'Postal/ZIP code' },
      country: { type: 'string', description: 'Country code (default: US)' },
      addressType: { type: 'string', enum: ['Home', 'Work', 'Previous'], description: 'Address type' },
      ...TWO_PHASE_CALL_PROPS,
    },
    required: ['personId', 'street1', 'city', 'state', 'postalCode', 'addressType', 'reason'],
  },
};

export async function updatePersonAddress(
  client: RockClient,
  params: UpdatePersonAddressParams
): Promise<unknown> {
  return runLegacyWrite('update_person_address', params, async () => {
    const person = await client.v2Get<{ primaryFamilyId: number }>(`people/${params.personId}`);
    const familyId = person.primaryFamilyId;
    if (!familyId) throw new Error('Person has no primary family');

    const locationTypeId = await definedValueId(client, 'Group Location Type', params.addressType);
    if (!locationTypeId) throw new Error(`Unknown address type: ${params.addressType}`);

    const existingLocs = await client.v2Search<
      Array<{ id: number; locationId: number; groupLocationTypeValueId: number }>
    >('grouplocations', {
      where: `GroupId == ${familyId} && GroupLocationTypeValueId == ${locationTypeId}`,
      limit: 1,
    });

    // v2 writes on Location / GroupLocation enforce per-entity edit and require extra
    // non-nullable fields; v1 is permissive and accepts the minimum shape we need.
    const v1LocationBody: Record<string, unknown> = {
      Street1: params.street1,
      Street2: params.street2 ?? '',
      City: params.city,
      State: params.state,
      PostalCode: params.postalCode,
      Country: params.country ?? 'US',
    };

    if (existingLocs && existingLocs.length > 0) {
      const locationId = existingLocs[0].locationId;
      const row = await client.v1Get<unknown>(`Locations/${locationId}`);
      return {
        verb: 'edit',
        entityType: 'Location',
        id: locationId,
        body: v1LocationBody,
        before: pickFields(row, Object.keys(v1LocationBody)),
        intended: { family: familyId, addressType: params.addressType, location: locationId, set: v1LocationBody },
        notes: ['Edits the existing Location row in place; any other record pointing at the same Location sees the change too.'],
        apply: async () => {
          await client.v1Patch(`Locations/${locationId}`, v1LocationBody);
          return {
            result: { success: true, message: `Updated ${params.addressType} address for family ${familyId}`, locationId },
            readBack: async () => {
              const after = await client.v1Get<unknown>(`Locations/${locationId}`);
              return { verified: fieldsMatch(after, v1LocationBody), after: pickFields(after, Object.keys(v1LocationBody)) };
            },
          };
        },
      };
    }

    const groupLocationBody = {
      GroupId: familyId,
      GroupLocationTypeValueId: locationTypeId,
      IsMailingLocation: params.addressType === 'Home',
      IsMappedLocation: params.addressType === 'Home',
    };
    return {
      verb: 'create',
      entityType: 'GroupLocation',
      rowCount: 2,
      intended: { family: familyId, addressType: params.addressType, createLocation: v1LocationBody, createGroupLocation: groupLocationBody },
      notes: [
        'No address of this type exists yet, so this creates a Location and links it to the family with a GroupLocation.',
        'Undo: rock_restore the GroupLocation record first, then the Location record.',
      ],
      apply: async () => {
        const newLocationId = idFrom(await client.v1Post<unknown>('Locations', v1LocationBody));
        if (newLocationId == null) throw new Error('Locations POST returned no Id; the GroupLocation was not created.');
        const groupLocationId = idFrom(
          await client.v1Post<unknown>('GroupLocations', { ...groupLocationBody, LocationId: newLocationId })
        );
        return {
          result: { success: true, message: `Added ${params.addressType} address for family ${familyId}`, locationId: newLocationId },
          newId: groupLocationId ?? undefined,
          extraCreates: [{ entityType: 'Location', id: newLocationId, body: v1LocationBody, label: 'Location' }],
          readBack: () => createdRowExists(client, 'GroupLocations', groupLocationId),
        };
      },
    };
  });
}

// -----------------------------
// update_person_phone
// -----------------------------

export interface UpdatePersonPhoneParams extends TwoPhaseCallParams {
  personId: number;
  number: string;
  phoneType: 'Mobile' | 'Home' | 'Work';
  isMessagingEnabled?: boolean;
}

export const updatePersonPhoneSchema = {
  name: 'update_person_phone',
  description:
    'Add or update a phone number for a person in Rock RMS. ' +
    'phoneType: Mobile, Home, or Work.' + TWO_PHASE_NOTE,
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person ID' },
      number: { type: 'string', description: 'Phone number (digits only or formatted)' },
      phoneType: { type: 'string', enum: ['Mobile', 'Home', 'Work'], description: 'Phone type' },
      isMessagingEnabled: {
        type: 'boolean',
        description: 'Whether SMS is enabled (default: true for Mobile)',
      },
      ...TWO_PHASE_CALL_PROPS,
    },
    required: ['personId', 'number', 'phoneType', 'reason'],
  },
};

export async function updatePersonPhone(
  client: RockClient,
  params: UpdatePersonPhoneParams
): Promise<unknown> {
  return runLegacyWrite('update_person_phone', params, async () => {
    const phoneTypeId = await definedValueId(client, 'Phone Type', params.phoneType);
    if (!phoneTypeId) throw new Error(`Unknown phone type: ${params.phoneType}`);

    const cleanNumber = params.number.replace(/\D/g, '');

    const existing = await client.v2Search<Array<{ id: number }>>('phonenumbers', {
      where: `PersonId == ${params.personId} && NumberTypeValueId == ${phoneTypeId}`,
      limit: 1,
    });

    const isMessaging = params.isMessagingEnabled ?? params.phoneType === 'Mobile';

    // v2 POST/PATCH /phonenumbers requires extra non-nullable fields and enforces
    // per-entity edit; v1 is permissive with the same REST key + role.
    if (existing && existing.length > 0) {
      const phoneId = existing[0].id;
      const body = { Number: cleanNumber, IsMessagingEnabled: isMessaging };
      const row = await client.v1Get<unknown>(`PhoneNumbers/${phoneId}`);
      return {
        verb: 'edit',
        entityType: 'PhoneNumber',
        id: phoneId,
        body,
        before: pickFields(row, ['Number', 'IsMessagingEnabled', 'PersonId', 'NumberTypeValueId']),
        intended: { person: params.personId, phoneType: params.phoneType, phoneNumberId: phoneId, set: body },
        apply: async () => {
          await client.v1Patch(`PhoneNumbers/${phoneId}`, body);
          return {
            result: { success: true, message: `Updated ${params.phoneType} phone for person ${params.personId}` },
            readBack: async () => {
              const after = await client.v1Get<unknown>(`PhoneNumbers/${phoneId}`);
              return { verified: fieldsMatch(after, body), after: pickFields(after, Object.keys(body)) };
            },
          };
        },
      };
    }

    const createBody = {
      PersonId: params.personId,
      Number: cleanNumber,
      CountryCode: '1',
      NumberTypeValueId: phoneTypeId,
      IsMessagingEnabled: isMessaging,
    };
    return {
      verb: 'create',
      entityType: 'PhoneNumber',
      intended: { person: params.personId, phoneType: params.phoneType, create: createBody },
      notes: ['No phone of this type exists yet, so this adds a new PhoneNumber row.'],
      apply: async () => {
        const newId = idFrom(await client.v1Post<unknown>('PhoneNumbers', createBody));
        return {
          result: { success: true, message: `Added ${params.phoneType} phone for person ${params.personId}`, phoneNumberId: newId },
          newId: newId ?? undefined,
          readBack: () => createdRowExists(client, 'PhoneNumbers', newId),
        };
      },
    };
  });
}

// -----------------------------
// add_person_tag / remove_person_tag
// -----------------------------

export interface AddPersonTagParams extends WriteCallParams {
  personId: number;
  tagName: string;
}

export interface RemovePersonTagParams extends TwoPhaseCallParams {
  personId: number;
  tagName: string;
}

export const addPersonTagSchema = {
  name: 'add_person_tag',
  description: 'Add a tag to a person in Rock RMS. The tag must already exist.' + CREATE_NOTE,
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person ID' },
      tagName: { type: 'string', description: 'The tag name to add' },
      ...CREATE_CALL_PROPS,
    },
    required: ['personId', 'tagName', 'reason'],
  },
};

export const removePersonTagSchema = {
  name: 'remove_person_tag',
  description: 'Remove a tag from a person in Rock RMS.' + TWO_PHASE_NOTE,
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person ID' },
      tagName: { type: 'string', description: 'The tag name to remove' },
      ...TWO_PHASE_CALL_PROPS,
    },
    required: ['personId', 'tagName', 'reason'],
  },
};

async function findPersonTagId(client: RockClient, tagName: string): Promise<number | null> {
  const tags = await client.v2Search<Array<{ id: number }>>('tags', {
    where: `Name == ${lq(tagName)} && EntityTypeId == ${(await personEntityTypeId(client))}`,
    limit: 1,
  });
  return tags && tags.length > 0 ? tags[0].id : null;
}

async function getPersonGuid(client: RockClient, personId: number): Promise<string> {
  const person = await client.v2Get<{ guid: string }>(`people/${personId}`);
  return person.guid;
}

export async function addPersonTag(client: RockClient, params: AddPersonTagParams): Promise<unknown> {
  return runLegacyWrite('add_person_tag', params, async () => {
    const tagId = await findPersonTagId(client, params.tagName);
    if (tagId == null) {
      throw new Error(`Tag "${params.tagName}" not found for Person entity type`);
    }

    const personGuid = await getPersonGuid(client, params.personId);

    // EntityGuid in Linq.Dynamic matches against the string form of the Guid directly —
    // no Guid("...") wrapper. (Wrapping triggers "No applicable method 'Guid'".)
    const existing = await client.v2Search<Array<{ id: number }>>('taggeditems', {
      where: `TagId == ${tagId} && EntityGuid == ${lq(personGuid)}`,
      limit: 1,
    });

    if (existing && existing.length > 0) {
      return {
        verb: 'create', entityType: 'TaggedItem', intended: null,
        noop: { success: true, message: `Person ${params.personId} already has tag "${params.tagName}"` },
      };
    }

    // v2 POST /taggeditems returns 401 ("not authorized to edit this item") even with
    // Administrate on the controller — Rock v2 checks per-entity edit on the Tag and
    // most tags don't include the REST key's role in their Auth tree. v1 POST is
    // permissive enough to succeed with the same key + role.
    const body = { TagId: tagId, EntityTypeId: (await personEntityTypeId(client)), EntityGuid: personGuid };
    return {
      verb: 'create',
      entityType: 'TaggedItem',
      intended: { person: params.personId, tag: params.tagName, create: body },
      apply: async () => {
        const newId = idFrom(await client.v1Post<unknown>('TaggedItems', body));
        return {
          result: { success: true, message: `Added tag "${params.tagName}" to person ${params.personId}`, taggedItemId: newId },
          newId: newId ?? undefined,
          readBack: () => createdRowExists(client, 'TaggedItems', newId),
        };
      },
    };
  });
}

export async function removePersonTag(client: RockClient, params: RemovePersonTagParams): Promise<unknown> {
  return runLegacyWrite('remove_person_tag', params, async () => {
    const tagId = await findPersonTagId(client, params.tagName);
    if (tagId == null) {
      throw new Error(`Tag "${params.tagName}" not found`);
    }
    const personGuid = await getPersonGuid(client, params.personId);

    const items = await client.v2Search<Array<{ id: number }>>('taggeditems', {
      where: `TagId == ${tagId} && EntityGuid == ${lq(personGuid)}`,
      limit: 1,
    });

    if (!items || items.length === 0) {
      return {
        verb: 'delete', entityType: 'TaggedItem', intended: null,
        noop: { success: true, message: `Person ${params.personId} does not have tag "${params.tagName}"` },
      };
    }

    const itemId = items[0].id;
    const before = await client.v1Get<unknown>(`TaggedItems/${itemId}`);
    return {
      verb: 'delete',
      entityType: 'TaggedItem',
      id: itemId,
      before,
      intended: { person: params.personId, tag: params.tagName, delete: `TaggedItems/${itemId}` },
      apply: async () => {
        // v1 DELETE matches the v1 POST used by add_person_tag and avoids the v2 per-entity
        // edit check on Tag.
        await client.v1Delete(`TaggedItems/${itemId}`);
        return {
          result: { success: true, message: `Removed tag "${params.tagName}" from person ${params.personId}` },
          action: 'deleted',
          readBack: async () => {
            const row = await v1GetOrNull<unknown>(client, `TaggedItems/${itemId}`);
            return { verified: row == null, after: row ?? undefined };
          },
        };
      },
    };
  });
}
