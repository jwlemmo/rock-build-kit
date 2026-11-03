/**
 * Schema discovery tool — stop guessing column names.
 *
 * Backed by INFORMATION_SCHEMA via the read-only Lava {% sql %} path. Results are cached
 * per process (schema rarely changes between deploys). A curated crib of the ~40 most-used
 * tables also lives at reference/rock-schema-crib.md, generated from the live OpenAPI spec.
 */
import { RockClient } from '../rock-client.js';
import { BUILD_SHA, BUILD_BRANCH, BUILD_DIRTY, BUILD_TIME } from '../generated/build-info.js';

export interface GetSchemaParams {
  table: string;
}

/**
 * Which build/target this server process is — attached to every get_schema response (not a
 * dedicated tool) so a session can ask "what build am I talking to" via a call it's already
 * making constantly, without registering a new tool. See reference/rock-sessions-lessons
 * L2/L3: rock-v2/rock-rms-v2/rock-dev are long-lived processes that can each be serving a
 * different dist/ build, and the alias name alone doesn't say which Rock instance it targets.
 */
function serverIdentity(client: RockClient): {
  buildSha: string;
  buildBranch: string;
  buildDirty: boolean;
  buildTime: string;
  rockTarget: string;
} {
  return {
    buildSha: BUILD_SHA,
    buildBranch: BUILD_BRANCH,
    buildDirty: BUILD_DIRTY,
    buildTime: BUILD_TIME,
    rockTarget: client.v1Base,
  };
}

export const getSchemaSchema = {
  name: 'get_schema',
  description:
    'Return the columns and types of a Rock RMS database table, straight from ' +
    'INFORMATION_SCHEMA — call this BEFORE writing ad-hoc SQL against an unfamiliar table ' +
    'instead of guessing column names (a frequent source of "Invalid column name" errors). ' +
    'Pass a single exact table name, no schema prefix (e.g. "Person", "AttributeValue", ' +
    '"MetricValue", "GroupMember"). On a near-miss it suggests similarly-named tables. ' +
    'Results are cached per process. Every response also carries a `server` block (build git ' +
    'sha/branch/dirty flag/build time + the Rock instance URL this process targets) — the ' +
    'quickest way to check which build/target a long-lived MCP server process is actually ' +
    'serving.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      table: {
        type: 'string',
        description: 'The exact table name (letters/digits/underscore), e.g. "GroupMember".',
      },
    },
    required: ['table'],
  },
};

const cache = new Map<string, unknown>();

interface ColumnRow {
  COLUMN_NAME: string;
  DATA_TYPE: string;
  IS_NULLABLE: string;
  CHARACTER_MAXIMUM_LENGTH: number | null;
}

export async function getSchema(client: RockClient, params: GetSchemaParams): Promise<unknown> {
  // The value is inlined into SQL, so hard-sanitize to a bare identifier — a table name is
  // never anything but [A-Za-z0-9_]. This makes injection impossible on this path.
  const table = (params.table || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!table) {
    throw new Error('get_schema requires a table name (letters, digits, underscore only).');
  }
  const key = table.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const rows = (await client.executeSql(
    `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH ` +
      `FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = '${table}' ORDER BY ORDINAL_POSITION`
  )) as ColumnRow[];

  if (!Array.isArray(rows) || rows.length === 0) {
    // Near-miss recovery: suggest tables whose name contains the requested string.
    const like = (await client.executeSql(
      `SELECT TOP 25 TABLE_NAME FROM INFORMATION_SCHEMA.TABLES ` +
        `WHERE TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME LIKE '%${table}%' ORDER BY TABLE_NAME`
    )) as Array<{ TABLE_NAME: string }>;
    const suggestions = Array.isArray(like) ? like.map((r) => r.TABLE_NAME) : [];
    // Do not cache misses (the table may be created later).
    return {
      table,
      found: false,
      message:
        `No table named "${table}". ` +
        (suggestions.length
          ? `Similarly-named tables: ${suggestions.join(', ')}.`
          : 'No similarly-named tables found.'),
      server: serverIdentity(client),
    };
  }

  const columns = rows.map((r) => ({
    name: r.COLUMN_NAME,
    type:
      r.CHARACTER_MAXIMUM_LENGTH && r.CHARACTER_MAXIMUM_LENGTH > 0
        ? `${r.DATA_TYPE}(${r.CHARACTER_MAXIMUM_LENGTH})`
        : r.DATA_TYPE,
    nullable: r.IS_NULLABLE === 'YES',
  }));
  const result = { table, found: true, columnCount: columns.length, columns, server: serverIdentity(client) };
  cache.set(key, result);
  return result;
}
