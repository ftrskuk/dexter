import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { financeApi, stripFieldsDeep } from './api.js';
import { formatToolResult } from '../types.js';

const REDUNDANT_FINANCIAL_FIELDS = ['accession_number', 'currency', 'period'] as const;

const FinancialStatementsInputSchema = z.object({
  ticker: z
    .string()
    .describe(
      "The stock ticker symbol to fetch financial statements for. For example, 'AAPL' for Apple."
    ),
  period: z
    .enum(['annual', 'quarterly', 'ttm'])
    .describe(
      "The reporting period for the financial statements. 'annual' for yearly, 'quarterly' for quarterly, and 'ttm' for trailing twelve months."
    ),
  limit: z
    .number()
    .default(4)
    .describe(
      'Maximum number of report periods to return (default: 4). Returns the most recent N periods based on the period type. Increase this for longer historical analysis when needed.'
    ),
  report_period_gt: z
    .string()
    .optional()
    .describe('Filter for financial statements with report periods after this date (YYYY-MM-DD).'),
  report_period_gte: z
    .string()
    .optional()
    .describe(
      'Filter for financial statements with report periods on or after this date (YYYY-MM-DD).'
    ),
  report_period_lt: z
    .string()
    .optional()
    .describe('Filter for financial statements with report periods before this date (YYYY-MM-DD).'),
  report_period_lte: z
    .string()
    .optional()
    .describe(
      'Filter for financial statements with report periods on or before this date (YYYY-MM-DD).'
    ),
});

type StatementRow = Record<string, unknown>;

