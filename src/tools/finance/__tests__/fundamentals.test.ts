import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';
import * as apiModule from '../api.js';
import {
  getAllFinancialStatements,
  getBalanceSheets,
  getCashFlowStatements,
  getIncomeStatements,
} from '../fundamentals.js';

function expectEnvelope(result: unknown, data: unknown, sourceUrls?: string[]) {
  expect(JSON.parse(result as string)).toEqual(sourceUrls ? { data, sourceUrls } : { data });
}

const expectedSchema = {
  type: 'object',
  properties: {
    ticker: { type: 'string' },
    period: { type: 'string', enum: ['annual', 'quarterly', 'ttm'] },
    limit: { type: 'number', default: 4 },
    report_period_gt: { type: 'string' },
    report_period_gte: { type: 'string' },
    report_period_lt: { type: 'string' },
    report_period_lte: { type: 'string' },
  },
  required: ['ticker', 'period', 'limit'],
  additionalProperties: false,
};

afterEach(() => {
  jest.restoreAllMocks();
});

describe('fundamentals tool contracts', () => {
  it.each([
    [getIncomeStatements, 'get_income_statements'],
    [getBalanceSheets, 'get_balance_sheets'],
    [getCashFlowStatements, 'get_cash_flow_statements'],
    [getAllFinancialStatements, 'get_all_financial_statements'],
  ])('keeps %s contract unchanged', (tool, expectedName) => {
    expect(tool.name).toBe(expectedName);
    expect(z.toJSONSchema(tool.schema)).toMatchObject(expectedSchema);
  });

  it('returns the income statements envelope with redundant fields removed', async () => {
    jest.spyOn(apiModule.financeApi, 'getStatements').mockResolvedValue({
      period: 'annual',
      income: [{ totalRevenue: 100, date: '2025-01-01', currency: 'USD' }],
    });

    const result = await getIncomeStatements.invoke({ ticker: 'AAPL', period: 'annual', limit: 1 });

    expectEnvelope(result, [{ total_revenue: 100, date: '2025-01-01', report_period: '2025-01-01', revenue: 100 }], ['https://finance.yahoo.com/quote/AAPL/financials']);
  });

  it('returns the balance sheet envelope with redundant fields removed', async () => {
    jest.spyOn(apiModule.financeApi, 'getStatements').mockResolvedValue({
      period: 'annual',
      balance: [{ totalAssets: 500, date: '2025-01-01', currency: 'USD' }],
    });

    const result = await getBalanceSheets.invoke({ ticker: 'AAPL', period: 'annual', limit: 1 });

    expectEnvelope(result, [{ total_assets: 500, date: '2025-01-01', report_period: '2025-01-01', assets: 500 }], ['https://finance.yahoo.com/quote/AAPL/balance-sheet']);
  });

  it('returns the cash flow envelope with redundant fields removed', async () => {
    jest.spyOn(apiModule.financeApi, 'getStatements').mockResolvedValue({
      period: 'annual',
      cashflow: [{ freeCashFlow: 75, date: '2025-01-01', currency: 'USD' }],
    });

    const result = await getCashFlowStatements.invoke({ ticker: 'AAPL', period: 'annual', limit: 1 });

    expectEnvelope(result, [{ free_cash_flow: 75, date: '2025-01-01', report_period: '2025-01-01' }], ['https://finance.yahoo.com/quote/AAPL/cash-flow']);
  });

  it('returns the combined financial statements envelope with redundant fields removed', async () => {
    jest.spyOn(apiModule.financeApi, 'getStatements').mockResolvedValue({
      period: 'annual',
      income: [{ totalRevenue: 100, date: '2025-01-01', currency: 'USD' }],
      balance: [{ totalAssets: 500, date: '2025-01-01', currency: 'USD' }],
      cashflow: [{ freeCashFlow: 75, date: '2025-01-01', currency: 'USD' }],
    });

    const result = await getAllFinancialStatements.invoke({ ticker: 'AAPL', period: 'annual', limit: 1 });

    expectEnvelope(
      result,
      {
        income_statements: [{ total_revenue: 100, date: '2025-01-01', report_period: '2025-01-01', revenue: 100 }],
        balance_sheets: [{ total_assets: 500, date: '2025-01-01', report_period: '2025-01-01', assets: 500 }],
        cash_flow_statements: [{ free_cash_flow: 75, date: '2025-01-01', report_period: '2025-01-01' }],
      },
      ['https://finance.yahoo.com/quote/AAPL/financials']
    );
  });
});
