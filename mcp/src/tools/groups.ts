/**
 * Groups Tools for Rock RMS — v2 endpoints (Linq.Dynamic where expressions).
 */

import { RockClient } from '../rock-client.js';

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

export interface UpdateGroupParams {
  id: number;
  name?: string;
  description?: string;
  isActive?: boolean;
  campusId?: number;
}

export const updateGroupSchema = {
  name: 'update_group',
  description:
    "Update a group's info in Rock RMS. Only provided fields are updated. " +
    'Always confirm changes with the user before calling.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The Group ID to update' },
      name: { type: 'string', description: 'Group name' },
      description: { type: 'string', description: 'Group description' },
      isActive: { type: 'boolean', description: 'Whether the group is active' },
      campusId: { type: 'number', description: 'Campus ID' },
    },
    required: ['id'],
  },
};

export async function updateGroup(client: RockClient, params: UpdateGroupParams): Promise<unknown> {
  // v2 PATCH /groups/{id} enforces per-entity edit; v1 is permissive with the REST key.
  const body: Record<string, unknown> = {};
  if (params.name !== undefined) body.Name = params.name;
  if (params.description !== undefined) body.Description = params.description;
  if (params.isActive !== undefined) body.IsActive = params.isActive;
  if (params.campusId !== undefined) body.CampusId = params.campusId;

  if (Object.keys(body).length === 0) {
    return { success: false, error: 'No fields provided to update' };
  }

  await client.v1Patch(`Groups/${params.id}`, body);
  // Read via v1 too — v2 GET also 401s on per-entity. Convert top-level keys to camelCase.
  const raw = await client.v1Get<Record<string, unknown>>(`Groups/${params.id}`);
  return { success: true, message: `Group ${params.id} updated`, group: topLevelToCamel(raw) };
}

// -----------------------------
// add_group_member / remove_group_member
// -----------------------------

export interface AddGroupMemberParams {
  groupId: number;
  personId: number;
  roleId?: number;
  status?: number; // 0=Inactive, 1=Active, 2=Pending
}

export interface RemoveGroupMemberParams {
  groupId: number;
  personId: number;
}

export const addGroupMemberSchema = {
  name: 'add_group_member',
  description:
    "Add a person to a group in Rock RMS. roleId defaults to the group type's default role. " +
    'status: 0=Inactive, 1=Active (default), 2=Pending. Always confirm with the user before calling.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      groupId: { type: 'number', description: 'The Group ID' },
      personId: { type: 'number', description: 'The Person ID to add' },
      roleId: { type: 'number', description: 'Group role ID (defaults to group type default role)' },
      status: { type: 'number', description: '0=Inactive, 1=Active (default), 2=Pending' },
    },
    required: ['groupId', 'personId'],
  },
};

export const removeGroupMemberSchema = {
  name: 'remove_group_member',
  description: 'Remove a person from a group in Rock RMS. Always confirm with the user before calling.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      groupId: { type: 'number', description: 'The Group ID' },
      personId: { type: 'number', description: 'The Person ID to remove' },
    },
    required: ['groupId', 'personId'],
  },
};

export async function addGroupMember(client: RockClient, params: AddGroupMemberParams): Promise<unknown> {
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
      success: true,
      message: `Person ${params.personId} is already a member of group ${params.groupId}`,
    };
  }

  // v2 POST /groupmembers returns 401 (per-entity edit check) even with controller
  // Administrate. v1 POST is permissive with the same key + role.
  const newId = await client.v1Post<number>('GroupMembers', {
    GroupId: params.groupId,
    PersonId: params.personId,
    GroupRoleId: roleId,
    GroupMemberStatus: params.status ?? 1,
  });

  return {
    success: true,
    message: `Added person ${params.personId} to group ${params.groupId}`,
    groupMemberId: newId,
  };
}

export async function removeGroupMember(
  client: RockClient,
  params: RemoveGroupMemberParams
): Promise<unknown> {
  const members = await client.v2Search<Array<{ id: number }>>('groupmembers', {
    where: `GroupId == ${params.groupId} && PersonId == ${params.personId}`,
    limit: 1,
  });

  if (!members || members.length === 0) {
    return {
      success: false,
      message: `Person ${params.personId} is not a member of group ${params.groupId}`,
    };
  }

  // v1 DELETE — v2 returns 401 per-entity even with controller-level Administrate.
  await client.v1Delete(`GroupMembers/${members[0].id}`);
  return { success: true, message: `Removed person ${params.personId} from group ${params.groupId}` };
}
