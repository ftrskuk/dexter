import { afterEach, describe, expect, it, jest } from '@jest/globals';
import YahooFinance from 'yahoo-finance2';
import { z } from 'zod';
import * as apiModule from '../api.js';
import { getEarnings } from '../earnings.js';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('earnings tool contract', () => {
  it('keeps get_earnings name and schema unchanged', () => {
    expect(getEarnings.name).toBe('get_earnings');
    expect(z.toJSONSchema(getEarnings.schema)).toMatchObject({
      type: 'object',
      properties: { ticker: { type: 'string' } },
      required: ['ticker'],
      additionalProperties: false,
    });
  });

  it('returns the earnings envelope', async () => {
    jest.spyOn(apiModule.financeApi, 'getStatements').mockResolvedValue({
      period: 'quarterly',
      incomeStatement: [{ totalRevenue: 1000, dilutedEPS: 2.1, date: '2025-03-31' }],
    });
    jest.spyOn(YahooFinance.prototype, 'quoteSummary').mockResolvedValue({
      calendarEvents: {
        earnings: {
          earningsDate: [new Date('2025-05-01T20:00:00.000Z')],
          earningsCallDate: [new Date('2025-05-01T21:00:00.000Z')],
          revenueAverage: 900,
          earningsAverage: 2,
        },
      },
      earningsHistory: {
        history: [{ surprisePercent: 5 }],
      },
      earningsTrend: {
        trend: [{ period: '0q', revenueEstimate: { avg: 950 }, earningsEstimate: { avg: 2 } }],
      },
    } as never);

    const result = await getEarnings.invoke({ ticker: ' aapl ' });

    expect(JSON.parse(result as string)).toEqual({
      data: {
        revenue: 1000,
        eps: 2.1,
        revenue_surprise: (1000 - 900) / 900,
        eps_surprise: 0.05,
        revenue_estimate: 950,
        eps_estimate: 2,
        report_period: '2025-03-31',
        earnings_date: '2025-05-01T20:00:00.000Z',
        earnings_call_date: '2025-05-01T21:00:00.000Z',
      },
      sourceUrls: ['https://finance.yahoo.com/quote/AAPL/analysis'],
    });
  });
});
