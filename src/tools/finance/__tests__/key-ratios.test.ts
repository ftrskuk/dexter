import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import { financeApi } from '../api.js';
import { getHistoricalKeyRatios, getKeyRatios } from '../key-ratios.js';

function expectEnvelope(result: unknown, data: unknown, sourceUrls?: string[]) {
  expect(JSON.parse(result as string)).toEqual(sourceUrls ? { data, sourceUrls } : { data });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('key ratios tool contracts', () => {
  it('keeps get_key_ratios name and schema unchanged', () => {
    expect(getKeyRatios.name).toBe('get_key_ratios');
    expect(z.toJSONSchema(getKeyRatios.schema)).toMatchObject({
      type: 'object',
      properties: { ticker: { type: 'string' } },
      required: ['ticker'],
      additionalProperties: false,
    });
  });

  it('keeps get_historical_key_ratios name and schema unchanged', () => {
    expect(getHistoricalKeyRatios.name).toBe('get_historical_key_ratios');
    expect(z.toJSONSchema(getHistoricalKeyRatios.schema)).toMatchObject({
      type: 'object',
      properties: {
        ticker: { type: 'string' },
        period: { type: 'string', enum: ['annual', 'quarterly', 'ttm'], default: 'ttm' },
        limit: { type: 'number', default: 4 },
        report_period: { type: 'string' },
        report_period_gt: { type: 'string' },
        report_period_gte: { type: 'string' },
        report_period_lt: { type: 'string' },
        report_period_lte: { type: 'string' },
      },
      required: ['ticker', 'period', 'limit'],
      additionalProperties: false,
    });
  });

  it('returns the key ratio snapshot envelope', async () => {
    jest.spyOn(financeApi, 'getKeyRatios').mockResolvedValue({ pe_ratio: 25.1 } as Awaited<ReturnType<typeof financeApi.getKeyRatios>>);

    const result = await getKeyRatios.invoke({ ticker: 'aapl' });

    expectEnvelope(result, { pe_ratio: 25.1 });
  });

  it('keeps percentage ratio fields as decimals in tool output', async () => {
    jest.spyOn(financeApi, 'getKeyRatios').mockResolvedValue({
      grossMargin: 0.4733,
      operatingMargin: 0.3238,
      roe: 1.5994,
      roa: 0.3362,
    } as Awaited<ReturnType<typeof financeApi.getKeyRatios>>);

    const result = await getKeyRatios.invoke({ ticker: 'AAPL' });

    expectEnvelope(result, {
      grossMargin: 0.4733,
      operatingMargin: 0.3238,
      roe: 1.5994,
      roa: 0.3362,
    });
  });

  it('returns the historical key ratio envelope with redundant fields removed', async () => {
    jest.spyOn(financeApi, 'getKeyRatios').mockResolvedValue({
      pe_ratio: 20.4,
      accession_number: '0005',
      currency: 'USD',
      period: 'ttm',
    } as Awaited<ReturnType<typeof financeApi.getKeyRatios>>);

    const result = await getHistoricalKeyRatios.invoke({ ticker: 'AAPL', period: 'ttm', limit: 1 });

    expectEnvelope(result, [{ pe_ratio: 20.4 }], ['financeApi.getKeyRatios(AAPL)']);
  });
});
