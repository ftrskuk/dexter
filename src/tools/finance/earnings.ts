import { DynamicStructuredTool } from '@langchain/core/tools';
import YahooFinance from 'yahoo-finance2';
import type { QuoteSummaryResult } from 'yahoo-finance2/modules/quoteSummary';
import { z } from 'zod';
import { financeApi } from './api.js';
import { formatToolResult } from '../types.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

function toPercentDecimal(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value / 100 : undefined;
}

function getLatestQuarterlyActual(summary: QuoteSummaryResult): { revenue?: number; earnings?: number; period?: string } {
  const quarterly = summary.earnings?.financialsChart?.quarterly ?? [];
  const latest = quarterly[quarterly.length - 1];

  return {
    revenue: typeof latest?.revenue === 'number' ? latest.revenue : undefined,
    earnings: typeof latest?.earnings === 'number' ? latest.earnings : undefined,
    period: typeof latest?.date === 'string' ? latest.date : undefined,
  };
}

function getLatestEpsHistory(summary: QuoteSummaryResult) {
  const history = summary.earningsHistory?.history ?? [];
  return history[history.length - 1];
}

const EarningsInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch the latest earnings for. For example, 'AAPL' for Apple."),
});

export const getEarnings = new DynamicStructuredTool({
  name: 'get_earnings',
  description:
    'Fetches the most recent earnings snapshot for a company, including key income statement, balance sheet, and cash flow figures from the 8-K earnings release, plus analyst estimate comparisons (revenue and EPS surprise) when available.',
  schema: EarningsInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const [statements, summary] = await Promise.all([
      financeApi.getStatements(ticker, 'quarterly').catch(() => null),
      yahooFinance.quoteSummary(ticker, {
        modules: ['calendarEvents', 'earnings', 'earningsHistory', 'earningsTrend', 'financialData'],
      }).catch(() => null),
    ]);

    const latestIncome = (statements?.incomeStatement ?? statements?.income ?? [])[0] as Record<string, unknown> | undefined;
    const latestQuarterlyActual = summary ? getLatestQuarterlyActual(summary as QuoteSummaryResult) : {};
    const latestEpsHistory = summary ? getLatestEpsHistory(summary as QuoteSummaryResult) : undefined;
    const latestTrend = summary?.earningsTrend?.trend?.find((entry) => entry?.period === '0q')
      ?? summary?.earningsTrend?.trend?.[0];

    const revenue = typeof latestIncome?.totalRevenue === 'number'
      ? latestIncome.totalRevenue
      : latestQuarterlyActual.revenue;
    const eps = typeof latestIncome?.dilutedEPS === 'number'
      ? latestIncome.dilutedEPS
      : typeof latestIncome?.basicEPS === 'number'
        ? latestIncome.basicEPS
        : typeof latestEpsHistory?.epsActual === 'number'
          ? latestEpsHistory.epsActual
          : undefined;

    return formatToolResult({
      revenue,
      eps,
      revenue_surprise: summary?.calendarEvents?.earnings?.revenueAverage && revenue !== undefined
        ? (revenue - summary.calendarEvents.earnings.revenueAverage) / summary.calendarEvents.earnings.revenueAverage
        : undefined,
      eps_surprise: toPercentDecimal(latestEpsHistory?.surprisePercent),
      revenue_estimate: latestTrend?.revenueEstimate?.avg ?? summary?.calendarEvents?.earnings?.revenueAverage ?? undefined,
      eps_estimate: latestTrend?.earningsEstimate?.avg ?? summary?.calendarEvents?.earnings?.earningsAverage ?? undefined,
      report_period: latestIncome?.date ?? latestIncome?.endDate ?? latestQuarterlyActual.period,
      earnings_date: summary?.calendarEvents?.earnings?.earningsDate?.[0]?.toISOString(),
      earnings_call_date: summary?.calendarEvents?.earnings?.earningsCallDate?.[0]?.toISOString(),
    }, [`https://finance.yahoo.com/quote/${ticker}/analysis`]);
  },
});
