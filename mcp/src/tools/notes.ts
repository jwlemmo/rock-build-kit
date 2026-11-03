/**
 * Notes Tools for Rock RMS.
 *
 * Notes attach to any entity (most commonly Person) and capture pastoral / care /
 * follow-up history. Each Note has a NoteTypeId scoping it to an entity type
 * (e.g. "Personal Note" on a Person).
 *
 * Tools:
 *   - get_notes — list notes attached to a person or entity
 *   - add_note — create a new note
 *
 * Writes go through v1 because v2 enforces the strict per-entity edit check on
 * Notes.
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

// ---------------- get_notes ----------------

export interface GetNotesParams {
  /** Convenience: pass personId to look up Notes on Person entity */
  personId?: number;
  /** Generic: provide entity type (e.g. "Person", "Group") + entityId */
  entityType?: string;
  entityId?: number;
  noteTypeId?: number;
  limit?: number;
}

export const getNotesSchema = {
  name: 'get_notes',
  description:
    'Get Notes attached to a Person (pass personId) or any entity (pass entityType + entityId). ' +
    'Returns notes sorted by date descending.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'Convenience: Person Id (auto-resolves entity type)' },
      entityType: { type: 'string', description: 'Entity type friendly name (e.g. "Person", "Group")' },
      entityId: { type: 'number', description: 'Entity Id (required if entityType provided)' },
      noteTypeId: { type: 'number', description: 'Restrict to a specific NoteType' },
      limit: { type: 'number', description: 'Max results (default 50)' },
    },
  },
};

export async function getNotes(client: RockClient, params: GetNotesParams): Promise<unknown> {
  let entityTypeId: number | undefined;
  let entityId: number | undefined = params.entityId;

  if (params.personId !== undefined) {
    entityTypeId = await resolveEntityTypeId(client, 'Person');
    entityId = params.personId;
  } else if (params.entityType) {
    entityTypeId = await resolveEntityTypeId(client, params.entityType);
  }

  if (!entityTypeId || entityId === undefined) {
    return {
      error:
        'Provide either personId, or both entityType and entityId. Could not resolve target entity.',
    };
  }

  // Notes are scoped via NoteType.EntityTypeId; need to filter via NoteType navigation.
  const where = whereAnd([
    `NoteType.EntityTypeId == ${entityTypeId}`,
    `EntityId == ${entityId}`,
    params.noteTypeId !== undefined ? `NoteTypeId == ${params.noteTypeId}` : undefined,
  ]);

  return client.v2Search('notes', {
    where,
    sort: 'CreatedDateTime descending',
    limit: params.limit ?? 50,
  });
}

// ---------------- add_note ----------------

export interface AddNoteParams {
  personId?: number;
  entityType?: string;
  entityId?: number;
  noteTypeId?: number;
  noteTypeName?: string;
  text: string;
  caption?: string;
  isAlert?: boolean;
  isPrivateNote?: boolean;
}

export const addNoteSchema = {
  name: 'add_note',
  description:
    'Add a Note to a Person (pass personId) or any entity (pass entityType + entityId). ' +
    'Specify NoteType via noteTypeId (preferred) or noteTypeName (e.g. "Personal Note"). ' +
    'Always confirm with the user before calling.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'Convenience: Person Id (auto-resolves entity type)' },
      entityType: { type: 'string', description: 'Entity type friendly name (e.g. "Person", "Group")' },
      entityId: { type: 'number', description: 'Entity Id' },
      noteTypeId: { type: 'number', description: 'NoteType Id (preferred)' },
      noteTypeName: { type: 'string', description: 'NoteType name (e.g. "Personal Note") — resolved against the entity type' },
      text: { type: 'string', description: 'The note body' },
      caption: { type: 'string', description: 'Optional caption / title' },
      isAlert: { type: 'boolean', description: 'Mark as alert' },
      isPrivateNote: { type: 'boolean', description: 'Mark as private (only visible to creator)' },
    },
    required: ['text'],
  },
};

export async function addNote(client: RockClient, params: AddNoteParams): Promise<unknown> {
  let entityTypeId: number | undefined;
  let entityId: number | undefined = params.entityId;

  if (params.personId !== undefined) {
    entityTypeId = await resolveEntityTypeId(client, 'Person');
    entityId = params.personId;
  } else if (params.entityType) {
    entityTypeId = await resolveEntityTypeId(client, params.entityType);
  }

  if (!entityTypeId || entityId === undefined) {
    throw new Error('Provide either personId, or both entityType and entityId.');
  }

  let noteTypeId = params.noteTypeId;
  if (!noteTypeId) {
    const typeName = params.noteTypeName ?? 'Personal Note';
    const types = await client.v2Search<Array<{ id: number; name: string }>>('noteTypes', {
      where: `EntityTypeId == ${entityTypeId} && Name == ${lq(typeName)}`,
      limit: 1,
    });
    if (Array.isArray(types) && types.length > 0) {
      noteTypeId = types[0].id;
    } else {
      // Fall back to any note type for this entity type
      const any = await client.v2Search<Array<{ id: number; name: string }>>('noteTypes', {
        where: `EntityTypeId == ${entityTypeId} && UserSelectable == true`,
        sort: 'Order',
        limit: 1,
      });
      if (Array.isArray(any) && any.length > 0) {
        noteTypeId = any[0].id;
      } else {
        throw new Error(`No NoteType found for entity type ${entityTypeId}`);
      }
    }
  }

  const body: Record<string, unknown> = {
    NoteTypeId: noteTypeId,
    EntityId: entityId,
    Text: params.text,
    IsAlert: params.isAlert ?? false,
    IsPrivateNote: params.isPrivateNote ?? false,
  };
  if (params.caption) body.Caption = params.caption;

  const newId = await client.v1Post<number>('Notes', body);
  return {
    success: true,
    noteId: newId,
    noteTypeId,
    entityId,
    entityTypeId,
    message: `Added note to entity ${entityId}`,
  };
}
