/**
 * Lightweight usage logger for the Rock RMS MCP server.
 *
 * Appends one JSON line per tool call to a local log file, giving you an audit
 * trail of what Claude did through this MCP (tool name, parameters, timestamp,
 * duration, success/failure). It is intentionally:
 *   - fire-and-forget: never blocks or delays a tool call
 *   - crash-proof: any logging failure is swallowed, never bubbles to the client
 *   - file-only: writes to disk (never stdout), so it can't corrupt the stdio
 *     MCP protocol
 *
 * Config (env vars):
 *   ROCK_MCP_LOG=off         disable logging entirely
 *   ROCK_MCP_LOG_FILE=/path  override the log file location
 *                            (default: <repo>/logs/usage.jsonl)
 *
 * Note: only a *summary* of each result is logged (row counts, sizes) — never
 * the full result bodies — to keep the file small and avoid copying member data
 * into a plaintext log.
 */

import { appendFile } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ENABLED = (process.env.ROCK_MCP_LOG ?? '').toLowerCase() !== 'off';

// Compiled location is <repo>/dist/logger.js, so ../logs lands at <repo>/logs.
const LOG_FILE =
  process.env.ROCK_MCP_LOG_FILE ?? join(__dirname, '..', 'logs', 'usage.jsonl');

// Create the log directory once at startup (best-effort).
if (ENABLED) {
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
  } catch {
    // Ignore — logToolCall also no-ops if writes fail.
  }
}

export interface ToolCallLog {
  tool: string;
  args: unknown;
  status: 'ok' | 'error';
  durationMs: number;
  result?: unknown;
  error?: string;
}

const MAX_ARGS_CHARS = 8000;

/** Summarize a result for the log without copying full bodies / member data. */
function summarizeResult(result: unknown): unknown {
  if (Array.isArray(result)) return { type: 'array', count: result.length };
  if (result && typeof result === 'object') {
    return { type: 'object', keys: Object.keys(result as Record<string, unknown>).length };
  }
  if (typeof result === 'string') return { type: 'string', length: result.length };
  return { type: typeof result };
}

/** Serialize args, truncating anything unreasonably large. */
function safeArgs(args: unknown): unknown {
  try {
    const json = JSON.stringify(args);
    if (json && json.length > MAX_ARGS_CHARS) {
      return { _truncated: true, preview: json.slice(0, MAX_ARGS_CHARS) };
    }
    return args ?? null;
  } catch {
    return { _unserializable: true };
  }
}

/**
 * Append a single tool-call record. Returns immediately and never rejects, so a
 * logging problem can never break or slow down a tool call.
 */
export function logToolCall(entry: ToolCallLog): void {
  if (!ENABLED) return;

  const line =
    JSON.stringify({
      ts: new Date().toISOString(),
      tool: entry.tool,
      args: safeArgs(entry.args),
      status: entry.status,
      durationMs: entry.durationMs,
      ...(entry.status === 'ok' ? { result: summarizeResult(entry.result) } : {}),
      ...(entry.error ? { error: entry.error } : {}),
    }) + '\n';

  void appendFile(LOG_FILE, line).catch(() => {
    // Swallow — logging must never interfere with serving requests.
  });
}
