/**
 * Giving / Financial Transactions Tools for Rock RMS.
 *
 * Pinned to v1 endpoints: as of June 2026, v2's `FinancialTransactions` controller
 * returns HTTP 500 ("An error has occurred") whenever a search matches one or more rows
 * on this LH instance — a serialization bug in the v2 serializer. v1 is unaffected and
 * returns the same data in PascalCase. We pick fields out client-side so this tool's
 * public contract doesn't change.
 *
 * Notes from earlier debugging:
 * - Date filters MUST use OData datetime literal format: `datetime'2026-04-02'`
 *   (raw string comparison causes Edm.DateTime/Edm.String type mismatch)
 * - the source church can have 1,900+ transactions in a single week, so default limit is high
 *   for date-range queries
 * - Can't $orderby on TransactionDetails/Amount (collection property), so amount
 *   sorting must happen client-side after fetching all results
 * - Account filtering uses lambda: `TransactionDetails/any(d: d/AccountId eq N)`
 */

import { RockClient } from '../rock-client.js';

export interface SearchGivingParams {
  personId?: number;
  accountId?: number;
  accountName?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  sortByAmount?: boolean;
  /** Return only totals + per-account breakdown, omitting the individual gift rows. */
  summaryOnly?: boolean;
}

export const searchGivingSchema = {
  name: 'search_giving',
  description:
    'Search financial transactions (giving records) by person, account, or date range. Returns ' +
    'totals + per-account breakdown, and individual gift rows (capped for large result sets). ' +
    'For church-wide totals over multiple weeks/months, prefer execute_sql (it aggregates ' +
    'server-side in one query) or pass summaryOnly=true here — a broad date range returns ' +
    'thousands of rows. To find the largest gifts, set sortByAmount=true with a limit.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      personId: { type: 'number', description: 'Filter by Person ID (authorized person)' },
      accountId: {
        type: 'number',
        description: 'Filter by Financial Account ID. Use accountName to search by name instead.',
      },
      accountName: {
        type: 'string',
        description:
          'Filter by account name (prefix match). Resolves to accountId(s) automatically. Examples: "Spring Offering", "General Fund"',
      },
      startDate: { type: 'string', description: 'Start date for date range filter (YYYY-MM-DD format)' },
      endDate: { type: 'string', description: 'End date for date range filter (YYYY-MM-DD format)' },
      limit: {
        type: 'number',
        description:
          'Maximum number of results to return. Default: 5000 for date-range queries, 50 for person queries.',
      },
      sortByAmount: {
        type: 'boolean',
        description: 'Sort results by gift amount descending (client-side). Default: false (sorted by date desc).',
      },
      summaryOnly: {
        type: 'boolean',
        description: 'Return only totals + per-account breakdown, omitting individual gift rows. Best for church-wide date-range totals.',
      },
    },
  },
};

interface GivingResult {
  name: string;
  amount: number;
  account: string;
  date: string;
  transactionId: number;
  personId: number | null;
}

function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function searchGiving(client: RockClient, params: SearchGivingParams): Promise<unknown> {
  const filterParts: string[] = [];

  if (params.personId !== undefined) {
    filterParts.push(`AuthorizedPersonAlias/PersonId eq ${params.personId}`);
  }
  if (params.startDate) filterParts.push(`TransactionDateTime ge datetime'${params.startDate}'`);
  if (params.endDate) filterParts.push(`TransactionDateTime le datetime'${params.endDate}'`);

  // Resolve accountName → account Ids
  let resolvedAccountIds: number[] = [];
  if (params.accountName) {
    const accounts = await client.v1Get<Array<{ Id: number; Name: string }>>('FinancialAccounts', {
      $filter: `startswith(Name, ${odataString(params.accountName)}) and IsActive eq true`,
      $top: 20,
    });
    resolvedAccountIds = accounts.map((a) => a.Id);
    if (resolvedAccountIds.length === 0) {
      return {
        error: `No active financial accounts found matching "${params.accountName}"`,
        accounts: [],
      };
    }
  }

  const accountIds = params.accountId ? [params.accountId] : resolvedAccountIds;
  if (accountIds.length === 1) {
    filterParts.push(`TransactionDetails/any(d: d/AccountId eq ${accountIds[0]})`);
  } else if (accountIds.length > 1) {
    const conditions = accountIds.map((id) => `d/AccountId eq ${id}`).join(' or ');
    filterParts.push(`TransactionDetails/any(d: ${conditions})`);
  }

  const hasDateRange = !!(params.startDate || params.endDate);
  const defaultLimit = hasDateRange ? 5000 : 50;

  const queryParams: Record<string, string | number | undefined> = {
    $top: params.limit ?? defaultLimit,
    $orderby: 'TransactionDateTime desc',
    $expand: 'AuthorizedPersonAlias/Person,TransactionDetails/Account',
  };
  if (filterParts.length > 0) queryParams.$filter = filterParts.join(' and ');

  const rawResults = await client.v1Get<Array<Record<string, unknown>>>(
    'FinancialTransactions',
    queryParams
  );

  // Flatten transaction details into clean rows (camelCase out for forward compat)
  const gifts: GivingResult[] = rawResults.flatMap((t) => {
    const alias = t.AuthorizedPersonAlias as Record<string, unknown> | undefined;
    const person = alias?.Person as Record<string, unknown> | undefined;
    const name = person
      ? `${person.LastName}, ${person.NickName || person.FirstName}`
      : 'Unknown';
    const personId = person ? (person.Id as number) : null;
    const details = (t.TransactionDetails ?? []) as Array<Record<string, unknown>>;

    return details
      .filter((d) => {
        if (accountIds.length > 0) {
          return accountIds.includes(d.AccountId as number);
        }
        return true;
      })
      .map((d) => ({
        name,
        amount: d.Amount as number,
        account: ((d.Account as Record<string, unknown>)?.Name as string) || 'Unknown',
        date: (t.TransactionDateTime as string)?.split('T')[0] || '',
        transactionId: t.Id as number,
        personId,
      }));
  });

  const totalAmount = gifts.reduce((sum, g) => sum + g.amount, 0);
  const accountTotals: Record<string, number> = {};
  for (const g of gifts) accountTotals[g.account] = (accountTotals[g.account] ?? 0) + g.amount;

  // Summary-only: totals + per-account breakdown, no rows (safe for wide date ranges).
  if (params.summaryOnly) {
    return { totalTransactions: rawResults.length, totalGifts: gifts.length, totalAmount, accountTotals };
  }

  if (params.sortByAmount) {
    gifts.sort((a, b) => b.amount - a.amount);
  }
  const resultLimit = params.limit ?? (params.sortByAmount ? 50 : gifts.length);
  let outGifts = params.sortByAmount ? gifts.slice(0, resultLimit) : gifts;

  // Safety cap so a broad date range degrades to a sample+totals instead of blowing the token
  // ceiling. Totals above are always over the full result set.
  const GIFT_CAP = 1000;
  let truncated = false;
  if (outGifts.length > GIFT_CAP) {
    outGifts = outGifts.slice(0, GIFT_CAP);
    truncated = true;
  }

  return {
    totalTransactions: rawResults.length,
    totalGifts: gifts.length,
    totalAmount,
    accountTotals,
    ...(truncated
      ? {
          truncated: true,
          note: `Showing the first ${GIFT_CAP} of ${gifts.length} gift rows — the totals above cover all of them. Use summaryOnly:true, narrow the window, or use execute_sql to aggregate.`,
        }
      : {}),
    gifts: outGifts,
  };
}
