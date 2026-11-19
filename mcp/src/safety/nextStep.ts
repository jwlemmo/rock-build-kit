/**
 * Spark-style answers for write tools: every result and every refusal tells the model its next
 * step (Spark's AgentToolHelper does the same for Rock's own agent tools). Read tools are left
 * alone so their result shapes don't change.
 */
import { isWriteTool } from './writeGuard.js';

export function withNextStep(tool: string, result: unknown): unknown {
  if (!isWriteTool(tool) || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  const r = result as Record<string, unknown>;
  if (typeof r.next === 'string' || typeof r.next_step === 'string') return result;
  let next: string;
  if (r.phase === 'preview') {
    next = `STOP. Show the user the preview above. Only after they say yes, call ${tool} again with the same arguments and the confirmation_token.`;
  } else if (r.written === false) {
    next = 'Nothing was written, and nothing else is needed.';
  } else if (r.verified === true) {
    const undo = typeof r.auditId === 'string' ? ` To undo it, use rock_restore with auditId ${r.auditId}.` : '';
    next = `Done, and confirmed by re-reading Rock. Tell the user what changed.${undo}`;
  } else if (r.verified === false) {
    next = 'Rock did not confirm this change. Check it with execute_sql before telling the user it worked, and do not retry blindly.';
  } else {
    next = 'Done. Re-read the target in Rock if the user needs proof that it changed.';
  }
  return { ...r, next };
}

export function errorWithNextStep(tool: string, message: string): string {
  if (!isWriteTool(tool) || /\bNext:/.test(message)) return message;
  if (/uncertain|could not be confirmed|may or may not|may still|VERIFY whether|not saved|retry blindly|write failed/i.test(message)) {
    return `${message}\nNext: check in Rock (execute_sql) whether the change landed before doing anything else. Do not retry blindly.`;
  }
  if (/confirmation token|preview/i.test(message)) return message;
  return `${message}\nNext: nothing was written. Fix what the message names and call again. If it is a permission or policy refusal, ask the user instead of working around it.`;
}
