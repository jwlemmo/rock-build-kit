/**
 * Rock RMS API Client (v2-aware)
 *
 * Auth: send `Authorization-Token: <ROCK_API_KEY>` on every request.
 *
 * Endpoints:
 *   - v1: `${apiUrl}` (typically https://.../api) — used for the Lava SQL passthrough
 *     and for Reservations (no v2 controller exists for the reservations plugin)
 *   - v2: `${apiUrl}/v2/models` — preferred for entity CRUD; cleaner shapes, native
 *     POST /search with structured query bodies, camelCase responses
 *
 * Legacy cookie-session login (`/api/Auth/Login` with username/password) is no longer
 * supported. `ROCK_API_KEY` is required.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { removeComments } from './sql-validator.js';

// Query/request timeouts, env-overridable. Layered under the MCP client's own ~60s ceiling:
// Rock aborts a slow SELECT at SQL_TIMEOUT_SECONDS first (returns a Lava timeout error), then
// the fetch aborts at FETCH_TIMEOUT_MS if Rock/IIS itself hangs without responding at all.
const SQL_TIMEOUT_SECONDS = Number(process.env.ROCK_SQL_TIMEOUT_SECONDS) || 45;
const FETCH_TIMEOUT_MS = Number(process.env.ROCK_FETCH_TIMEOUT_MS) || 55000;

export interface RockClientConfig {
  apiUrl: string; // e.g. https://rock.example.com/api
  apiKey: string;
}

/**
 * Search query for v2 /search endpoints.
 *
 * Field names and filter syntax in this bag are **Linq.Dynamic** — NOT OData.
 * - Field names are the C# property names of the entity (PascalCase: `FirstName`,
 *   `LastName`, `TransactionDateTime`).
 * - Operators are C# style: `==`, `!=`, `&&`, `||`, `>=`, `<=`.
 * - String literals use double quotes: `Name == "RSR - Rock Administration"`.
 * - Substring: `Name.Contains("Production")`, prefix: `Name.StartsWith("Spring")`.
 * - Date literals are ISO date strings cast to DateTime: `TransactionDateTime >= DateTime("2026-04-02")`.
 * - Collection navigation: `TransactionDetails.Any(d => d.AccountId == 5)`.
 *
 * Responses come back as `{ count: N, items: [...] }`. v2Search returns `items` as
 * a bare array (unwrapped) for ergonomics; pass `returnEnvelope: true` to get the
 * full envelope.
 */
export interface V2SearchQuery {
  /** Linq.Dynamic where expression. Example: `FirstName == "Example" && LastName == "Person"`. */
  where?: string;
  /** Linq.Dynamic sort expression. Example: `TransactionDateTime descending`. */
  sort?: string;
  /** Maximum number of items to return. */
  limit?: number;
  /** Number of items to skip before returning (for pagination). */
  offset?: number;
  /** Linq.Dynamic select expression to reshape results (advanced). */
  select?: string;
  /** Linq.Dynamic groupBy expression (advanced). */
  groupBy?: string;
  /** Linq.Dynamic selectMany expression (advanced). */
  selectMany?: string;
  /** When true, return only the matching count (no items in body). */
  isCountOnly?: boolean;
  /** When true, return the full `{ count, items }` envelope; otherwise return `items`. */
  returnEnvelope?: boolean;
}

export class RockClient {
  private apiUrl: string;
  private apiKey: string;

