import { afterEach, describe, expect, it, jest } from '@jest/globals';
import YahooFinance from 'yahoo-finance2';
import { z } from 'zod';
import * as apiModule from '../api.js';
import { getCompanyNews } from '../news.js';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('company news tool contract', () => {
  it('keeps get_company_news name and schema unchanged', () => {
    expect(getCompanyNews.name).toBe('get_company_news');
    expect(z.toJSONSchema(getCompanyNews.schema)).toMatchObject({
      type: 'object',
      properties: {
        ticker: { type: 'string' },
        limit: { type: 'number', default: 5 },
      },
      required: ['ticker', 'limit'],
      additionalProperties: false,
    });
  });

  it('returns the company news envelope', async () => {
    jest.spyOn(apiModule.financeApi, 'getQuote').mockResolvedValue({
      symbol: 'AAPL',
      price: 190.12,
      currency: 'USD',
      asOf: '2025-01-31T00:00:00.000Z',
    });
    jest.spyOn(YahooFinance.prototype, 'search').mockResolvedValue({
      news: [{
        title: 'Apple launches thing',
        publisher: 'Example News',
        providerPublishTime: new Date('2025-01-01T00:00:00.000Z'),
        link: 'https://news.example/apple',
        relatedTickers: ['AAPL'],
      }],
    } as never);

    const result = await getCompanyNews.invoke({ ticker: 'aapl', limit: 3 });

    expect(JSON.parse(result as string)).toEqual({
      data: [{
        title: 'Apple launches thing',
        source: 'Example News',
        date: '2025-01-01T00:00:00.000Z',
        url: 'https://news.example/apple',
        related_tickers: ['AAPL'],
      }],
      sourceUrls: ['https://finance.yahoo.com/quote/AAPL/news'],
    });
  });
});
