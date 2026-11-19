/**
 * Groups Tools for Rock RMS — v2 endpoints (Linq.Dynamic where expressions).
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

function lq(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function whereAnd(clauses: Array<string | undefined>): string | undefined {
  const kept = clauses.filter((c): c is string => !!c && c.length > 0);
  return kept.length === 0 ? undefined : kept.join(' && ');
}

// -----------------------------
// search_groups / get_group
// -----------------------------

export interface SearchGroupsParams {
  name?: string;
  groupTypeId?: number;
  isActive?: boolean;
  limit?: number;
}

export interface GetGroupParams {
  id: number;
  includeMembers?: boolean;
}

export const searchGroupsSchema = {
  name: 'search_groups',
  description: 'Search for groups by name, type, or status',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Group name to search for (partial match)' },
      groupTypeId: { type: 'number', description: 'Filter by Group Type ID' },
      isActive: { type: 'boolean', description: 'Filter by active status' },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 25)' },
    },
  },
};

export const getGroupSchema = {
  name: 'get_group',
  description: 'Get a specific group by ID with optional member list',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The Group ID' },
      includeMembers: { type: 'boolean', description: 'Include group members in response' },
    },
    required: ['id'],
  },
};

export async function searchGroups(client: RockClient, params: SearchGroupsParams): Promise<unknown> {
  const where = whereAnd([
    params.name ? `Name.Contains(${lq(params.name)})` : undefined,
    params.groupTypeId !== undefined ? `GroupTypeId == ${params.groupTypeId}` : undefined,
    params.isActive !== undefined ? `IsActive == ${params.isActive ? 'true' : 'false'}` : undefined,
  ]);

  return client.v2Search('groups', { where, limit: params.limit ?? 25 });
}

/**
 * Convert top-level PascalCase keys (e.g. v1 response shape) to camelCase.
 * Best-effort; doesn't recurse into nested objects.
 */
function topLevelToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.charAt(0).toLowerCase() + k.slice(1)] = v;
  }
  return out;
}

export async function getGroup(client: RockClient, params: GetGroupParams): Promise<unknown> {
  // v2's GET /groups/{id} enforces per-entity View security strictly: even with
  // RSR - Rock Administration granted on the controller, individual Groups whose
  // per-entity Auth doesn't explicitly include the REST key's role return 401.
  // v1 is more permissive for read access on the same key + role, so we use v1 here.
  // (search_groups works on v2 because the search endpoint doesn't enforce the
  //  per-entity check.)
  const raw = await client.v1Get<Record<string, unknown>>(`Groups/${params.id}`);
  const group = topLevelToCamel(raw);
  if (params.includeMembers) {
    try {
      group.members = await client.v2Search('groupmembers', {
        where: `GroupId == ${params.id}`,
        limit: 200,
      });
    } catch {
      group.members = [];
    }
  }
  return group;
}

// -----------------------------
// update_group
// -----------------------------

export interface UpdateGroupParams extends TwoPhaseCallParams {
  id: number;
  name?: string;
  description?: string;
  isActive?: boolean;
  campusId?: number;
}

export const updateGroupSchema = {
  name: 'update_group',
  description: "Update a group's info in Rock RMS. Only provided fields are updated." + TWO_PHASE_NOTE,
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The Group ID to update' },
      name: { type: 'string', description: 'Group name' },
      description: { type: 'string', description: 'Group description' },
      isActive: { type: 'boolean', description: 'Whether the group is active' },
      campusId: { type: 'number', description: 'Campus ID' },
      ...TWO_PHASE_CALL_PROPS,
    },
    required: ['id', 'reason'],
  },
};

