#!/usr/bin/env node

/**
 * Rock RMS MCP Server
 * A read-only MCP server for interacting with Rock RMS REST API
 */

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

import { checkBundleGate } from './safety/index.js';

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
6. Every write is stamped with your git identity in the ledger alongside its dedicated REST key identity — keep git user.email/user.name set. The git identity is the SAME for every concurrent session on this machine, so it cannot answer "did MY session touch prod" by itself — pass session_tag (your Claude session id) on rock_create/rock_edit/rock_delete/rock_restore/create_page_bundle/edit_block_content/upsert_metric_value so that question is answerable later from the ledger.
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
        let result: unknown;

        const bundleRefusal = checkBundleGate(name);
        if (bundleRefusal) throw new Error(bundleRefusal);

        switch (name) {
          case 'search_people':
            result = await searchPeople(rockClient, args as SearchPeopleParams);
            break;

          case 'get_person':
            result = await getPerson(rockClient, args as unknown as GetPersonParams);
            break;

          case 'search_groups':
            result = await searchGroups(rockClient, args as SearchGroupsParams);
            break;

          case 'get_group':
            result = await getGroup(rockClient, args as unknown as GetGroupParams);
            break;

          case 'search_attendance':
            result = await searchAttendance(rockClient, args as SearchAttendanceParams);
            break;

          case 'search_giving':
            result = await searchGiving(rockClient, args as SearchGivingParams);
            break;

          case 'get_metrics':
            result = await getMetrics(rockClient, args as unknown as GetMetricsParams);
            break;

          case 'list_metric_categories':
            result = await listMetricCategories(rockClient, args as ListMetricCategoriesParams);
            break;

          case 'upsert_metric_value':
            result = await upsertMetricValue(rockClient, args as unknown as UpsertMetricValueParams);
            break;

          case 'execute_sql':
            result = await executeSql(rockClient, args as unknown as ExecuteSqlParams);
            break;

          case 'get_build_guide':
            result = await getBuildGuide(args as {topic?:string});
            break;

          case 'get_schema':
            result = await getSchema(rockClient, args as unknown as GetSchemaParams);
            break;

          case 'flush_cache':
            // No cast to FlushCacheParams here — flushCache validates the raw args itself
            // (validateFlushCacheParams) rather than trusting a type assertion that the MCP
            // SDK never actually checks against inputSchema at runtime.
            result = await flushCache(rockClient, args);
            break;

          case 'search_reservations':
            result = await searchReservations(rockClient, args as SearchReservationsParams);
            break;

          case 'search_content_channels':
            result = await searchContentChannels(rockClient, args as SearchContentChannelsParams);
            break;

          case 'search_content_channel_items':
            result = await searchContentChannelItems(rockClient, args as SearchContentChannelItemsParams);
            break;

          case 'get_content_channel_item':
            result = await getContentChannelItem(rockClient, args as unknown as GetContentChannelItemParams);
            break;

          // Write tools - People
          case 'update_person':
            result = await updatePerson(rockClient, args as unknown as UpdatePersonParams);
            break;

          case 'update_person_address':
            result = await updatePersonAddress(rockClient, args as unknown as UpdatePersonAddressParams);
            break;

          case 'update_person_phone':
            result = await updatePersonPhone(rockClient, args as unknown as UpdatePersonPhoneParams);
            break;

          case 'add_person_tag':
            result = await addPersonTag(rockClient, args as unknown as AddPersonTagParams);
            break;

          case 'remove_person_tag':
            result = await removePersonTag(rockClient, args as unknown as RemovePersonTagParams);
            break;

          // Write tools - Groups
          case 'update_group':
            result = await updateGroup(rockClient, args as unknown as UpdateGroupParams);
            break;

          case 'add_group_member':
            result = await addGroupMember(rockClient, args as unknown as AddGroupMemberParams);
            break;

          case 'remove_group_member':
            result = await removeGroupMember(rockClient, args as unknown as RemoveGroupMemberParams);
            break;

          // Write tools - Attendance
          case 'record_attendance':
            result = await recordAttendance(rockClient, args as unknown as RecordAttendanceParams);
            break;

          // Write tools - Reservations
          case 'create_reservation':
            result = await createReservation(rockClient, args as unknown as CreateReservationParams);
            break;

          case 'update_reservation':
            result = await updateReservation(rockClient, args as unknown as UpdateReservationParams);
            break;

          // Defined Types & Values
          case 'list_defined_types':
            result = await listDefinedTypes(rockClient, args as ListDefinedTypesParams);
            break;

          case 'list_defined_values':
            result = await listDefinedValues(rockClient, args as ListDefinedValuesParams);
            break;

          case 'get_defined_value':
            result = await getDefinedValue(rockClient, args as unknown as GetDefinedValueParams);
            break;

          // Campuses
          case 'list_campuses':
            result = await listCampuses(rockClient, args as ListCampusesParams);
            break;

          case 'get_campus':
            result = await getCampus(rockClient, args as unknown as GetCampusParams);
            break;

          // Attributes
          case 'list_attributes':
            result = await listAttributes(rockClient, args as ListAttributesParams);
            break;

          case 'get_person_attributes':
            result = await getPersonAttributes(rockClient, args as unknown as GetPersonAttributesParams);
            break;

          case 'set_person_attribute':
            result = await setPersonAttribute(rockClient, args as unknown as SetPersonAttributeParams);
            break;

          // Steps
          case 'list_step_programs':
            result = await listStepPrograms(rockClient, args as ListStepProgramsParams);
            break;

          case 'list_step_types':
            result = await listStepTypes(rockClient, args as ListStepTypesParams);
            break;

          case 'list_person_steps':
            result = await listPersonSteps(rockClient, args as unknown as ListPersonStepsParams);
            break;

          case 'record_step':
            result = await recordStep(rockClient, args as unknown as RecordStepParams);
            break;

          // Notes
          case 'get_notes':
            result = await getNotes(rockClient, args as GetNotesParams);
            break;

          case 'add_note':
            result = await addNote(rockClient, args as unknown as AddNoteParams);
            break;

          // Schedules
          case 'list_schedules':
            result = await listSchedules(rockClient, args as ListSchedulesParams);
            break;

          case 'get_schedule':
            result = await getSchedule(rockClient, args as unknown as GetScheduleParams);
            break;

          // Workflows
          case 'list_workflow_types':
            result = await listWorkflowTypes(rockClient, args as ListWorkflowTypesParams);
            break;

          case 'launch_workflow':
            result = await launchWorkflow(rockClient, args as unknown as LaunchWorkflowParams);
            break;

          // Tags discovery
          case 'list_tags':
            result = await listTags(rockClient, args as ListTagsParams);
            break;

          // Communications
          case 'search_communications':
            result = await searchCommunications(rockClient, args as SearchCommunicationsParams);
            break;

          case 'get_communication':
            result = await getCommunication(rockClient, args as unknown as GetCommunicationParams);
            break;

          // Block content
          case 'get_block_content':
            result = await getBlockContent(rockClient, args as unknown as GetBlockContentParams);
            break;

          case 'edit_block_content':
            result = await editBlockContent(rockClient, args as unknown as EditBlockContentParams);
            break;

          // Guarded build writes (create = light; edit/delete = two-phase stop)
          case 'rock_create':
            result = await rockCreate(rockClient, args as unknown as RockCreateParams);
            break;

          case 'rock_edit':
            result = await rockEdit(rockClient, args as unknown as RockEditParams);
            break;

          case 'rock_delete':
            result = await rockDelete(rockClient, args as unknown as RockDeleteParams);
            break;

          case 'create_page_bundle':
            result = await createPageBundle(rockClient, args as unknown as CreatePageBundleParams);
            break;

          case 'rock_restore':
            result = await rockRestore(rockClient, args as unknown as RockRestoreParams);
            break;

          default:
            throw new Error(`Unknown tool: ${name}`);
        }

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
        const errorMessage = error instanceof Error ? error.message : String(error);
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
