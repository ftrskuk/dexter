import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { financeApi, stripFieldsDeep } from './api.js';
import { formatToolResult } from '../types.js';

const FMP_BASE_URL = 'https://financialmodelingprep.com/stable';

const REDUNDANT_FINANCIAL_FIELDS = ['accession_number', 'currency', 'period'] as const;

const KeyRatiosInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch key ratios for. For example, 'AAPL' for Apple."),
});

export const getKeyRatios = new DynamicStructuredTool({
  name: 'get_key_ratios',
  description:
    'Fetches the latest financial metrics snapshot for a company, including valuation ratios (P/E, P/B, P/S, EV/EBITDA, PEG), profitability (margins, ROE, ROA, ROIC), liquidity (current/quick/cash ratios), leverage (debt/equity, debt/assets), per-share metrics (EPS, book value, FCF), and growth rates (revenue, earnings, EPS, FCF, EBITDA).',
  schema: KeyRatiosInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const data = await financeApi.getKeyRatios(ticker);
    return formatToolResult(data);
  },
});

function getFmpApiKey(): string {
  const apiKey = process.env.FMP_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('FMP_API_KEY is not set');
  }

  return apiKey;
}

function matchesReportPeriodFilter(
  reportPeriod: string | undefined,
  input: z.infer<typeof HistoricalKeyRatiosInputSchema>,
): boolean {
  if (!reportPeriod) {
    return true;
  }

  if (input.report_period && reportPeriod !== input.report_period) {
    return false;
  }

  if (input.report_period_gt && reportPeriod <= input.report_period_gt) {
    return false;
  }

  if (input.report_period_gte && reportPeriod < input.report_period_gte) {
    return false;
  }

  if (input.report_period_lt && reportPeriod >= input.report_period_lt) {
    return false;
  }

  if (input.report_period_lte && reportPeriod > input.report_period_lte) {
    return false;
  }

  return true;
}

async function fetchHistoricalFmpRatios(
  ticker: string,
  period: 'annual' | 'quarterly',
  limit: number,
): Promise<{ data: Array<Record<string, unknown>>; url: string }> {
  const searchParams = new URLSearchParams({
    apikey: getFmpApiKey(),
    symbol: ticker,
    period: period === 'quarterly' ? 'quarter' : 'annual',
    limit: String(limit),
  });
  const url = `${FMP_BASE_URL}/ratios`;
  const response = await fetch(`${url}?${searchParams.toString()}`);

  if (!response.ok) {
    throw new Error(`FMP request failed for historical ratios: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as unknown;
  return {
    data: Array.isArray(data) ? (data as Array<Record<string, unknown>>) : [],
    url: `${url}?symbol=${ticker}&period=${period === 'quarterly' ? 'quarter' : 'annual'}&limit=${limit}`,
  };
}

const HistoricalKeyRatiosInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "The stock ticker symbol to fetch historical key ratios for. For example, 'AAPL' for Apple."
    ),
  period: z
    .enum(['annual', 'quarterly', 'ttm'])
    .default('ttm')
    .describe(
      "The reporting period. 'annual' for yearly, 'quarterly' for quarterly, and 'ttm' for trailing twelve months."
    ),
  limit: z
    .number()
    .default(4)
    .describe('The number of past financial statements to retrieve.'),
  report_period: z
    .string()
    .optional()
    .describe('Filter for key ratios with an exact report period date (YYYY-MM-DD).'),
  report_period_gt: z
    .string()
    .optional()
    .describe('Filter for key ratios with report periods after this date (YYYY-MM-DD).'),
  report_period_gte: z
    .string()
    .optional()
    .describe(
      'Filter for key ratios with report periods on or after this date (YYYY-MM-DD).'
    ),
  report_period_lt: z
    .string()
    .optional()
    .describe('Filter for key ratios with report periods before this date (YYYY-MM-DD).'),
  report_period_lte: z
    .string()
    .optional()
    .describe(
      'Filter for key ratios with report periods on or before this date (YYYY-MM-DD).'
    ),
});

export const getHistoricalKeyRatios = new DynamicStructuredTool({
  name: 'get_historical_key_ratios',
  description: `Retrieves historical key ratios for a company, such as P/E ratio, revenue per share, and enterprise value, over a specified period. Useful for trend analysis and historical performance evaluation.`,
  schema: HistoricalKeyRatiosInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();

    if (input.period === 'ttm') {
      const latestRatios = await financeApi.getKeyRatios(ticker);
      return formatToolResult([stripFieldsDeep(latestRatios, REDUNDANT_FINANCIAL_FIELDS)], [
        `financeApi.getKeyRatios(${ticker})`,
      ]);
    }

    const { data, url } = await fetchHistoricalFmpRatios(ticker, input.period, input.limit);
    const filtered = data.filter((row) => {
      const reportPeriod = typeof row.date === 'string'
        ? row.date
        : typeof row.calendarYear === 'string'
          ? row.calendarYear
          : undefined;
      return matchesReportPeriodFilter(reportPeriod, input);
    });

    return formatToolResult(
      stripFieldsDeep(filtered, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});
