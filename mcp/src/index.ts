#!/usr/bin/env node

/**
 * Rock RMS MCP Server
 * A read-only MCP server for interacting with Rock RMS REST API
 */

import { withNextStep, errorWithNextStep } from './safety/nextStep.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer as createHttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';

import { createRockClient, RockClient } from './rock-client.js';
import { logToolCall } from './logger.js';
import { buildGuideSchema, getBuildGuide } from './tools/guides.js';
import { BUILD_SHA, BUILD_BRANCH, BUILD_DIRTY, BUILD_TIME } from './generated/build-info.js';

// Import tool schemas and handlers
import {
  searchPeopleSchema,
  getPersonSchema,
  updatePersonSchema,
  updatePersonAddressSchema,
  updatePersonPhoneSchema,
  addPersonTagSchema,
  removePersonTagSchema,
  searchPeople,
  getPerson,
  updatePerson,
  updatePersonAddress,
  updatePersonPhone,
  addPersonTag,
  removePersonTag,
  SearchPeopleParams,
  GetPersonParams,
  UpdatePersonParams,
  UpdatePersonAddressParams,
  UpdatePersonPhoneParams,
  AddPersonTagParams,
  RemovePersonTagParams,
} from './tools/people.js';

import {
  searchGroupsSchema,
  getGroupSchema,
  updateGroupSchema,
  addGroupMemberSchema,
  removeGroupMemberSchema,
  searchGroups,
  getGroup,
  updateGroup,
  addGroupMember,
  removeGroupMember,
  SearchGroupsParams,
  GetGroupParams,
  UpdateGroupParams,
  AddGroupMemberParams,
  RemoveGroupMemberParams,
} from './tools/groups.js';

import {
  searchAttendanceSchema,
  recordAttendanceSchema,
  searchAttendance,
  recordAttendance,
  SearchAttendanceParams,
  RecordAttendanceParams,
} from './tools/attendance.js';

import {
  searchGivingSchema,
  searchGiving,
  SearchGivingParams,
} from './tools/giving.js';

import {
  getMetricsSchema,
  listMetricCategoriesSchema,
  upsertMetricValueSchema,
  getMetrics,
  listMetricCategories,
  upsertMetricValue,
  GetMetricsParams,
  ListMetricCategoriesParams,
  UpsertMetricValueParams,
} from './tools/metrics.js';

import {
  executeSqlSchema,
  executeSql,
  ExecuteSqlParams,
} from './tools/sql.js';

import {
  getSchemaSchema,
  getSchema,
  GetSchemaParams,
} from './tools/schema.js';

import {
  flushCacheSchema,
  flushCache,
} from './tools/cache.js';

import {
  searchReservationsSchema,
  createReservationSchema,
  updateReservationSchema,
  searchReservations,
  createReservation,
  updateReservation,
  SearchReservationsParams,
  CreateReservationParams,
  UpdateReservationParams,
} from './tools/reservations.js';

import {
  searchContentChannelsSchema,
  searchContentChannelItemsSchema,
  getContentChannelItemSchema,
  searchContentChannels,
  searchContentChannelItems,
  getContentChannelItem,
  SearchContentChannelsParams,
  SearchContentChannelItemsParams,
  GetContentChannelItemParams,
} from './tools/content-channels.js';

import {
  listDefinedTypesSchema,
  listDefinedValuesSchema,
  getDefinedValueSchema,
  listDefinedTypes,
  listDefinedValues,
  getDefinedValue,
  ListDefinedTypesParams,
  ListDefinedValuesParams,
  GetDefinedValueParams,
} from './tools/defined-values.js';

import {
  listCampusesSchema,
  getCampusSchema,
  listCampuses,
  getCampus,
  ListCampusesParams,
  GetCampusParams,
} from './tools/campuses.js';

import {
  listAttributesSchema,
  getPersonAttributesSchema,
  setPersonAttributeSchema,
  listAttributes,
  getPersonAttributes,
  setPersonAttribute,
  ListAttributesParams,
  GetPersonAttributesParams,
  SetPersonAttributeParams,
} from './tools/attributes.js';