export async function updateGroup(client: RockClient, params: UpdateGroupParams): Promise<unknown> {
  return runLegacyWrite('update_group', params, async () => {
    // v2 PATCH /groups/{id} enforces per-entity edit; v1 is permissive with the REST key.
    const body: Record<string, unknown> = {};
    if (params.name !== undefined) body.Name = params.name;
    if (params.description !== undefined) body.Description = params.description;
    if (params.isActive !== undefined) body.IsActive = params.isActive;
    if (params.campusId !== undefined) body.CampusId = params.campusId;

    if (Object.keys(body).length === 0) {
      return { verb: 'edit', entityType: 'Group', id: params.id, intended: null, noop: { success: false, error: 'No fields provided to update' } };
    }

    const row = await client.v1Get<unknown>(`Groups/${params.id}`);
    return {
      verb: 'edit',
      entityType: 'Group',
      id: params.id,
      body,
      before: pickFields(row, Object.keys(body)),
      intended: { group: params.id, set: body },
      apply: async () => {
        await client.v1Patch(`Groups/${params.id}`, body);
        const result: Record<string, unknown> = { success: true, message: `Group ${params.id} updated` };
        return {
          result,
          readBack: async () => {
            // Read via v1 too — v2 GET also 401s on per-entity. Convert top-level keys to camelCase.
            const raw = await client.v1Get<Record<string, unknown>>(`Groups/${params.id}`);
            result.group = topLevelToCamel(raw);
            return { verified: fieldsMatch(raw, body) };
          },
        };
      },
    };
  });
}

// -----------------------------
// add_group_member / remove_group_member
// -----------------------------

export interface AddGroupMemberParams extends WriteCallParams {
  groupId: number;
  personId: number;
  roleId?: number;
  status?: number; // 0=Inactive, 1=Active, 2=Pending
}

export interface RemoveGroupMemberParams extends TwoPhaseCallParams {
  groupId: number;
  personId: number;
}

export const addGroupMemberSchema = {
  name: 'add_group_member',
  description:
    "Add a person to a group in Rock RMS. roleId defaults to the group type's default role. " +
    'status: 0=Inactive, 1=Active (default), 2=Pending. ' +
    "Security roles go through Rock's own save logic when ROCK_ROLE_MEMBER_ENDPOINT names the installed " +
    'role-member Lava endpoint (takes effect at once, no cache clear, reactivates an inactive membership); ' +
    'roleId and status are ignored for them. Without that endpoint a security-role add is refused.' + CREATE_NOTE,
  inputSchema: {
    type: 'object' as const,
    properties: {
      groupId: { type: 'number', description: 'The Group ID' },
      personId: { type: 'number', description: 'The Person ID to add' },
      roleId: { type: 'number', description: 'Group role ID (defaults to group type default role)' },
      status: { type: 'number', description: '0=Inactive, 1=Active (default), 2=Pending' },
      ...CREATE_CALL_PROPS,
    },
    required: ['groupId', 'personId', 'reason'],
  },
};

export const removeGroupMemberSchema = {
  name: 'remove_group_member',
  description: 'Remove a person from a group in Rock RMS.' + TWO_PHASE_NOTE,
  inputSchema: {
    type: 'object' as const,
    properties: {
      groupId: { type: 'number', description: 'The Group ID' },
      personId: { type: 'number', description: 'The Person ID to remove' },
      ...TWO_PHASE_CALL_PROPS,
    },
    required: ['groupId', 'personId', 'reason'],
  },
};

