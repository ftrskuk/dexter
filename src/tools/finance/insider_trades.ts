import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { financeApi } from './api.js';
import { formatToolResult } from '../types.js';

function matchesDateFilters(
  filingDate: string | undefined,
  filters: Pick<z.infer<typeof InsiderTradesInputSchema>, 'filing_date' | 'filing_date_gte' | 'filing_date_lte' | 'filing_date_gt' | 'filing_date_lt'>,
): boolean {
  if (!filingDate) {
    return !filters.filing_date && !filters.filing_date_gte && !filters.filing_date_lte && !filters.filing_date_gt && !filters.filing_date_lt;
  }

  if (filters.filing_date && filingDate !== filters.filing_date) {
    return false;
  }

  if (filters.filing_date_gte && filingDate < filters.filing_date_gte) {
    return false;
  }

  if (filters.filing_date_lte && filingDate > filters.filing_date_lte) {
    return false;
  }

  if (filters.filing_date_gt && filingDate <= filters.filing_date_gt) {
    return false;
  }

  if (filters.filing_date_lt && filingDate >= filters.filing_date_lt) {
    return false;
  }

  return true;
}

function mapTradeToLegacyShape(trade: Awaited<ReturnType<typeof financeApi.getInsiderTrades>>[number]) {
  const shares = trade.share ?? trade.change;

  return {
    symbol: trade.symbol,
    insider_name: trade.name,
    full_name: trade.name,
    owner: trade.name,
    officer_title: undefined,
    transaction_type: trade.transactionCode,
    shares,
    securities_transacted: shares,
    price_per_share: trade.transactionPrice,
    filing_date: trade.filingDate,
    transaction_date: trade.transactionDate,
  };
}

const InsiderTradesInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch insider trades for. For example, 'AAPL' for Apple."),
  limit: z
    .number()
    .default(10)
    .describe('Maximum number of insider trades to return (default: 10, max: 1000). Increase this for longer historical windows when needed.'),
  filing_date: z
    .string()
    .optional()
    .describe('Exact filing date to filter by (YYYY-MM-DD).'),
  filing_date_gte: z
    .string()
    .optional()
    .describe('Filter for trades with filing date greater than or equal to this date (YYYY-MM-DD).'),
  filing_date_lte: z
    .string()
    .optional()
    .describe('Filter for trades with filing date less than or equal to this date (YYYY-MM-DD).'),
  filing_date_gt: z
    .string()
    .optional()
    .describe('Filter for trades with filing date greater than this date (YYYY-MM-DD).'),
  filing_date_lt: z
    .string()
    .optional()
    .describe('Filter for trades with filing date less than this date (YYYY-MM-DD).'),
  name: z
    .string()
    .optional()
    .describe("Filter by insider name (e.g., 'HUANG JEN HSUN'). Names can be discovered via the /insider-trades/names/?ticker={ticker} endpoint."),
});

export const getInsiderTrades = new DynamicStructuredTool({
  name: 'get_insider_trades',
  description: `Retrieves insider trading transactions for a given company ticker. Insider trades include purchases and sales of company stock by executives, directors, and other insiders. This data is sourced from SEC Form 4 filings. Use filing_date filters to narrow down results by date range. Use the name parameter to filter by a specific insider.`,
  schema: InsiderTradesInputSchema,
  func: async (input) => {
    const normalizedName = input.name?.trim().toLowerCase();
    const trades = await financeApi.getInsiderTrades(input.ticker);
    const filteredTrades = trades
      .filter((trade) => {
        if (normalizedName && !trade.name?.toLowerCase().includes(normalizedName)) {
          return false;
        }

        return matchesDateFilters(trade.filingDate, input);
      })
      .slice(0, input.limit)
      .map(mapTradeToLegacyShape);

    return formatToolResult(filteredTrades);
  },
});
