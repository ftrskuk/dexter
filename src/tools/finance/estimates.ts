import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { financeApi } from './api.js';
import { formatToolResult } from '../types.js';

function mapEstimatesToLegacyShape(estimates: Awaited<ReturnType<typeof financeApi.getAnalystEstimates>>) {
  const currentYear = new Date().getUTCFullYear();
  const rows = [
    {
      year: currentYear,
      estimated_revenue_avg: estimates.revenueCurrentYear,
      revenue_estimate: estimates.revenueCurrentYear,
      estimated_eps_avg: estimates.epsCurrentYear,
      eps_estimate: estimates.epsCurrentYear,
    },
    {
      year: currentYear + 1,
      estimated_revenue_avg: estimates.revenueNextYear,
      revenue_estimate: estimates.revenueNextYear,
      estimated_eps_avg: estimates.epsNextYear,
      eps_estimate: estimates.epsNextYear,
    },
  ];

  return rows
    .filter((row) => row.estimated_revenue_avg !== undefined || row.estimated_eps_avg !== undefined)
    .map((row) => ({
      report_period: `${row.year}-12-31`,
      date: `${row.year}-12-31`,
      estimated_revenue_avg: row.estimated_revenue_avg,
      revenue_estimate: row.revenue_estimate,
      estimated_eps_avg: row.estimated_eps_avg,
      eps_estimate: row.eps_estimate,
      number_of_analysts: undefined,
    }));
}

const AnalystEstimatesInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "The stock ticker symbol to fetch analyst estimates for. For example, 'AAPL' for Apple."
    ),
  period: z
    .enum(['annual', 'quarterly'])
    .default('annual')
    .describe("The period for the estimates, either 'annual' or 'quarterly'."),
});

export const getAnalystEstimates = new DynamicStructuredTool({
  name: 'get_analyst_estimates',
  description: `Retrieves analyst estimates for a given company ticker, including metrics like estimated EPS. Useful for understanding consensus expectations, assessing future growth prospects, and performing valuation analysis.`,
  schema: AnalystEstimatesInputSchema,
  func: async (input) => {
    const estimates = await financeApi.getAnalystEstimates(input.ticker);
    return formatToolResult(mapEstimatesToLegacyShape(estimates));
  },
});