  constructor(config: RockClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, '');
    this.apiKey = config.apiKey;
  }

  /** Get the configured v1 base URL (e.g. https://rock.example.com/api). */
  get v1Base(): string {
    return this.apiUrl;
  }

  /** Get the configured v2 base URL (e.g. https://rock.example.com/api/v2/models). */
  get v2Base(): string {
    return `${this.apiUrl}/v2/models`;
  }

  // -----------------------------
  // Internal request plumbing
  // -----------------------------

  private buildHeaders(contentType?: string): Record<string, string> {
    const h: Record<string, string> = {
      Accept: 'application/json',
      'Authorization-Token': this.apiKey,
    };
    if (contentType) h['Content-Type'] = contentType;
    return h;
  }

  /** Stringify a query-string param object, omitting undefined/null. */
  private static qs(params: Record<string, string | number | boolean | undefined | null>): string {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
    return parts.length ? `?${parts.join('&')}` : '';
  }

  /** Read response body as text for error reporting, with a length cap. */
  private static async readErrorBody(res: Response): Promise<string> {
    try {
      const t = await res.text();
      return t.length > 2000 ? t.slice(0, 2000) + '…' : t;
    } catch {
      return '';
    }
  }

  private async request(
    method: string,
    url: string,
    body?: unknown,
    contentType: string = 'application/json',
    retries?: number
  ): Promise<Response> {
    // Reads default to one retry on transient failures. Writes are NEVER auto-retried
    // unless the caller opts in: a timed-out or 5xx'd POST may still have committed
    // server-side, so a blind retry risks duplicate rows (learned live: the hung
    // api/Workflows POST). Callers with an idempotent POST (e.g. a Lava-rendered SELECT)
    // pass retries explicitly.
    const maxRetries = retries ?? (method === 'GET' ? 1 : 0);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Abort a hung request before the MCP client's own ~60s ceiling, so the caller gets a
      // clean, actionable timeout instead of an opaque "MCP request timed out".
      const controller = new AbortController();
      const timer = globalThis.setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method,
          headers: this.buildHeaders(body !== undefined ? contentType : undefined),
          body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
          signal: controller.signal,
        });
        // Retry on 5xx (transient server hiccups) when the caller allows it
        if (res.status >= 500 && attempt < maxRetries) {
          await sleep(500);
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        // An abort already consumed the full FETCH_TIMEOUT_MS — retrying would blow past
        // the MCP client's ~60s ceiling and surface as an opaque MCP -32001 timeout
        // instead of the clean error below. Fail fast on timeout, whatever the method.
        if ((err as { name?: string }).name === 'AbortError') break;
        if (attempt < maxRetries) {
          await sleep(500);
          continue;
        }
      } finally {
        globalThis.clearTimeout(timer);
      }
    }
    if (lastErr && (lastErr as { name?: string }).name === 'AbortError') {
      throw new Error(
        `Rock request timed out after ${FETCH_TIMEOUT_MS}ms (${method} ${url.split('?')[0]}) — ` +
          `the server did not respond. For a slow SELECT, add filters or aggregate ` +
          `server-side. For a write, VERIFY whether it landed (it may still complete ` +
          `server-side) before retrying.`
      );
    }
    throw lastErr instanceof Error ? lastErr : new Error(`Request failed: ${String(lastErr)}`);
  }

  // -----------------------------
  // v2 helpers (preferred for entity CRUD)
  // -----------------------------

  /**
   * GET a single record under v2 (e.g. `people/26513`, `groups/2/members`).
   *
   * `path` is appended to `${apiUrl}/v2/models/`. Pass query params as a plain object;
   * common params: `loadAttributes` ('Simple' | 'Expanded' | omitted), `attributeKeys`.
   */
  async v2Get<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined | null> = {}
  ): Promise<T> {
    const url = `${this.v2Base}/${path.replace(/^\//, '')}${RockClient.qs(params)}`;
    const res = await this.request('GET', url);
    if (!res.ok) {
      const text = await RockClient.readErrorBody(res);
      throw new Error(`Rock v2 GET ${path} → ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  /**
   * POST /search on a v2 controller (e.g. controller='people' → POST /api/v2/models/people/search).
   *
   * Returns `items` from the v2 response envelope by default. Pass
   * `query.returnEnvelope = true` to get the full `{ count, items }` shape.
   *
   * NOTE: filter syntax is **Linq.Dynamic** with PascalCase field names — not OData.
   * See {@link V2SearchQuery} for details and examples.
   */
  async v2Search<T>(controller: string, query: V2SearchQuery = {}): Promise<T> {
    const body: Record<string, unknown> = {};
    if (query.where !== undefined) body.where = query.where;
    if (query.sort !== undefined) body.sort = query.sort;
    if (query.limit !== undefined) body.limit = query.limit;
    if (query.offset !== undefined) body.offset = query.offset;
    if (query.select !== undefined) body.select = query.select;
    if (query.groupBy !== undefined) body.groupBy = query.groupBy;
    if (query.selectMany !== undefined) body.selectMany = query.selectMany;
    if (query.isCountOnly !== undefined) body.isCountOnly = query.isCountOnly;

    const url = `${this.v2Base}/${controller.replace(/^\//, '').replace(/\/$/, '')}/search`;
    const res = await this.request('POST', url, body);
    if (!res.ok) {
      const text = await RockClient.readErrorBody(res);
      throw new Error(`Rock v2 search ${controller} → ${res.status}: ${text}`);
    }
    const text = await res.text();
    if (!text) {
      return (query.returnEnvelope ? { count: 0, items: [] } : []) as T;
    }
    const parsed = JSON.parse(text);
    if (query.returnEnvelope) return parsed as T;
    // Default: return the items array. Rock v2 search returns { count, items }.
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.items)) {
      return parsed.items as T;
    }
    return parsed as T;
  }

  /** Create a new entity via v2 POST. Returns the new entity's `idKey` or numeric Id. */
  async v2Create<T>(controller: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.v2Base}/${controller.replace(/^\//, '').replace(/\/$/, '')}`;
    const res = await this.request('POST', url, body);
    if (!res.ok) {
      const text = await RockClient.readErrorBody(res);
      throw new Error(`Rock v2 POST ${controller} → ${res.status}: ${text}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** PATCH (partial update) a v2 record. */
  async v2Patch(path: string, body: Record<string, unknown>): Promise<void> {
    const url = `${this.v2Base}/${path.replace(/^\//, '')}`;
    const res = await this.request('PATCH', url, body);
    if (!res.ok) {
      const text = await RockClient.readErrorBody(res);
      throw new Error(`Rock v2 PATCH ${path} → ${res.status}: ${text}`);
    }
  }

  /** PUT (full update) a v2 record. */
  async v2Put(path: string, body: Record<string, unknown>): Promise<void> {
    const url = `${this.v2Base}/${path.replace(/^\//, '')}`;
    const res = await this.request('PUT', url, body);
    if (!res.ok) {
      const text = await RockClient.readErrorBody(res);
      throw new Error(`Rock v2 PUT ${path} → ${res.status}: ${text}`);
    }
  }

  /** DELETE a v2 record. */
  async v2Delete(path: string): Promise<void> {
    const url = `${this.v2Base}/${path.replace(/^\//, '')}`;
    const res = await this.request('DELETE', url);
    if (!res.ok) {
      const text = await RockClient.readErrorBody(res);
      throw new Error(`Rock v2 DELETE ${path} → ${res.status}: ${text}`);
    }
  }

  // -----------------------------
  // v1 helpers (only for endpoints with no v2 equivalent)
  // -----------------------------

  /** GET on the v1 base. Used for Reservations and any legacy endpoint. */
  async v1Get<T>(
    path: string,
    params: Record<string, string | number | undefined | null> = {}
  ): Promise<T> {
    const url = `${this.v1Base}/${path.replace(/^\//, '')}${RockClient.qs(params)}`;
    const res = await this.request('GET', url);
    if (!res.ok) {
      const text = await RockClient.readErrorBody(res);
      throw new Error(`Rock v1 GET ${path} → ${res.status}: ${text}`);
    }
    return (await res.json()) as T;
  }

  /** POST on the v1 base. */
  async v1Post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.v1Base}/${path.replace(/^\//, '')}`;
    const res = await this.request('POST', url, body);
    if (!res.ok) {
      const text = await RockClient.readErrorBody(res);
      throw new Error(`Rock v1 POST ${path} → ${res.status}: ${text}`);
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : ({} as T)) as T;
  }

  /** PATCH on the v1 base. */
  async v1Patch(path: string, body: Record<string, unknown>): Promise<void> {
    const url = `${this.v1Base}/${path.replace(/^\//, '')}`;
    const res = await this.request('PATCH', url, body);
    if (!res.ok) {
      const text = await RockClient.readErrorBody(res);
      throw new Error(`Rock v1 PATCH ${path} → ${res.status}: ${text}`);
    }
  }

  /** DELETE on the v1 base. */
  async v1Delete(path: string): Promise<void> {
    const url = `${this.v1Base}/${path.replace(/^\//, '')}`;
    const res = await this.request('DELETE', url);
    if (!res.ok) {
      const text = await RockClient.readErrorBody(res);
      throw new Error(`Rock v1 DELETE ${path} → ${res.status}: ${text}`);
    }
  }

  // -----------------------------
  // SQL (Lava-based passthrough on v1; no v2 equivalent exists)
  // -----------------------------

  /**
   * Execute a read-only SQL query via Rock's Lava `{% sql %}` block.
   *
   * Rock exposes no native REST SQL endpoint and v2 has nothing equivalent. The supported
   * path is to render a Lava template via `/api/Lava/RenderTemplate` that wraps the query
   * in a `{% sql %}` block (the Sql Lava command is enabled on that endpoint).
   *
   * SELECT-only enforcement is the caller's responsibility (see sql-validator.ts).
   */
  async executeSql<T>(query: string, _parameters?: Record<string, unknown>): Promise<T> {
    // Some MCP clients deliver multi-line queries with newlines escaped to literal
    // "\n"/"\r"/"\t" sequences, which reach SQL Server as stray backslashes and break
    // parsing. SQL is whitespace-insignificant, so collapse both literal-escaped and
    // real control whitespace to single spaces before embedding in the {% sql %} block.
    // Strip comments BEFORE collapsing whitespace: a leading `-- comment` line would otherwise
    // merge with the query on the newline-collapse below and comment the whole thing out (Rock
    // then returns "Cannot find table 0"). removeComments is literal-aware, so `--` inside a
    // string literal is preserved.
    const normalizedQuery = removeComments(query)
      .replace(/\\[rnt]/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .trim();
    // timeout:'N' (Lava SQL command param, Rock v12+) bounds a runaway query server-side.
    const template = `{% sql timeout:'${SQL_TIMEOUT_SECONDS}' %}${normalizedQuery}{% endsql %}{{ results | ToJSON }}`;
    // A SELECT is idempotent even though the render endpoint is a POST — allow one retry.
    const rendered = await this.renderLava(template, 1);
    return parseLavaRenderResult(rendered) as T;
  }

  /**
   * Execute a write (INSERT/UPDATE/DELETE) via Rock's Lava `{% sql statement:'command' %}`
   * block and return the rows-affected count.
   *
   * This generalizes the AUTHORIZED write passthrough proven in the new-hire-onboarding build
   * (build/rock.mjs `sqlCommand`) — for the cases REST can't handle (notably WorkflowActionType,
   * whose REST POST hangs). It is reachable ONLY through the guarded rock_create/rock_edit/
   * rock_delete tools (mode:"sql"), which validate the statement first (see sql-write-validator.ts).
   * `executeSql` above stays SELECT-only and separate — there is no flag that turns it into a write.
   */
  async executeSqlCommand(commandSql: string): Promise<number> {
    const normalized = removeComments(commandSql)
      .replace(/\\[rnt]/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .trim();
    const template = `{% sql statement:'command' %}${normalized}{% endsql %}rows={{ results }}`;
    const rendered = await this.renderLava(template);
    // renderLava returns the JSON-encoded HTTP body, e.g. "\"rows=1\"".
    let body = rendered;
    try {
      const parsed = JSON.parse(rendered);
      if (typeof parsed === 'string') body = parsed;
    } catch {
      // fall through with the raw body
    }
    if (/Lava Error/i.test(body)) {
      throw new Error('Rock SQL command error: ' + body.replace(/^"?Lava Error:\s*/i, '').slice(0, 800));
    }
    const m = body.match(/rows=(-?\d+)/);
    return m ? Number(m[1]) : 0;
  }

  /**
   * Render a Lava template via Rock's `/api/Lava/RenderTemplate` endpoint.
   * Returns the raw HTTP body (the endpoint JSON-encodes the rendered string).
   *
   * `retries` opts a caller into transient-failure retries (default 0, because a template
   * may carry a `statement:'command'` write — only pass >0 for idempotent templates).
   */
  async renderLava(template: string, retries?: number): Promise<string> {
    const url = `${this.v1Base}/Lava/RenderTemplate`;
    const res = await this.request('POST', url, template, 'application/json', retries);
    if (!res.ok) {
      const text = await RockClient.readErrorBody(res);
      throw new Error(`Rock Lava render → ${res.status}: ${text}`);
    }
    return res.text();
  }
}

// -----------------------------
// Lava result parsing (unchanged from v1 client — Lava is v1-only)
// -----------------------------

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function deepDecodeEntities(value: unknown): unknown {
  if (typeof value === 'string') return decodeHtmlEntities(value);
  if (Array.isArray(value)) return value.map(deepDecodeEntities);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepDecodeEntities(v);
    }
    return out;
  }
  return value;
}

/**
 * Parse the response from `/api/Lava/RenderTemplate`.
 *
 * The endpoint returns the rendered output as a JSON-encoded string. For a
 * `{% sql %}` + ToJSON template the rendered output is itself a JSON array, but the
 * renderer wraps it in surrounding quotes and HTML-encodes the content. So we parse
 * the outer JSON, surface Lava errors, strip the wrapping quotes, parse the inner
 * JSON, then HTML-decode string values.
 */
export function parseLavaRenderResult(httpBody: string): unknown {
  let rendered: unknown;
  try {
    rendered = JSON.parse(httpBody);
  } catch {
    return httpBody; // not JSON-wrapped — return as-is
  }
  if (typeof rendered !== 'string') return rendered;

  let s = rendered.trim();

  if (/^Lava Error:/i.test(s)) {
    throw new Error('Rock SQL/Lava error: ' + decodeHtmlEntities(s.replace(/^Lava Error:\s*/i, '')).trim());
  }

  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).trim();
  }

  try {
    return deepDecodeEntities(JSON.parse(s));
  } catch {
    return decodeHtmlEntities(s); // scalar (non-JSON) template output
  }
}

// -----------------------------
// Factory
// -----------------------------

export function createRockClient(): RockClient {
  const apiUrl = process.env.ROCK_API_URL;
  const apiKey = process.env.ROCK_API_KEY;

  if (!apiUrl) {
    throw new Error('ROCK_API_URL environment variable is required (e.g. https://rock.example.com/api)');
  }
  if (!apiKey) {
    // Migrating from username/password? Generate a REST Key in Rock (Admin Tools →
    // Settings → Security → REST Keys), grant the specific actions needed on this church's
    // controllers, then put the key in ROCK_API_KEY.
    throw new Error('ROCK_API_KEY environment variable is required (cookie auth is no longer supported)');
  }

  console.error('Rock RMS: header-auth (Authorization-Token) against', apiUrl);
  return new RockClient({ apiUrl, apiKey });
}