function toSnakeCase(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function mapStatementRow(record: StatementRow): Record<string, number | string | null> {
  const normalized: Record<string, number | string | null> = {};

  for (const [key, value] of Object.entries(record)) {
    if (typeof value === 'number' || typeof value === 'string' || value === null) {
      normalized[toSnakeCase(key)] = value;
    }
  }

  const reportPeriod = typeof normalized.date === 'string'
    ? normalized.date
    : typeof normalized.end_date === 'string'
      ? normalized.end_date
      : undefined;

  if (reportPeriod) {
    normalized.report_period = reportPeriod;
  }

  if (normalized.total_revenue !== undefined && normalized.revenue === undefined) {
    normalized.revenue = normalized.total_revenue;
  }
  if (normalized.operating_income !== undefined) {
    normalized.operating_income = normalized.operating_income;
  } else if (normalized.ebit !== undefined) {
    normalized.operating_income = normalized.ebit;
  }
  if (normalized.net_income !== undefined) {
    normalized.net_income = normalized.net_income;
  }
  if (normalized.basic_eps !== undefined && normalized.basic_earnings_per_share === undefined) {
    normalized.basic_earnings_per_share = normalized.basic_eps;
  }
  if (normalized.diluted_eps !== undefined && normalized.earnings_per_share === undefined) {
    normalized.earnings_per_share = normalized.diluted_eps;
  } else if (normalized.basic_eps !== undefined && normalized.earnings_per_share === undefined) {
    normalized.earnings_per_share = normalized.basic_eps;
  }
  if (normalized.total_assets !== undefined && normalized.assets === undefined) {
    normalized.assets = normalized.total_assets;
  }
  if (normalized.total_liabilities_net_minority_interest !== undefined && normalized.total_liabilities === undefined) {
    normalized.total_liabilities = normalized.total_liabilities_net_minority_interest;
  }
  if (normalized.stockholders_equity !== undefined && normalized.shareholders_equity === undefined) {
    normalized.shareholders_equity = normalized.stockholders_equity;
  }
  if (normalized.total_equity_gross_minority_interest !== undefined && normalized.total_equity === undefined) {
    normalized.total_equity = normalized.total_equity_gross_minority_interest;
  }
  if (normalized.cash_and_cash_equivalents !== undefined && normalized.cash_and_equivalents === undefined) {
    normalized.cash_and_equivalents = normalized.cash_and_cash_equivalents;
  } else if (
    normalized.cash_cash_equivalents_and_short_term_investments !== undefined
    && normalized.cash_and_equivalents === undefined
  ) {
    normalized.cash_and_equivalents = normalized.cash_cash_equivalents_and_short_term_investments;
  }
  return normalized;
}

function matchesDateFilters(
  row: Record<string, number | string | null>,
  input: z.infer<typeof FinancialStatementsInputSchema>,
): boolean {
  const reportPeriod = row.report_period;
  if (typeof reportPeriod !== 'string') {
    return true;
  }

  if (input.report_period_gt && !(reportPeriod > input.report_period_gt)) return false;
  if (input.report_period_gte && !(reportPeriod >= input.report_period_gte)) return false;
  if (input.report_period_lt && !(reportPeriod < input.report_period_lt)) return false;
  if (input.report_period_lte && !(reportPeriod <= input.report_period_lte)) return false;
  return true;
}

function sumNumericRows(rows: Array<Record<string, number | string | null>>): Record<string, number | string | null> {
  if (rows.length === 0) {
    return {};
  }

  const base = { ...rows[0] };

  for (const key of Object.keys(base)) {
    if (typeof rows[0]?.[key] === 'number') {
      base[key] = rows.reduce((sum, row) => sum + (typeof row[key] === 'number' ? (row[key] as number) : 0), 0);
    }
  }

  base.period = 'ttm';
  return base;
}

function buildTtmRows(rows: Array<Record<string, number | string | null>>, statementType: 'income' | 'balance' | 'cashflow') {
  if (rows.length === 0) {
    return [];
  }

  if (statementType === 'balance') {
    return [{ ...rows[0], period: 'ttm' }];
  }

  return [sumNumericRows(rows.slice(0, 4))];
}

async function getNormalizedStatements(input: z.infer<typeof FinancialStatementsInputSchema>) {
  const ticker = input.ticker.trim().toUpperCase();
  const providerPeriod = input.period === 'annual' ? 'annual' : 'quarterly';
  const statements = await financeApi.getStatements(ticker, providerPeriod);

  const mapped = {
    income_statements: (statements.incomeStatement ?? statements.income ?? []).map((row) => mapStatementRow(row as StatementRow)),
    balance_sheets: (statements.balanceSheet ?? statements.balance ?? []).map((row) => mapStatementRow(row as StatementRow)),
    cash_flow_statements: (statements.cashFlow ?? statements.cashflow ?? []).map((row) => mapStatementRow(row as StatementRow)),
  };

  const filtered = {
    income_statements: mapped.income_statements.filter((row) => matchesDateFilters(row, input)),
    balance_sheets: mapped.balance_sheets.filter((row) => matchesDateFilters(row, input)),
    cash_flow_statements: mapped.cash_flow_statements.filter((row) => matchesDateFilters(row, input)),
  };

  const periodAdjusted = input.period === 'ttm'
    ? {
        income_statements: buildTtmRows(filtered.income_statements, 'income'),
        balance_sheets: buildTtmRows(filtered.balance_sheets, 'balance'),
        cash_flow_statements: buildTtmRows(filtered.cash_flow_statements, 'cashflow'),
      }
    : filtered;

  return {
    income_statements: periodAdjusted.income_statements.slice(0, input.limit),
    balance_sheets: periodAdjusted.balance_sheets.slice(0, input.limit),
    cash_flow_statements: periodAdjusted.cash_flow_statements.slice(0, input.limit),
  };
}

export const getIncomeStatements = new DynamicStructuredTool({
  name: 'get_income_statements',
  description: `Fetches a company's income statements, detailing its revenues, expenses, net income, etc. over a reporting period. Useful for evaluating a company's profitability and operational efficiency.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    const data = await getNormalizedStatements(input);
    const url = `https://finance.yahoo.com/quote/${input.ticker.trim().toUpperCase()}/financials`;
    return formatToolResult(
      stripFieldsDeep(data.income_statements || [], REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});

export const getBalanceSheets = new DynamicStructuredTool({
  name: 'get_balance_sheets',
  description: `Retrieves a company's balance sheets, providing a snapshot of its assets, liabilities, shareholders' equity, etc. at a specific point in time. Useful for assessing a company's financial position.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    const data = await getNormalizedStatements(input);
    const url = `https://finance.yahoo.com/quote/${input.ticker.trim().toUpperCase()}/balance-sheet`;
    return formatToolResult(
      stripFieldsDeep(data.balance_sheets || [], REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});

export const getCashFlowStatements = new DynamicStructuredTool({
  name: 'get_cash_flow_statements',
  description: `Retrieves a company's cash flow statements, showing how cash is generated and used across operating, investing, and financing activities. Useful for understanding a company's liquidity and solvency.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    const data = await getNormalizedStatements(input);
    const url = `https://finance.yahoo.com/quote/${input.ticker.trim().toUpperCase()}/cash-flow`;
    return formatToolResult(
      stripFieldsDeep(data.cash_flow_statements || [], REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});

export const getAllFinancialStatements = new DynamicStructuredTool({
  name: 'get_all_financial_statements',
  description: `Retrieves all three financial statements (income statements, balance sheets, and cash flow statements) for a company in a single API call. This is more efficient than calling each statement type separately when you need all three for comprehensive financial analysis.`,
  schema: FinancialStatementsInputSchema,
  func: async (input) => {
    const data = await getNormalizedStatements(input);
    const url = `https://finance.yahoo.com/quote/${input.ticker.trim().toUpperCase()}/financials`;
    return formatToolResult(
      stripFieldsDeep({
        income_statements: data.income_statements,
        balance_sheets: data.balance_sheets,
        cash_flow_statements: data.cash_flow_statements,
      }, REDUNDANT_FINANCIAL_FIELDS),
      [url]
    );
  },
});