export async function addGroupMember(client: RockClient, params: AddGroupMemberParams): Promise<unknown> {
  return runLegacyWrite('add_group_member', params, async () => {
    // Rock's v1 REST refuses security-role adds (403), and a raw SQL row is invisible to Rock's
    // role cache until a cache clear and writes no History. Observed on Rock 19.8.1
    // (2026-11-08/09): {% modifygroupmember %} in an admin-only Lava endpoint takes effect at
    // once, stamps created/modified-by with the key's person and writes History. The endpoint's
    // Lava source and setup are in ops/rock-role-member-endpoint/.
    const roleCheck = await client.v2Search<Array<{ isSecurityRole?: boolean }>>('groups', {
      where: `Id == ${params.groupId}`,
      limit: 1,
    });
    if (roleCheck && roleCheck[0] && roleCheck[0].isSecurityRole === true) {
      return prepareRoleMemberAdd(client, params);
    }
    let roleId = params.roleId;
    if (!roleId) {
      // v2 GET /groups/{id} enforces per-entity View security strictly, so even with
      // controller-level Administrate this 401s for most groups. v2 search doesn't
      // enforce the per-entity check, so look up the groupTypeId that way.
      const groupRows = await client.v2Search<Array<{ groupTypeId: number }>>('groups', {
        where: `Id == ${params.groupId}`,
        limit: 1,
      });
      if (!groupRows || groupRows.length === 0) {
        throw new Error(`Group ${params.groupId} not found`);
      }
      const groupTypeId = groupRows[0].groupTypeId;
      // The default role for a group type is held on GroupType.DefaultGroupRoleId (NOT
      // on GroupTypeRole). v2 grouptypes search returns 500 on this instance, so use v1.
      try {
        const typeV1 = await client.v1Get<{ DefaultGroupRoleId: number | null }>(
          `GroupTypes/${groupTypeId}`,
          { $select: 'Id,DefaultGroupRoleId' }
        );
        if (typeV1.DefaultGroupRoleId) {
          roleId = typeV1.DefaultGroupRoleId;
        }
      } catch {
        // Continue to fallback below
      }
      if (!roleId) {
        const anyRoles = await client.v2Search<Array<{ id: number }>>('grouptyperoles', {
          where: `GroupTypeId == ${groupTypeId}`,
          limit: 1,
        });
        if (anyRoles && anyRoles.length > 0) {
          roleId = anyRoles[0].id;
        } else {
          throw new Error(`No roles found for group type of group ${params.groupId}`);
        }
      }
    }

    const existing = await client.v2Search<Array<{ id: number }>>('groupmembers', {
      where: `GroupId == ${params.groupId} && PersonId == ${params.personId}`,
      limit: 1,
    });

    if (existing && existing.length > 0) {
      return {
        verb: 'create', entityType: 'GroupMember', intended: null,
        noop: { success: true, message: `Person ${params.personId} is already a member of group ${params.groupId}` },
      };
    }

    const body = {
      GroupId: params.groupId,
      PersonId: params.personId,
      GroupRoleId: roleId,
      GroupMemberStatus: params.status ?? 1,
    };
    return {
      verb: 'create',
      entityType: 'GroupMember',
      intended: { create: body },
      apply: async () => {
        // v2 POST /groupmembers returns 401 (per-entity edit check) even with controller
        // Administrate. v1 POST is permissive with the same key + role.
        const newId = idFrom(await client.v1Post<unknown>('GroupMembers', body));
        return {
          result: { success: true, message: `Added person ${params.personId} to group ${params.groupId}`, groupMemberId: newId },
          newId: newId ?? undefined,
          readBack: () => createdRowExists(client, 'GroupMembers', newId),
        };
      },
    };
  });
}

