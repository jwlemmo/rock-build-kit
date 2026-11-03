/**
 * Communications Tools for Rock RMS.
 *
 * Read-only. Lets you see what was sent (email blasts, SMS, push) and to whom,
 * but does not provide a send path — sending mass communications is intentionally
 * left to the Rock UI / approved automations.
 *
 * Tools:
 *   - search_communications — search Communication records by date, sender, subject
 *   - get_communication — get a single communication with its recipients summary
 */

import { RockClient } from '../rock-client.js';

function lq(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function whereAnd(clauses: Array<string | undefined>): string | undefined {
  const kept = clauses.filter((c): c is string => !!c && c.length > 0);
  return kept.length === 0 ? undefined : kept.join(' && ');
}

// ---------------- search_communications ----------------

export interface SearchCommunicationsParams {
  /** Subject substring */
  subject?: string;
  /** Sender PersonAlias Id (defaults to all) */
  senderPersonId?: number;
  /** Communication type: "Email", "SMS", "PushNotification" (matches CommunicationType enum) */
  communicationType?: string;
  /** Restrict to communications sent on/after this date (YYYY-MM-DD) */
  sentAfter?: string;
  /** Restrict to communications sent on/before this date (YYYY-MM-DD) */
  sentBefore?: string;
  /** Filter by status. Common values: "Sent", "Draft", "PendingApproval" */
  status?: string;
  limit?: number;
}

export const searchCommunicationsSchema = {
  name: 'search_communications',
  description:
    'Search past Communications (email/SMS/push) by subject, sender, type, date range, or status. ' +
    'Read-only; this MCP does not send communications.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      subject: { type: 'string', description: 'Subject line substring' },
      senderPersonId: { type: 'number', description: 'Sender Person Id' },
      communicationType: {
        type: 'string',
        description: 'Type: "Email", "SMS", or "PushNotification"',
      },
      sentAfter: { type: 'string', description: 'ISO date (YYYY-MM-DD) — sent on or after' },
      sentBefore: { type: 'string', description: 'ISO date (YYYY-MM-DD) — sent on or before' },
      status: { type: 'string', description: 'Status: e.g. "Sent", "Draft"' },
      limit: { type: 'number', description: 'Max results (default 25)' },
    },
  },
};

// CommunicationType enum in Rock: 0=Email, 1=SMS, 2=PushNotification
const COMM_TYPE_MAP: Record<string, number> = {
  email: 0,
  sms: 1,
  pushnotification: 2,
  push: 2,
};

// CommunicationStatus enum: 0=Transient, 1=Draft, 2=PendingApproval, 3=Approved, 4=Denied, 5=Sending, 6=Sent, 7=Failed
const COMM_STATUS_MAP: Record<string, number> = {
  transient: 0,
  draft: 1,
  pendingapproval: 2,
  approved: 3,
  denied: 4,
  sending: 5,
  sent: 6,
  failed: 7,
};

export async function searchCommunications(
  client: RockClient,
  params: SearchCommunicationsParams
): Promise<unknown> {
  // v2 Communications search 500s due to a serializer bug on this Rock install — pin to v1 OData.
  // Note: Status filter is intentionally not exposed via API filter — Rock's v1 OData
  // 500s on Status filtering. Caller can post-filter on the returned results if needed.
  const filters: string[] = [];
  if (params.subject) filters.push(`substringof('${params.subject.replace(/'/g, "''")}', Subject)`);
  if (params.communicationType) {
    // Rock v1 OData expects the enum NAME (string), not the numeric value
    filters.push(`CommunicationType eq '${params.communicationType}'`);
  }
  if (params.sentAfter) filters.push(`SendDateTime ge datetime'${params.sentAfter}'`);
  if (params.sentBefore) filters.push(`SendDateTime le datetime'${params.sentBefore}'`);
  if (params.senderPersonId !== undefined) {
    const aliases = await client.v2Search<Array<{ id: number }>>('personAliases', {
      where: `AliasPersonId == ${params.senderPersonId}`,
      sort: 'Id',
      limit: 50,
    });
    if (Array.isArray(aliases) && aliases.length > 0) {
      const aliasIds = aliases.map((a) => a.id);
      const aliasClause =
        aliasIds.length === 1
          ? `SenderPersonAliasId eq ${aliasIds[0]}`
          : `(${aliasIds.map((id) => `SenderPersonAliasId eq ${id}`).join(' or ')})`;
      filters.push(aliasClause);
    }
  }

  let results = (await client.v1Get('Communications', {
    $filter: filters.length ? filters.join(' and ') : undefined,
    $orderby: 'SendDateTime desc, Id desc',
    $top: (params.limit ?? 25) * (params.status ? 5 : 1), // fetch extra if we need to post-filter status
  })) as Array<Record<string, unknown>>;

  // Post-filter on Status if requested
  if (params.status) {
    const target = params.status.toLowerCase();
    results = results.filter((r) => {
      const s = String(r.Status ?? r.status ?? '').toLowerCase();
      return s === target;
    });
    if (results.length > (params.limit ?? 25)) {
      results = results.slice(0, params.limit ?? 25);
    }
  }

  return results;
}

// ---------------- get_communication ----------------

export interface GetCommunicationParams {
  id: number;
}

export const getCommunicationSchema = {
  name: 'get_communication',
  description: 'Get a single Communication by Id, with full body and recipient summary counts.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The Communication Id' },
    },
    required: ['id'],
  },
};

export async function getCommunication(
  client: RockClient,
  params: GetCommunicationParams
): Promise<unknown> {
  // v2 GET on a single Communication 500s for similar reasons — use v1.
  const comm = await client.v1Get<Record<string, unknown>>(`Communications/${params.id}`);

  // Augment with recipient counts via v2 (the CommunicationRecipients endpoint works).
  try {
    const recipientCount = await client.v2Search<{ count: number }>('communicationRecipients', {
      where: `CommunicationId == ${params.id}`,
      isCountOnly: true,
      returnEnvelope: true,
    });
    (comm as Record<string, unknown>).recipientCount = recipientCount.count;
  } catch {
    /* ignore */
  }

  return comm;
}