import {
  listStepProgramsSchema,
  listStepTypesSchema,
  listPersonStepsSchema,
  recordStepSchema,
  listStepPrograms,
  listStepTypes,
  listPersonSteps,
  recordStep,
  ListStepProgramsParams,
  ListStepTypesParams,
  ListPersonStepsParams,
  RecordStepParams,
} from './tools/steps.js';

import {
  getNotesSchema,
  addNoteSchema,
  getNotes,
  addNote,
  GetNotesParams,
  AddNoteParams,
} from './tools/notes.js';

import {
  listSchedulesSchema,
  getScheduleSchema,
  listSchedules,
  getSchedule,
  ListSchedulesParams,
  GetScheduleParams,
} from './tools/schedules.js';

import {
  listWorkflowTypesSchema,
  launchWorkflowSchema,
  listWorkflowTypes,
  launchWorkflow,
  ListWorkflowTypesParams,
  LaunchWorkflowParams,
} from './tools/workflows.js';

import {
  listTagsSchema,
  listTags,
  ListTagsParams,
} from './tools/tags.js';

import {
  searchCommunicationsSchema,
  getCommunicationSchema,
  searchCommunications,
  getCommunication,
  SearchCommunicationsParams,
  GetCommunicationParams,
} from './tools/communications.js';

import {
  rockCreateSchema,
  rockEditSchema,
  rockDeleteSchema,
  rockCreate,
  rockEdit,
  rockDelete,
  RockCreateParams,
  RockEditParams,
  RockDeleteParams,
} from './tools/rock-write.js';

import {
  createPageBundleSchema,
  createPageBundle,
  CreatePageBundleParams,
} from './tools/page-bundle.js';

import {
  rockRestoreSchema,
  rockRestore,
  RockRestoreParams,
} from './tools/rock-restore.js';

import {
  getBlockContentSchema,
  getBlockContent,
  GetBlockContentParams,
  editBlockContentSchema,
  editBlockContent,
  EditBlockContentParams,
} from './tools/block-content.js';

import { runWriteTool } from './safety/index.js';
import { appendAudit } from './safety/audit.js';
import { resolveGitIdentity } from './safety/gitIdentity.js';
import { createHash } from 'node:crypto';

// All tool schemas
const ALL_TOOLS = [
  buildGuideSchema,
  // People (read + write)
  searchPeopleSchema,
  getPersonSchema,
  updatePersonSchema,
  updatePersonAddressSchema,
  updatePersonPhoneSchema,
  addPersonTagSchema,
  removePersonTagSchema,
  // Groups (read + write)
  searchGroupsSchema,
  getGroupSchema,
  updateGroupSchema,
  addGroupMemberSchema,
  removeGroupMemberSchema,
  // Attendance (read + write)
  searchAttendanceSchema,
  recordAttendanceSchema,
  // Giving (read only)
  searchGivingSchema,
  // Metrics (read + guarded upsert: create = light, update = two-phase)
  getMetricsSchema,
  listMetricCategoriesSchema,
  upsertMetricValueSchema,
  // SQL (read only)
  executeSqlSchema,
  getSchemaSchema,
  // Reservations (read + write)
  searchReservationsSchema,
  createReservationSchema,
  updateReservationSchema,
  // Content Channels (read only)
  searchContentChannelsSchema,
  searchContentChannelItemsSchema,
  getContentChannelItemSchema,
  // Defined Types & Values (read only)
  listDefinedTypesSchema,
  listDefinedValuesSchema,
  getDefinedValueSchema,
  // Campuses (read only)
  listCampusesSchema,
  getCampusSchema,
  // Attributes (read + write)
  listAttributesSchema,
  getPersonAttributesSchema,
  setPersonAttributeSchema,
  // Steps (read + write)
  listStepProgramsSchema,
  listStepTypesSchema,
  listPersonStepsSchema,
  recordStepSchema,
  // Notes (read + write)
  getNotesSchema,
  addNoteSchema,
  // Schedules (read only)
  listSchedulesSchema,
  getScheduleSchema,
  // Workflows (read + write)
  listWorkflowTypesSchema,
  launchWorkflowSchema,
  // Tags discovery (read only)
  listTagsSchema,
  // Communications (read only)
  searchCommunicationsSchema,
  getCommunicationSchema,
  // Block content (read only) — exact-bytes HtmlContent read for blocks
  getBlockContentSchema,
  // Block content (guarded write) — byte-exact, SHA-verified surgical edit; two-phase stop
  editBlockContentSchema,
  // Guarded build writes (create = light; edit/delete = two-phase stop)
  rockCreateSchema,
  rockEditSchema,
  rockDeleteSchema,
  // Composite build write (create = light) — the full Page/Route/Block/HtmlContent/Auth recipe in one call
  createPageBundleSchema,
  // Undo a past ledgered write (two-phase, same stop rule as rock_edit)
  rockRestoreSchema,
  // Cache flush (benign metadata PATCH to bust Rock's server cache after a write)
  flushCacheSchema,
];

