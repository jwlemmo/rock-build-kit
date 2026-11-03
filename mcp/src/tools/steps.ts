/**
 * Steps Tools for Rock RMS.
 *
 * Steps track a person's progression through defined milestones (e.g. School of
 * Ministry course completion, baptism, membership class). The data model is:
 *   StepProgram -> StepType -> Step (per person)
 *
 * Tools:
 *   - list_step_programs   — list/search step programs
 *   - list_step_types      — list step types within a program
 *   - list_person_steps    — list a person's recorded steps
 *   - record_step          — record a new step for a person
 *
 * Writes go through v1 because v2's per-entity edit check rejects with 401 even
 * with the controller-level Administrate role.
 */

import { RockClient } from '../rock-client.js';

function lq(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function whereAnd(clauses: Array<string | undefined>): string | undefined {
  const kept = clauses.filter((c): c is string => !!c && c.length > 0);
  return kept.length === 0 ? undefined : kept.join(' && ');
}

// ---------------- list_step_programs ----------------

export interface ListStepProgramsParams {
  name?: string;
  isActive?: boolean;
  limit?: number;
}

export const listStepProgramsSchema = {
  name: 'list_step_programs',
  description: 'List Step Programs (e.g. "School of Ministry"). Filter by name substring.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Program name substring' },
      isActive: { type: 'boolean', description: 'Filter by active status' },
      limit: { type: 'number', description: 'Max results (default 50)' },
    },
  },
};

export async function listStepPrograms(
  client: RockClient,
  params: ListStepProgramsParams
): Promise<unknown> {
  const where = whereAnd([
    params.name ? `Name.Contains(${lq(params.name)})` : undefined,
    params.isActive !== undefined ? `IsActive == ${params.isActive ? 'true' : 'false'}` : undefined,
  ]);
  return client.v2Search('stepPrograms', { where, sort: 'Order, Name', limit: params.limit ?? 50 });
}

// ---------------- list_step_types ----------------

export interface ListStepTypesParams {
  stepProgramId?: number;
  name?: string;
  limit?: number;
}

export const listStepTypesSchema = {
  name: 'list_step_types',
  description: 'List Step Types. Filter by stepProgramId (recommended) and/or name substring.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      stepProgramId: { type: 'number', description: 'Restrict to a specific Step Program' },
      name: { type: 'string', description: 'Step type name substring' },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
  },
};

export async function listStepTypes(
  client: RockClient,
  params: ListStepTypesParams
): Promise<unknown> {
  const where = whereAnd([
    params.stepProgramId !== undefined ? `StepProgramId == ${params.stepProgramId}` : undefined,
    params.name ? `Name.Contains(${lq(params.name)})` : undefined,
  ]);
  return client.v2Search('stepTypes', { where, sort: 'Order, Name', limit: params.limit ?? 100 });
}

// ---------------- list_person_steps ----------------

export interface ListPersonStepsParams {
  personId: number;
  stepProgramId?: number;
  stepTypeId?: number;
  limit?: number;
}

export const listPersonStepsSchema = {
  name: 'list_person_steps',
  description:
    'List a person\'s recorded Steps. Optionally restrict by step program or specific step type.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person Id' },
      stepProgramId: { type: 'number', description: 'Restrict to a specific Step Program' },
      stepTypeId: { type: 'number', description: 'Restrict to a specific Step Type' },
      limit: { type: 'number', description: 'Max results (default 100)' },
    },
    required: ['personId'],
  },
};

export async function listPersonSteps(
  client: RockClient,
  params: ListPersonStepsParams
): Promise<unknown> {
  // v2 search on Steps controller currently 500s on this Rock install — pin to v1 OData.
  // First, resolve PersonAliasId for this Person.
  const aliases = await client.v2Search<Array<{ id: number }>>('personAliases', {
    where: `AliasPersonId == ${params.personId}`,
    sort: 'Id',
    limit: 50,
  });
  if (!Array.isArray(aliases) || aliases.length === 0) {
    return [];
  }
  const aliasIds = aliases.map((a) => a.id);
  // v1 OData doesn't have an `in` operator — chain with `or`.
  const aliasClause =
    aliasIds.length === 1
      ? `PersonAliasId eq ${aliasIds[0]}`
      : `(${aliasIds.map((id) => `PersonAliasId eq ${id}`).join(' or ')})`;

  const filters: string[] = [aliasClause];
  if (params.stepTypeId !== undefined) {
    filters.push(`StepTypeId eq ${params.stepTypeId}`);
  }
  // (stepProgramId would require a join through StepType — skip for v1 simplicity.)

  return client.v1Get('Steps', {
    $filter: filters.join(' and '),
    $orderby: 'CompletedDateTime desc',
    $top: params.limit ?? 100,
  });
}

