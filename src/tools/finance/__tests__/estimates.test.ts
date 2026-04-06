import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import * as apiModule from '../api.js';
import { getAnalystEstimates } from '../estimates.js';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('analyst estimates tool contract', () => {
  it('keeps get_analyst_estimates name and schema unchanged', () => {
    expect(getAnalystEstimates.name).toBe('get_analyst_estimates');
    expect(z.toJSONSchema(getAnalystEstimates.schema)).toMatchObject({
      type: 'object',
      properties: {
        ticker: { type: 'string' },
        period: { type: 'string', enum: ['annual', 'quarterly'], default: 'annual' },
      },
      required: ['ticker', 'period'],
      additionalProperties: false,
    });
  });

  it('returns the analyst estimates envelope', async () => {
    jest.spyOn(apiModule.financeApi, 'getAnalystEstimates').mockResolvedValue({
      epsCurrentYear: 7.5,
      revenueCurrentYear: 100,
      epsNextYear: 8.1,
      revenueNextYear: 110,
    });

    const result = await getAnalystEstimates.invoke({ ticker: 'AAPL', period: 'annual' });

    expect(JSON.parse(result as string)).toEqual({
      data: [
        {
          report_period: `${new Date().getUTCFullYear()}-12-31`,
          date: `${new Date().getUTCFullYear()}-12-31`,
          estimated_revenue_avg: 100,
          revenue_estimate: 100,
          estimated_eps_avg: 7.5,
          eps_estimate: 7.5,
        },
        {
          report_period: `${new Date().getUTCFullYear() + 1}-12-31`,
          date: `${new Date().getUTCFullYear() + 1}-12-31`,
          estimated_revenue_avg: 110,
          revenue_estimate: 110,
          estimated_eps_avg: 8.1,
          eps_estimate: 8.1,
        },
      ],
    });
  });
});