/**
 * Build a fresh MCP Server instance with all tool handlers wired up.
 * One Server per session: the MCP SDK couples a Server 1:1 with a Transport,
 * so HTTP mode needs a new Server per connecting client.
 */
// Server-level guidance handed to the MCP client (Claude). Encodes the team's write policy
// so it travels with the server rather than relying on per-session discovery.
const SERVER_INSTRUCTIONS = `Rock RMS tools for ChatGPT Chat, Work and local agents. Call get_build_guide (topic start or build) for instructions; it works without local file access. Read the following policy before any write.

This server can BUILD Rock objects (pages, blocks, attributes, workflows, auths) and edit data. Writes follow ONE rule: create = light, edit/delete = stop.

1. CREATE new objects with rock_create. It executes immediately and is logged to an audit ledger (logs/changes.jsonl) + manifest. Prefer building with brand-new objects. Building a new page+block+content+auth bundle in one call? Use create_page_bundle (create-light, per-object ledgered, undoable via rock_restore) instead of five separate rock_create calls.
2. EDIT or DELETE anything that already existed with rock_edit / rock_delete — a two-phase action. Your FIRST call (omit confirmation_token) returns a PREVIEW: the intended change, an impact analysis (what reports/pages/blocks reference the target), and a before-snapshot, plus a confirmation_token. STOP and show the user the impact analysis and snapshot. Only after they approve, re-call the SAME tool with identical arguments plus the confirmation_token to execute. Never run the second phase without showing the preview. Made a mistake, or need to undo a past write? rock_restore reverses a chosen ledgered write (list recent writes, pick an auditId, then the SAME two-phase preview/confirmation_token handshake — HARD-STOP before executing).
3. Build via MCP, verify via Chrome. Construct objects with these tools, then verify the result in the Rock admin UI (Claude in Chrome) before reporting done.
4. Use only the configured church target. Discover its Rock version, IDs, role and controller permissions; never reuse IDs from examples. Prefer a sandbox. Each environment has separate credentials and audit logs. Use the optional rock-change-management skill for reviewed promotion.
5. execute_sql is READ-ONLY and cannot write. Write-SQL is reachable only through rock_create/rock_edit/rock_delete with mode:"sql", for cases REST can't handle (e.g. WorkflowActionType, whose REST POST hangs — pass cacheFlushWorkflowTypeId after inserting action rows). For mode:"sql" INSERTs, verifyByGuid must be the literal Guid inlined in the SQL (never NEWID()); if a verify step fails, the INSERT may still have committed — check with execute_sql before retrying (a blind retry duplicates the row or hits a duplicate-key error). The raw api/Workflows entity POST also hangs — launch workflows only through launch_workflow (WorkflowEntry). Write metric values through upsert_metric_value (duplicate-checked, partition-aware, previews overwrites), not raw rock_create on MetricValues. HtmlContent/Lava edits go through edit_block_content (byte-exact, SHA-verified surgical replace/insert), not raw rock_edit on Content — the model must never retype block content by hand.
6. Every write tool requires a reason: one plain sentence saying why. An empty reason is refused. The reason is recorded in the ledger and is part of the confirmation token, so changing it needs a fresh preview. The older data-write tools follow the same rule as rock_create/rock_edit/rock_delete: add_person_tag, add_group_member, record_attendance, add_note, record_step, create_reservation and launch_workflow run at once and are ledgered; update_person, update_person_address, update_person_phone, remove_person_tag, set_person_attribute, remove_group_member, update_group and update_reservation are two-phase (preview + confirmation_token first, show the user, then the same call with the token). rock_restore undoes them, except launch_workflow (its actions have already run). One call may not touch more than ROCK_MCP_BULK_WRITE_MAX rows (default 25) unless it passes allowBulk:true. Refused writes are ledgered too (phase "denied"). Every executed write re-reads its target and reports verified:true/false; when verified is false or the outcome is uncertain, check in Rock before retrying — no write is ever retried automatically. mode:"sql" writes pass a preflight first (GETDATE() is refused unless ROCK_TIMEZONE names the Rock server's time zone; required columns, IsSystem rows, GroupMember.GroupTypeId and audit columns are checked or added) and an Auth lockout guard.
6a. Every write is stamped with your git identity in the ledger alongside its dedicated REST key identity — keep git user.email/user.name set. The git identity is the SAME for every concurrent session on this machine, so it cannot answer "did MY session touch prod" by itself — pass session_tag (your Claude session id) on write calls so that question is answerable later from the ledger.
7. SQL tips: before writing ad-hoc SQL against an unfamiliar table, call get_schema("TableName") to list its columns instead of guessing (a curated crib of the ~40 most-used tables is at reference/rock-schema-crib.md; its response also reports this server's build sha/branch and Rock target — check it if a long-lived MCP connection is behaving unexpectedly, since a rebuild does not reach an already-running process). Leading -- comments are stripped safely; a DECLARE/SET prologue before the final SELECT is allowed; queries are bounded by a ~45s server-side timeout and results are truncated at ~40k chars (use SELECT TOP N / aggregates for big sets, or pass execute_sql's optional limit param instead of hand-writing TOP yourself). Rock has literal columns named Order, Group, etc. — bracket them ([Order]) everywhere, not just in ORDER BY. To search stored content for Lava delimiters, build the pattern with CHAR() concatenation (CHAR(123)+CHAR(37)); literal {{ / {% in a query is rejected. Person attributes live in AttributeValue (join EntityId = Person.Id AND AttributeId = <id>) — AttributeValue is NOT a REST entity, so it's reachable via SQL only. AttributeQualifier has no ModifiedDateTime column (an UPDATE that sets it fails).
8. Cache flush after a direct write: use flush_cache (target "htmlcontent"/"block" → ApprovedDateTime PATCH, fires FlushCachedContent; "workflowtype" → ModifiedDateTime PATCH to rebuild the workflow cache; "page" → ModifiedDateTime PATCH that refreshes the page's cached properties AND its cached block list (new blocks render after it); "blocksettings" → ModifiedDateTime PATCH that refreshes the block's own cached record after changing its settings/PreHtml/PostHtml by SQL or REST). flush_cache requires EXACTLY target + id — {}, {scope:"all"}, {target:"all"}, and {cache_type, entity_id} are all rejected up front with the valid-shapes list, not run as a broken query. Not covered by flush_cache: route registration for a REST-created PageRoute → "node ~/rock-build-kit/tools/rock-ui/rock-ui.mjs [--prod] route save <PageRouteId>"; Auth rows written by REST/SQL → "rock-ui security resave <page|block|attribute|restcontroller|entityTypeId> <id>"; anything else → "node ~/rock-build-kit/tools/rock-ui/rock-ui.mjs [--prod] cache clear" (a full clear-all; since v18 Cache Manager "Clear Cache" reaches every web server).
9. Binary file content over the API key must transport as HEX, never base64: read with SELECT CONVERT(varchar(max), Content, 2), write with CONVERT(varbinary(max), '<hex>', 2). base64-over-Lava (FOR XML BASE64 / xs:base64Binary) silently corrupts through the {% sql %} render path. GetFile.ashx / FileUploader.ashx require a session COOKIE, not the API key — the SQL hex path is the headless route.`;

