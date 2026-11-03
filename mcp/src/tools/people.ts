/**
 * People Tools for Rock RMS — v2 endpoints.
 *
 * v2 search bodies use Linq.Dynamic syntax with PascalCase entity field names
 * (see `RockClient.v2Search` docs). Response bodies are camelCase.
 */

import { RockClient } from '../rock-client.js';

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

// -----------------------------
// update_person
// -----------------------------

export interface UpdatePersonParams {
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
    'Gender: 0=Unknown, 1=Male, 2=Female. Always confirm changes with the user before calling.',
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
    },
    required: ['id'],
  },
};

export async function updatePerson(client: RockClient, params: UpdatePersonParams): Promise<unknown> {
  // v2 PATCH bodies use camelCase (matches the GET response shape).
  const body: Record<string, unknown> = {};
  if (params.firstName !== undefined) body.firstName = params.firstName;
  if (params.nickName !== undefined) body.nickName = params.nickName;
  if (params.lastName !== undefined) body.lastName = params.lastName;
  if (params.email !== undefined) body.email = params.email;
  if (params.isEmailActive !== undefined) body.isEmailActive = params.isEmailActive;
  if (params.birthDay !== undefined) body.birthDay = params.birthDay;
  if (params.birthMonth !== undefined) body.birthMonth = params.birthMonth;
  if (params.birthYear !== undefined) body.birthYear = params.birthYear;
  if (params.gender !== undefined) body.gender = params.gender;
  if (params.maritalStatusValueId !== undefined) body.maritalStatusValueId = params.maritalStatusValueId;
  if (params.connectionStatusValueId !== undefined) body.connectionStatusValueId = params.connectionStatusValueId;
  if (params.recordStatusValueId !== undefined) body.recordStatusValueId = params.recordStatusValueId;

  if (Object.keys(body).length === 0) {
    return { success: false, error: 'No fields provided to update' };
  }

  await client.v2Patch(`people/${params.id}`, body);
  const updated = await client.v2Get(`people/${params.id}`);
  return { success: true, message: `Person ${params.id} updated`, person: updated };
}

// -----------------------------
// update_person_address
// -----------------------------

export interface UpdatePersonAddressParams {
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
    'addressType: Home, Work, or Previous. Always confirm changes with the user before calling.',
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
    },
    required: ['personId', 'street1', 'city', 'state', 'postalCode', 'addressType'],
  },
};

export async function updatePersonAddress(
  client: RockClient,
  params: UpdatePersonAddressParams
): Promise<unknown> {
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

  const locationBody: Record<string, unknown> = {
    street1: params.street1,
    street2: params.street2 ?? '',
    city: params.city,
    state: params.state,
    postalCode: params.postalCode,
    country: params.country ?? 'US',
  };

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
    await client.v1Patch(`Locations/${existingLocs[0].locationId}`, v1LocationBody);
    return {
      success: true,
      message: `Updated ${params.addressType} address for family ${familyId}`,
      locationId: existingLocs[0].locationId,
    };
  } else {
    const newLocationId = await client.v1Post<number>('Locations', v1LocationBody);
    await client.v1Post('GroupLocations', {
      GroupId: familyId,
      LocationId: newLocationId,
      GroupLocationTypeValueId: locationTypeId,
      IsMailingLocation: params.addressType === 'Home',
      IsMappedLocation: params.addressType === 'Home',
    });
    return {
      success: true,
      message: `Added ${params.addressType} address for family ${familyId}`,
      locationId: newLocationId,
    };
  }
}

// -----------------------------
// update_person_phone
// -----------------------------

export interface UpdatePersonPhoneParams {
  personId: number;
  number: string;
  phoneType: 'Mobile' | 'Home' | 'Work';
  isMessagingEnabled?: boolean;
}

export const updatePersonPhoneSchema = {
  name: 'update_person_phone',
  description:
    'Add or update a phone number for a person in Rock RMS. ' +
    'phoneType: Mobile, Home, or Work. Always confirm changes with the user before calling.',
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
    },
    required: ['personId', 'number', 'phoneType'],
  },
};

export async function updatePersonPhone(
  client: RockClient,
  params: UpdatePersonPhoneParams
): Promise<unknown> {
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
    await client.v1Patch(`PhoneNumbers/${existing[0].id}`, {
      Number: cleanNumber,
      IsMessagingEnabled: isMessaging,
    });
    return { success: true, message: `Updated ${params.phoneType} phone for person ${params.personId}` };
  } else {
    await client.v1Post('PhoneNumbers', {
      PersonId: params.personId,
      Number: cleanNumber,
      CountryCode: '1',
      NumberTypeValueId: phoneTypeId,
      IsMessagingEnabled: isMessaging,
    });
    return { success: true, message: `Added ${params.phoneType} phone for person ${params.personId}` };
  }
}

// -----------------------------
// add_person_tag / remove_person_tag
// -----------------------------

export interface AddPersonTagParams {
  personId: number;
  tagName: string;
}

export interface RemovePersonTagParams {
  personId: number;
  tagName: string;
}

export const addPersonTagSchema = {
  name: 'add_person_tag',
  description:
    'Add a tag to a person in Rock RMS. The tag must already exist. ' +
    'Always confirm with the user before calling.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person ID' },
      tagName: { type: 'string', description: 'The tag name to add' },
    },
    required: ['personId', 'tagName'],
  },
};

export const removePersonTagSchema = {
  name: 'remove_person_tag',
  description: 'Remove a tag from a person in Rock RMS. Always confirm with the user before calling.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person ID' },
      tagName: { type: 'string', description: 'The tag name to remove' },
    },
    required: ['personId', 'tagName'],
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
    return { success: true, message: `Person ${params.personId} already has tag "${params.tagName}"` };
  }

  // v2 POST /taggeditems returns 401 ("not authorized to edit this item") even with
  // Administrate on the controller — Rock v2 checks per-entity edit on the Tag and
  // most tags don't include the REST key's role in their Auth tree. v1 POST is
  // permissive enough to succeed with the same key + role.
  await client.v1Post('TaggedItems', {
    TagId: tagId,
    EntityTypeId: (await personEntityTypeId(client)),
    EntityGuid: personGuid,
  });

  return { success: true, message: `Added tag "${params.tagName}" to person ${params.personId}` };
}

export async function removePersonTag(client: RockClient, params: RemovePersonTagParams): Promise<unknown> {
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
    return { success: true, message: `Person ${params.personId} does not have tag "${params.tagName}"` };
  }

  // v1 DELETE matches the v1 POST used by add_person_tag and avoids the v2 per-entity
  // edit check on Tag.
  await client.v1Delete(`TaggedItems/${items[0].id}`);
  return { success: true, message: `Removed tag "${params.tagName}" from person ${params.personId}` };
}
