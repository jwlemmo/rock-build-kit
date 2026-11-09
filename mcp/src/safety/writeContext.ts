/**
 * The write call in progress: which tool, why, and whether bulk was allowed.
 *
 * Set once per write-tool call by runWriteTool (writeGuard.ts) and read by the shared safety
 * pieces that every tool already calls — deriveToken (the reason is part of the token) and
 * appendAudit (the reason is stamped on every ledger record) — so the reason reaches every
 * token and ledger line without threading it through each tool by hand.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface WriteContext {
  tool: string;
  reason: string;
  sessionTag?: string;
  allowBulk: boolean;
}

const store = new AsyncLocalStorage<WriteContext>();

export function currentWriteContext(): WriteContext | undefined {
  return store.getStore();
}

export function runInWriteContext<T>(ctx: WriteContext, fn: () => Promise<T>): Promise<T> {
  return store.run(ctx, fn);
}