function roleMemberEndpoint(): { app: string; endpoint: string } {
  const raw = (process.env.ROCK_ROLE_MEMBER_ENDPOINT ?? '').trim();
  const m = /^([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(raw);
  if (!m) {
    throw new Error(
      'add_group_member: group is a security role. Rock refuses role adds over REST, and raw SQL rows are invisible ' +
        'until a cache clear. Install the role-member Lava endpoint (ops/rock-role-member-endpoint/README.md) on this ' +
        'server and set ROCK_ROLE_MEMBER_ENDPOINT to its "app-slug/endpoint-slug", then call again.'
    );
  }
  return { app: m[1], endpoint: m[2] };
}

async function prepareRoleMemberAdd(client: RockClient, params: AddGroupMemberParams) {
  if (params.status !== undefined && params.status !== 1) {
    throw new Error(
      'add_group_member: security roles only take active members here. Leave status out, or change an existing member in Rock.'
    );
  }
  const target = roleMemberEndpoint();
  const active = await client.v2Search<Array<{ id: number }>>('groupmembers', {
    where: `GroupId == ${params.groupId} && PersonId == ${params.personId} && GroupMemberStatus == 1`,
    limit: 1,
  });
  if (active && active.length > 0) {
    return {
      verb: 'create' as const, entityType: 'GroupMember', intended: null,
      noop: {
        success: true,
        message: `Person ${params.personId} already has security role ${params.groupId}.`,
        next: 'Nothing to do.',
      },
    };
  }
  return {
    verb: 'create' as const,
    entityType: 'GroupMember',
    intended: {
      via: `Lava endpoint ${target.app}/${target.endpoint} ({% modifygroupmember %})`,
      group: params.groupId,
      person: params.personId,
      role: "the role group type's default role",
    },
    notes: [
      'Rock applies a security-role add at once; no cache clear is needed.',
      'If the person has an inactive membership, it is reactivated instead of adding a second row.',
    ],
    apply: async () => {
      const r = await client.lavaAppPost<{ ok: boolean; result: string; groupMemberId?: number; group?: string; next?: string }>(
        target.app, target.endpoint, { personId: params.personId, groupId: params.groupId, reason: params.reason }
      );
      if (!r || r.ok !== true) {
        throw new Error(`add_group_member: Rock answered "${r?.result ?? 'no answer'}". ${r?.next ?? ''}`.trim());
      }
      const id = typeof r.groupMemberId === 'number' ? r.groupMemberId : null;
      return {
        result: {
          success: true,
          message: `${r.result === 'reactivated' ? 'Reactivated' : 'Added'} person ${params.personId} in security role ${r.group ?? params.groupId}`,
          groupMemberId: id,
          how: r.result,
          // A reactivation has no new row for rock_restore to delete, so say how to undo it instead.
          ...(r.result === 'reactivated'
            ? { next: 'Done. Tell the user what changed. rock_restore cannot undo a reactivation; to undo it, set the membership inactive in Rock.' }
            : {}),
        },
        // Only a brand-new row is undone by deleting it; a reactivation has no newId to delete.
        newId: r.result === 'added' && id != null ? id : undefined,
        readBack: async () => {
          if (id == null) return { verified: false, note: 'The endpoint returned no GroupMember Id.' };
          const rows = await client.executeSql(
            `SELECT Id, GroupMemberStatus, GroupTypeId FROM GroupMember WHERE Id = ${Number(id)} AND IsArchived = 0`
          );
          const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
          return { verified: !!row && Number(row.GroupMemberStatus) === 1, after: row };
        },
      };
    },
  };
}

export async function removeGroupMember(
  client: RockClient,
  params: RemoveGroupMemberParams
): Promise<unknown> {
  return runLegacyWrite('remove_group_member', params, async () => {
    const members = await client.v2Search<Array<{ id: number }>>('groupmembers', {
      where: `GroupId == ${params.groupId} && PersonId == ${params.personId}`,
      limit: 1,
    });

    if (!members || members.length === 0) {
      return {
        verb: 'delete', entityType: 'GroupMember', intended: null,
        noop: { success: false, message: `Person ${params.personId} is not a member of group ${params.groupId}` },
      };
    }

    const memberId = members[0].id;
    const before = await client.v1Get<unknown>(`GroupMembers/${memberId}`);
    return {
      verb: 'delete',
      entityType: 'GroupMember',
      id: memberId,
      before,
      intended: { group: params.groupId, person: params.personId, delete: `GroupMembers/${memberId}` },
      notes: [
        'Rock may archive the member (IsArchived) instead of deleting the row; the result says which happened, ' +
          'and rock_restore undoes either one.',
      ],
      apply: async () => {
        // v1 DELETE — v2 returns 401 per-entity even with controller-level Administrate.
        await client.v1Delete(`GroupMembers/${memberId}`);
        const after = await v1GetOrNull<Record<string, unknown>>(client, `GroupMembers/${memberId}`).catch(() => undefined);
        const archived = !!after && after.IsArchived === true;
        return {
          result: {
            success: true,
            message: `Removed person ${params.personId} from group ${params.groupId}`,
            removal: archived ? 'archived' : 'deleted',
          },
          action: archived ? 'archived' : 'deleted',
          readBack: async () => {
            const row = await v1GetOrNull<Record<string, unknown>>(client, `GroupMembers/${memberId}`);
            return {
              verified: row == null || row.IsArchived === true,
              after: row ? pickFields(row, ['IsArchived', 'GroupId', 'PersonId']) : undefined,
            };
          },
        };
      },
    };
  });
}