function createMcpServer(rockClient: RockClient): Server {
  const server = new Server(
    {
      name: 'rock-rms-mcp-server-v2',
      version: '2.2.0',
    },
    {
      capabilities: {
        tools: {},
      },
      instructions: SERVER_INSTRUCTIONS,
    }
  );

  wireHandlers(server, rockClient);
  return server;
}

async function callTool(rockClient: RockClient, name: string, args: Record<string, unknown> | undefined): Promise<unknown> {
  switch (name) {
    case 'search_people':
      return await searchPeople(rockClient, args as SearchPeopleParams);

    case 'get_person':
      return await getPerson(rockClient, args as unknown as GetPersonParams);

    case 'search_groups':
      return await searchGroups(rockClient, args as SearchGroupsParams);

    case 'get_group':
      return await getGroup(rockClient, args as unknown as GetGroupParams);

    case 'search_attendance':
      return await searchAttendance(rockClient, args as SearchAttendanceParams);

    case 'search_giving':
      return await searchGiving(rockClient, args as SearchGivingParams);

    case 'get_metrics':
      return await getMetrics(rockClient, args as unknown as GetMetricsParams);

    case 'list_metric_categories':
      return await listMetricCategories(rockClient, args as ListMetricCategoriesParams);

    case 'upsert_metric_value':
      return await upsertMetricValue(rockClient, args as unknown as UpsertMetricValueParams);

    case 'execute_sql':
      return await executeSql(rockClient, args as unknown as ExecuteSqlParams);

    case 'get_schema':
      return await getSchema(rockClient, args as unknown as GetSchemaParams);

    case 'get_build_guide':
      return await getBuildGuide(args as { topic?: string });

    case 'flush_cache':
      // No cast to FlushCacheParams here — flushCache validates the raw args itself
      // (validateFlushCacheParams) rather than trusting a type assertion that the MCP
      // SDK never actually checks against inputSchema at runtime.
    {
      // Cache flushes PATCH Rock rows, so they are ledgered. No reason is required: a cache
      // flush only bumps a timestamp so Rock rebuilds its cached copy; it changes no content.
      const out = await flushCache(rockClient, args);
      const a = (args ?? {}) as Record<string, unknown>;
      const ts = new Date().toISOString();
      await appendAudit({
        auditId: createHash('sha256').update(`flush|${ts}|${JSON.stringify(a)}`).digest('hex').slice(0, 16),
        ts,
        phase: 'executed',
        operator: resolveGitIdentity(),
        tool: 'flush_cache',
        verb: 'edit',
        mode: 'rest',
        target: { entityType: String(a.target ?? 'unknown'), id: a.id as number | undefined },
        reason: 'cache flush (no reason required)',
        result: { success: true },
      }).catch(() => false);
      return out;
    }

    case 'search_reservations':
      return await searchReservations(rockClient, args as SearchReservationsParams);

    case 'search_content_channels':
      return await searchContentChannels(rockClient, args as SearchContentChannelsParams);

    case 'search_content_channel_items':
      return await searchContentChannelItems(rockClient, args as SearchContentChannelItemsParams);

    case 'get_content_channel_item':
      return await getContentChannelItem(rockClient, args as unknown as GetContentChannelItemParams);

    // Write tools - People
    case 'update_person':
      return await updatePerson(rockClient, args as unknown as UpdatePersonParams);

    case 'update_person_address':
      return await updatePersonAddress(rockClient, args as unknown as UpdatePersonAddressParams);

    case 'update_person_phone':
      return await updatePersonPhone(rockClient, args as unknown as UpdatePersonPhoneParams);

    case 'add_person_tag':
      return await addPersonTag(rockClient, args as unknown as AddPersonTagParams);

    case 'remove_person_tag':
      return await removePersonTag(rockClient, args as unknown as RemovePersonTagParams);

    // Write tools - Groups
    case 'update_group':
      return await updateGroup(rockClient, args as unknown as UpdateGroupParams);

    case 'add_group_member':
      return await addGroupMember(rockClient, args as unknown as AddGroupMemberParams);

    case 'remove_group_member':
      return await removeGroupMember(rockClient, args as unknown as RemoveGroupMemberParams);

    // Write tools - Attendance
    case 'record_attendance':
      return await recordAttendance(rockClient, args as unknown as RecordAttendanceParams);

    // Write tools - Reservations
    case 'create_reservation':
      return await createReservation(rockClient, args as unknown as CreateReservationParams);

    case 'update_reservation':
      return await updateReservation(rockClient, args as unknown as UpdateReservationParams);

    // Defined Types & Values
    case 'list_defined_types':
      return await listDefinedTypes(rockClient, args as ListDefinedTypesParams);

    case 'list_defined_values':
      return await listDefinedValues(rockClient, args as ListDefinedValuesParams);

    case 'get_defined_value':
      return await getDefinedValue(rockClient, args as unknown as GetDefinedValueParams);

    // Campuses
    case 'list_campuses':
      return await listCampuses(rockClient, args as ListCampusesParams);

    case 'get_campus':
      return await getCampus(rockClient, args as unknown as GetCampusParams);

    // Attributes
    case 'list_attributes':
      return await listAttributes(rockClient, args as ListAttributesParams);

    case 'get_person_attributes':
      return await getPersonAttributes(rockClient, args as unknown as GetPersonAttributesParams);

    case 'set_person_attribute':
      return await setPersonAttribute(rockClient, args as unknown as SetPersonAttributeParams);

    // Steps
    case 'list_step_programs':
      return await listStepPrograms(rockClient, args as ListStepProgramsParams);

    case 'list_step_types':
      return await listStepTypes(rockClient, args as ListStepTypesParams);

    case 'list_person_steps':
      return await listPersonSteps(rockClient, args as unknown as ListPersonStepsParams);

    case 'record_step':
      return await recordStep(rockClient, args as unknown as RecordStepParams);

    // Notes
    case 'get_notes':
      return await getNotes(rockClient, args as GetNotesParams);

    case 'add_note':
      return await addNote(rockClient, args as unknown as AddNoteParams);

    // Schedules
    case 'list_schedules':
      return await listSchedules(rockClient, args as ListSchedulesParams);

    case 'get_schedule':
      return await getSchedule(rockClient, args as unknown as GetScheduleParams);

    // Workflows
    case 'list_workflow_types':
      return await listWorkflowTypes(rockClient, args as ListWorkflowTypesParams);

    case 'launch_workflow':
      return await launchWorkflow(rockClient, args as unknown as LaunchWorkflowParams);

    // Tags discovery
    case 'list_tags':
      return await listTags(rockClient, args as ListTagsParams);

    // Communications
    case 'search_communications':
      return await searchCommunications(rockClient, args as SearchCommunicationsParams);

    case 'get_communication':
      return await getCommunication(rockClient, args as unknown as GetCommunicationParams);

    // Block content
    case 'get_block_content':
      return await getBlockContent(rockClient, args as unknown as GetBlockContentParams);

    case 'edit_block_content':
      return await editBlockContent(rockClient, args as unknown as EditBlockContentParams);

    // Guarded build writes (create = light; edit/delete = two-phase stop)
    case 'rock_create':
      return await rockCreate(rockClient, args as unknown as RockCreateParams);

    case 'rock_edit':
      return await rockEdit(rockClient, args as unknown as RockEditParams);

    case 'rock_delete':
      return await rockDelete(rockClient, args as unknown as RockDeleteParams);

    case 'create_page_bundle':
      return await createPageBundle(rockClient, args as unknown as CreatePageBundleParams);

    case 'rock_restore':
      return await rockRestore(rockClient, args as unknown as RockRestoreParams);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function wireHandlers(server: Server, rockClient: RockClient): void {
  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: ALL_TOOLS.map(tool => ({ ...tool, annotations: {
        readOnlyHint: /^(search_|get_|list_)/.test(tool.name) || tool.name === 'execute_sql',
        destructiveHint: !(/^(search_|get_|list_)/.test(tool.name) || tool.name === 'execute_sql' || tool.name === 'rock_create' || tool.name === 'create_page_bundle'),
        openWorldHint: true,
      } })),
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const startedAt = Date.now();

      try {
        // Every write tool runs under the shared write rules (reason required, dev bundle gate,
        // bulk cap, refusals ledgered); read tools pass straight through.
        const result = withNextStep(name, await runWriteTool(name, args, () => callTool(rockClient, name, args)));

        logToolCall({
          tool: name,
          args,
          status: 'ok',
          durationMs: Date.now() - startedAt,
          result,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage = errorWithNextStep(name, error instanceof Error ? error.message : String(error));
        logToolCall({
          tool: name,
          args,
          status: 'error',
          durationMs: Date.now() - startedAt,
          error: errorMessage,
        });
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
}

async function runStdio(rockClient: RockClient): Promise<void> {
  const server = createMcpServer(rockClient);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Rock RMS MCP Server running on stdio');
}

async function runHttp(rockClient: RockClient, port: number, bearerToken: string): Promise<void> {
  const expectedToken = Buffer.from(bearerToken, 'utf8');

  const checkAuth = (req: IncomingMessage): boolean => {
    const header = req.headers['authorization'];
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const got = Buffer.from(header.slice(7), 'utf8');
    if (got.length !== expectedToken.length) return false;
    return timingSafeEqual(got, expectedToken);
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch (e) {
          reject(e);
        }
      });
      req.on('error', reject);
    });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const isInitializeRequest = (body: unknown): boolean => {
    if (!body || typeof body !== 'object') return false;
    const b = body as Record<string, unknown>;
    if (b.method === 'initialize') return true;
    if (Array.isArray(b)) {
      return (b as unknown[]).some(
        (m) => typeof m === 'object' && m !== null && (m as Record<string, unknown>).method === 'initialize'
      );
    }
    return false;
  };

  const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = req.url ?? '/';
      const pathname = url.split('?')[0];

      if (req.method === 'GET' && pathname === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('ok');
        return;
      }

      // Accept /mcp (header-auth) or /mcp/<token> (URL-embedded token,
      // for clients like Claude.ai's connector UI that can't send custom headers).
      const mcpPathMatch = pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
      if (!mcpPathMatch) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      const pathToken = mcpPathMatch[1] ? decodeURIComponent(mcpPathMatch[1]) : undefined;
      const pathAuthOk = (() => {
        if (!pathToken) return false;
        const got = Buffer.from(pathToken, 'utf8');
        if (got.length !== expectedToken.length) return false;
        return timingSafeEqual(got, expectedToken);
      })();

      if (!checkAuth(req) && !pathAuthOk) {
        res.writeHead(401, {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="rock-mcp"',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      const sessionId =
        typeof req.headers['mcp-session-id'] === 'string'
          ? (req.headers['mcp-session-id'] as string)
          : undefined;

      let transport: StreamableHTTPServerTransport | undefined = sessionId
        ? transports.get(sessionId)
        : undefined;

      const body = req.method === 'POST' ? await readBody(req) : undefined;

      if (!transport) {
        if (req.method !== 'POST' || !isInitializeRequest(body)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
              id: null,
            })
          );
          return;
        }

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            transports.set(id, transport!);
            console.error(`Session initialized: ${id} (active: ${transports.size})`);
          },
        });
        transport.onclose = () => {
          if (transport && transport.sessionId) {
            transports.delete(transport.sessionId);
            console.error(`Session closed: ${transport.sessionId} (active: ${transports.size})`);
          }
        };
        const mcpServer = createMcpServer(rockClient);
        await mcpServer.connect(transport);
      }

      await transport.handleRequest(req, res, body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Request error:', msg);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal_error', message: msg }));
      }
    }
  });

  httpServer.listen(port, '0.0.0.0', () => {
    console.error(`Rock RMS MCP Server running on http://0.0.0.0:${port} (POST /mcp)`);
  });

  const shutdown = async (signal: string) => {
    console.error(`Received ${signal}, shutting down...`);
    httpServer.close();
    for (const t of transports.values()) {
      await t.close().catch(() => undefined);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

async function main(): Promise<void> {
  // Build identity banner — first thing logged, every start, both transports. Long-lived
  // processes (rock-v2/rock-rms-v2/rock-dev all run the same dist/index.js) each keep
  // whatever build they started with; this makes which one you're talking to visible instead
  // of assumed. See reference/rock-sessions-lessons-2026-08-15.md L2 for the incident this
  // is meant to prevent — two aliases silently serving different dist/ builds.
  console.error(
    `Rock RMS MCP Server build ${BUILD_SHA}${BUILD_DIRTY ? '-dirty' : ''} (branch ${BUILD_BRANCH}, built ${BUILD_TIME}, pid ${process.pid})`
  );
  const rockClient = createRockClient();
  if (process.env.TRANSPORT === 'http') {
    const port = Number.parseInt(process.env.PORT ?? '8080', 10);
    const token = process.env.MCP_BEARER_TOKEN;
    if (!token || token.length < 16) {
      console.error('MCP_BEARER_TOKEN env var is required (>= 16 chars) for HTTP transport');
      process.exit(1);
    }
    await runHttp(rockClient, port, token);
  } else {
    await runStdio(rockClient);
  }
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