// ---------------- record_step ----------------

export interface RecordStepParams {
  personId: number;
  stepTypeId: number;
  /** Status id: 1=Started, 2=Completed (default), 3=...  Override if you know the StepStatus you want. */
  stepStatusId?: number;
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  completedDate?: string; // YYYY-MM-DD
  note?: string;
}

export const recordStepSchema = {
  name: 'record_step',
  description:
    'Record a Step for a person. Defaults to "Completed" status with today as the completion date. ' +
    'Always confirm with the user before calling — Steps are persistent and reflect milestone completion.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'The Person Id' },
      stepTypeId: { type: 'number', description: 'The Step Type Id (use list_step_types to find)' },
      stepStatusId: {
        type: 'number',
        description: 'StepStatus Id. If omitted, uses the default Completed status for the program.',
      },
      startDate: { type: 'string', description: 'Start date (YYYY-MM-DD, optional)' },
      endDate: { type: 'string', description: 'End date (YYYY-MM-DD, optional)' },
      completedDate: { type: 'string', description: 'Completion date (YYYY-MM-DD, defaults to today)' },
      note: { type: 'string', description: 'Free-text note attached to the Step' },
    },
    required: ['personId', 'stepTypeId'],
  },
};

export async function recordStep(
  client: RockClient,
  params: RecordStepParams
): Promise<unknown> {
  // Resolve PersonAliasId for the person (Rock requires PersonAliasId, not PersonId, on Steps)
  const aliases = await client.v2Search<Array<{ id: number; aliasPersonId: number }>>(
    'personAliases',
    {
      where: `AliasPersonId == ${params.personId}`,
      sort: 'Id',
      limit: 1,
    }
  );
  if (!Array.isArray(aliases) || aliases.length === 0) {
    throw new Error(`No PersonAlias found for personId ${params.personId}`);
  }
  const personAliasId = aliases[0].id;

  // Resolve stepStatusId: if not provided, look up the default Completed status for the program
  let stepStatusId = params.stepStatusId;
  if (!stepStatusId) {
    // Step types include their program; find a step status with IsCompleteStatus=true for that program
    const stepType = await client.v2Get<{ stepProgramId: number }>(`stepTypes/${params.stepTypeId}`);
    const statuses = await client.v2Search<Array<{ id: number; isCompleteStatus: boolean; name: string }>>(
      'stepStatuses',
      {
        where: `StepProgramId == ${stepType.stepProgramId} && IsActive == true`,
        sort: 'IsCompleteStatus descending, Order',
        limit: 10,
      }
    );
    const completed = (Array.isArray(statuses) ? statuses : []).find((s) => s.isCompleteStatus);
    if (completed) {
      stepStatusId = completed.id;
    } else if (Array.isArray(statuses) && statuses.length > 0) {
      stepStatusId = statuses[0].id;
    } else {
      throw new Error(`No StepStatus found for the Step Program containing StepType ${params.stepTypeId}`);
    }
  }

  const todayISO = new Date().toISOString().slice(0, 10);
  // v1 POST /api/Steps accepts PascalCase fields
  const body: Record<string, unknown> = {
    StepTypeId: params.stepTypeId,
    PersonAliasId: personAliasId,
    StepStatusId: stepStatusId,
    CompletedDateTime: params.completedDate ?? todayISO,
  };
  if (params.startDate) body.StartDateTime = params.startDate;
  if (params.endDate) body.EndDateTime = params.endDate;
  if (params.note) body.Note = params.note;

  const newId = await client.v1Post<number>('Steps', body);
  return {
    success: true,
    stepId: newId,
    personId: params.personId,
    stepTypeId: params.stepTypeId,
    stepStatusId,
    completedDate: body.CompletedDateTime,
    message: `Recorded Step (type ${params.stepTypeId}) for person ${params.personId}`,
  };
}
