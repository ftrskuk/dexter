import { afterEach, describe, expect, it, jest } from '@jest/globals';
import YahooFinance from 'yahoo-finance2';
import { z } from 'zod';
import * as apiModule from '../api.js';
import { getStockPrice, getStockPrices, getStockTickers } from '../stock-price.js';

function expectEnvelope(result: unknown, data: unknown, sourceUrls?: string[]) {
  expect(JSON.parse(result as string)).toEqual(sourceUrls ? { data, sourceUrls } : { data });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('stock price tool contracts', () => {
  it('keeps get_stock_price name and schema unchanged', () => {
    expect(getStockPrice.name).toBe('get_stock_price');
    expect(z.toJSONSchema(getStockPrice.schema)).toMatchObject({
      type: 'object',
      properties: {
        ticker: { type: 'string' },
      },
      required: ['ticker'],
      additionalProperties: false,
    });
  });

  it('keeps get_stock_prices name and schema unchanged', () => {
    expect(getStockPrices.name).toBe('get_stock_prices');
    expect(z.toJSONSchema(getStockPrices.schema)).toMatchObject({
      type: 'object',
      properties: {
        ticker: { type: 'string' },
        interval: { type: 'string', enum: ['day', 'week', 'month', 'year'], default: 'day' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
      },
      required: ['ticker', 'interval', 'start_date', 'end_date'],
      additionalProperties: false,
    });
  });

  it('keeps get_available_stock_tickers name and schema unchanged', () => {
    expect(getStockTickers.name).toBe('get_available_stock_tickers');
    expect(z.toJSONSchema(getStockTickers.schema)).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('returns the stock snapshot envelope', async () => {
    jest.spyOn(apiModule.financeApi, 'getQuote').mockResolvedValue({
      symbol: 'AAPL',
      price: 190.12,
      currency: 'USD',
      asOf: '2025-01-31T00:00:00.000Z',
    });
    jest.spyOn(apiModule.financeApi, 'getPriceHistory').mockResolvedValue([
      { date: '2025-01-31T00:00:00.000Z', open: 189, high: 191, low: 188, close: 190.12, volume: 1000 },
    ]);

    const result = await getStockPrice.invoke({ ticker: ' aapl ' });

    expectEnvelope(result, {
      ticker: 'AAPL',
      price: 190.12,
      close: 190.12,
      currency: 'USD',
      as_of: '2025-01-31T00:00:00.000Z',
      open: 189,
      high: 191,
      low: 188,
      volume: 1000,
    }, ['https://finance.yahoo.com/quote/AAPL']);
  });

  it('returns the historical prices envelope', async () => {
    jest.spyOn(apiModule.financeApi, 'getPriceHistory').mockResolvedValue([
      { date: '2025-01-01T00:00:00.000Z', open: 199, high: 201, low: 198, close: 200, volume: 100 },
      { date: '2025-01-02T00:00:00.000Z', open: 200, high: 202, low: 199, close: 201, volume: 110 },
    ]);

    const result = await getStockPrices.invoke({
      ticker: 'AAPL',
      interval: 'day',
      start_date: '2025-01-01',
      end_date: '2025-01-31',
    });

    expectEnvelope(result, [
      { date: '2025-01-01T00:00:00.000Z', open: 199, high: 201, low: 198, close: 200, volume: 100 },
      { date: '2025-01-02T00:00:00.000Z', open: 200, high: 202, low: 199, close: 201, volume: 110 },
    ], ['https://finance.yahoo.com/quote/AAPL/history']);
  });

  it('returns the ticker list envelope', async () => {
    jest.spyOn(YahooFinance.prototype, 'trendingSymbols').mockResolvedValue({
      count: 6,
      quotes: [
        { symbol: 'AAPL' },
        { symbol: 'MSFT' },
        { symbol: 'BTC-USD' },
        { symbol: 'ES=F' },
        { symbol: '^NSEI' },
        { symbol: 'RELIANCE.NS' },
      ],
    } as never);

    const result = await getStockTickers.invoke({});

    expectEnvelope(result, ['AAPL', 'MSFT'], ['https://finance.yahoo.com/trending-tickers']);
  });
});
