/**
 * Content Channel Tools for Rock RMS (read-only) — v2 endpoints (Linq.Dynamic).
 *
 * Notes:
 * - ContentChannel and ContentChannelItem are ISecured entities. v2 also gates per-entity
 *   View permission. If a channel is missing from search_content_channels output, the
 *   REST key's role lacks View on it — grant it in Rock: Admin Tools > CMS > Content
 *   Channels > [channel] > Security.
 * - ContentChannelItem.status: 0 = PendingApproval, 1 = Approved, 2 = Denied.
 * - Filter syntax is Linq.Dynamic with PascalCase field names; response body keys are
 *   camelCase.
 */

import { RockClient } from '../rock-client.js';

function lq(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function whereAnd(parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((p): p is string => !!p && p.length > 0);
  return kept.length === 0 ? undefined : kept.join(' && ');
}

function dt(iso: string): string {
  return `DateTime("${iso}")`;
}

// -----------------------------
// Schemas
// -----------------------------

export interface SearchContentChannelsParams {
  name?: string;
  contentChannelTypeId?: number;
  limit?: number;
}

export interface SearchContentChannelItemsParams {
  contentChannelId?: number;
  title?: string;
  status?: number;
  startDate?: string;
  endDate?: string;
  includeContent?: boolean;
  limit?: number;
}

export interface GetContentChannelItemParams {
  id: number;
}

export const searchContentChannelsSchema = {
  name: 'search_content_channels',
  description:
    'List content channels in Rock RMS, optionally filtered by name. Only channels the ' +
    'REST key has View permission on are returned. Use the returned Id with ' +
    'search_content_channel_items to fetch items in a channel.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Channel name to search for (partial match)' },
      contentChannelTypeId: { type: 'number', description: 'Filter by ContentChannelType ID' },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 50)' },
    },
  },
};

export const searchContentChannelItemsSchema = {
  name: 'search_content_channel_items',
  description:
    'Search content channel items (articles, posts, blocks) in Rock RMS. Filter by channel, ' +
    'title, status, or date range. Only items in channels the REST key can View are returned. ' +
    'Item content (HTML body) is omitted by default for brevity — set includeContent to true ' +
    'to include it, or use get_content_channel_item for a single full item.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      contentChannelId: {
        type: 'number',
        description: 'Filter to items in this content channel (get the Id from search_content_channels)',
      },
      title: { type: 'string', description: 'Item title to search for (partial match)' },
      status: { type: 'number', description: 'Filter by status: 0=PendingApproval, 1=Approved, 2=Denied' },
      startDate: { type: 'string', description: 'Only items with startDateTime on or after this date (YYYY-MM-DD)' },
      endDate: { type: 'string', description: 'Only items with startDateTime on or before this date (YYYY-MM-DD)' },
      includeContent: { type: 'boolean', description: 'Include the full HTML content of each item (default: false)' },
      limit: { type: 'number', description: 'Maximum number of results to return (default: 50)' },
    },
  },
};

export const getContentChannelItemSchema = {
  name: 'get_content_channel_item',
  description:
    'Get a single content channel item by ID, including its full HTML content and attribute values. ' +
    'Returns 401/forbidden if the REST key lacks View permission on the parent channel.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      id: { type: 'number', description: 'The ContentChannelItem ID' },
    },
    required: ['id'],
  },
};

const STATUS_LABELS: Record<number, string> = {
  0: 'PendingApproval',
  1: 'Approved',
  2: 'Denied',
};

// -----------------------------
// Implementations
// -----------------------------

export async function searchContentChannels(
  client: RockClient,
  params: SearchContentChannelsParams
): Promise<unknown> {
  const where = whereAnd([
    params.name ? `Name.Contains(${lq(params.name)})` : undefined,
    params.contentChannelTypeId !== undefined ? `ContentChannelTypeId == ${params.contentChannelTypeId}` : undefined,
  ]);

  const channels = await client.v2Search<Array<Record<string, unknown>>>('contentchannels', {
    where,
    limit: params.limit ?? 50,
    sort: 'Name',
  });

  return channels.map((c) => ({
    id: c.id,
    name: c.name,
    description: c.description,
    contentChannelTypeId: c.contentChannelTypeId,
    iconCssClass: c.iconCssClass,
    channelUrl: c.channelUrl,
    itemUrl: c.itemUrl,
    requiresApproval: c.requiresApproval,
    isActive: c.isActive ?? true,
  }));
}

export async function searchContentChannelItems(
  client: RockClient,
  params: SearchContentChannelItemsParams
): Promise<unknown> {
  const where = whereAnd([
    params.contentChannelId !== undefined ? `ContentChannelId == ${params.contentChannelId}` : undefined,
    params.status !== undefined ? `Status == ${params.status}` : undefined,
    params.title ? `Title.Contains(${lq(params.title)})` : undefined,
    params.startDate ? `StartDateTime >= ${dt(params.startDate)}` : undefined,
    params.endDate ? `StartDateTime <= ${dt(params.endDate)}` : undefined,
  ]);

  const items = await client.v2Search<Array<Record<string, unknown>>>('contentchannelitems', {
    where,
    limit: params.limit ?? 50,
    sort: 'StartDateTime descending',
  });

  return items.map((item) => {
    const status = item.status as number | undefined;
    const base: Record<string, unknown> = {
      id: item.id,
      title: item.title,
      contentChannelId: item.contentChannelId,
      contentChannelTypeId: item.contentChannelTypeId,
      status,
      statusLabel: status !== undefined ? STATUS_LABELS[status] ?? 'Unknown' : undefined,
      priority: item.priority,
      startDateTime: item.startDateTime,
      expireDateTime: item.expireDateTime,
      permalink: item.permalink,
    };
    if (params.includeContent) {
      base.content = item.content;
    }
    return base;
  });
}

export async function getContentChannelItem(
  client: RockClient,
  params: GetContentChannelItemParams
): Promise<unknown> {
  const item = await client.v2Get<Record<string, unknown>>(`contentchannelitems/${params.id}`);

  if (item.contentChannelId) {
    try {
      const channel = await client.v2Get<Record<string, unknown>>(
        `contentchannels/${item.contentChannelId}`
      );
      item.contentChannelName = channel.name;
    } catch {
      // non-fatal — channel lookup is a convenience only
    }
  }

  const status = item.status as number | undefined;
  if (status !== undefined) {
    item.statusLabel = STATUS_LABELS[status] ?? 'Unknown';
  }
  return item;
}
