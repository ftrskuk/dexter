import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import * as apiModule from '../api.js';
import { getInsiderTrades } from '../insider_trades.js';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('insider trades tool contract', () => {
  it('keeps get_insider_trades name and schema unchanged', () => {
    expect(getInsiderTrades.name).toBe('get_insider_trades');
    expect(z.toJSONSchema(getInsiderTrades.schema)).toMatchObject({
      type: 'object',
      properties: {
        ticker: { type: 'string' },
        limit: { type: 'number', default: 10 },
        filing_date: { type: 'string' },
        filing_date_gte: { type: 'string' },
        filing_date_lte: { type: 'string' },
        filing_date_gt: { type: 'string' },
        filing_date_lt: { type: 'string' },
        name: { type: 'string' },
      },
      required: ['ticker', 'limit'],
      additionalProperties: false,
    });
  });

  it('returns the insider trades envelope with redundant issuer removed', async () => {
    jest.spyOn(apiModule.financeApi, 'getInsiderTrades').mockResolvedValue([
      {
        symbol: 'AAPL',
        name: 'Jane Doe',
        share: 100,
        filingDate: '2025-01-01',
        transactionDate: '2024-12-31',
        transactionCode: 'P',
        transactionPrice: 200,
      },
    ]);

    const result = await getInsiderTrades.invoke({ ticker: 'AAPL', limit: 1 });

    expect(JSON.parse(result as string)).toEqual({
      data: [
        {
          symbol: 'AAPL',
          insider_name: 'Jane Doe',
          full_name: 'Jane Doe',
          owner: 'Jane Doe',
          transaction_type: 'P',
          shares: 100,
          securities_transacted: 100,
          price_per_share: 200,
          filing_date: '2025-01-01',
          transaction_date: '2024-12-31',
        },
      ],
    });
  });
});
