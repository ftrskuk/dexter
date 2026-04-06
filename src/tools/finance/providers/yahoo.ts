import YahooFinance from 'yahoo-finance2';
import type { ChartResultArray } from 'yahoo-finance2/modules/chart';
import type { FundamentalsTimeSeriesResult } from 'yahoo-finance2/modules/fundamentalsTimeSeries';
import type { Quote as YahooQuote } from 'yahoo-finance2/modules/quote';
import type { QuoteSummaryResult } from 'yahoo-finance2/modules/quoteSummary';
import type {
  FinancialStatements,
  FinanceProvider,
  PriceBar,
  PriceRange,
  Quote,
  StatementPeriod,
  StatementRecord,
  StatementValue,
} from '../types.js';

const POLITENESS_DELAY_MS = 100;
const yahooFinance = new YahooFinance();

const QUOTE_SUMMARY_MODULES_BY_PERIOD = {
  annual: {
    income: 'incomeStatementHistory',
    balance: 'balanceSheetHistory',
    cashFlow: 'cashflowStatementHistory',
  },
  quarterly: {
    income: 'incomeStatementHistoryQuarterly',
    balance: 'balanceSheetHistoryQuarterly',
    cashFlow: 'cashflowStatementHistoryQuarterly',
  },
} as const;

const FUNDAMENTALS_MODULE_BY_SECTION = {
  incomeStatement: 'financials',
  balanceSheet: 'balance-sheet',
  cashFlow: 'cash-flow',
} as const;

const yahooCapabilities = {
  quote: true,
  priceHistory: true,
  statements: true,
} as const;

let callQueue: Promise<void> = Promise.resolve();
let lastCallAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queueYahooCall<T>(fn: () => Promise<T>): Promise<T> {
  const run = async (): Promise<T> => {
    const waitMs = Math.max(0, POLITENESS_DELAY_MS - (Date.now() - lastCallAt));

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    lastCallAt = Date.now();
    return fn();
  };

  const result = callQueue.then(run, run);
  callQueue = result.then(() => undefined, () => undefined);
  return result;
}

function toIsoDate(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  return null;
}

function toNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function toStatementValue(value: unknown): StatementValue {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string' || value === null) {
    return value;
  }

  if (value instanceof Date) {
    return toIsoDate(value);
  }

  return undefined;
}

function normalizeStatementRecord(record: Record<string, unknown>): StatementRecord | null {
  const date = toIsoDate(record.endDate ?? record.date);

  if (!date) {
    return null;
  }

  const normalized: StatementRecord = { date };

  for (const [key, value] of Object.entries(record)) {
    if (key === 'date' || key === 'endDate' || key === 'maxAge') {
      continue;
    }

    const normalizedValue = toStatementValue(value);
    if (normalizedValue !== undefined) {
      normalized[key] = normalizedValue;
    }
  }

  return normalized;
}

function normalizeQuoteSummarySection(section: unknown, key: string): StatementRecord[] {
  if (!section || typeof section !== 'object') {
    return [];
  }

  const container = section as Record<string, unknown>;
  const records = container[key];

  if (!Array.isArray(records)) {
    return [];
  }

  return records
    .filter((record): record is Record<string, unknown> => Boolean(record) && typeof record === 'object')
    .map(normalizeStatementRecord)
    .filter((record): record is StatementRecord => record !== null)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function normalizeFundamentalsResults(results: FundamentalsTimeSeriesResult[]): StatementRecord[] {
  const normalized: StatementRecord[] = [];

  for (const result of results) {
    const record = normalizeStatementRecord(result as unknown as Record<string, unknown>);
    if (record) {
      normalized.push(record);
    }
  }

  return normalized.sort((a, b) => b.date.localeCompare(a.date));
}

function dedupeStatementRecords(records: StatementRecord[]): StatementRecord[] {
  const seen = new Set<string>();
  const deduped: StatementRecord[] = [];

  for (const record of records) {
    if (seen.has(record.date)) {
      continue;
    }

    seen.add(record.date);
    deduped.push(record);
  }

  return deduped;
}

function getHistoryWindow(range: PriceRange): { period1: Date; period2: Date; interval: '5m' | '1d' | '1wk' | '1mo' } {
  const now = new Date();
  const period2 = new Date(now);
  const period1 = new Date(now);

  switch (range) {
    case '1d':
      period1.setDate(period1.getDate() - 1);
      return { period1, period2, interval: '5m' };
    case '5d':
      period1.setDate(period1.getDate() - 5);
      return { period1, period2, interval: '1d' };
    case '1mo':
      period1.setMonth(period1.getMonth() - 1);
      return { period1, period2, interval: '1d' };
    case '6mo':
      period1.setMonth(period1.getMonth() - 6);
      return { period1, period2, interval: '1d' };
    case '1y':
      period1.setFullYear(period1.getFullYear() - 1);
      return { period1, period2, interval: '1d' };
    case '5y':
      period1.setFullYear(period1.getFullYear() - 5);
      return { period1, period2, interval: '1wk' };
    default: {
      const exhaustiveRange: never = range;
      throw new Error(`Unsupported Yahoo price range: ${String(exhaustiveRange)}`);
    }
  }
}

function getStatementWindow(period: StatementPeriod): {
  period1: Date;
  period2: Date;
  type: 'annual' | 'quarterly';
} {
  const period2 = new Date();
  const period1 = new Date(period2);

  switch (period) {
    case 'annual':
      period1.setFullYear(period1.getFullYear() - 10);
      return { period1, period2, type: 'annual' };
    case 'quarterly':
      period1.setFullYear(period1.getFullYear() - 3);
      return { period1, period2, type: 'quarterly' };
    default: {
      const exhaustivePeriod: never = period;
      throw new Error(`Unsupported Yahoo statement period: ${String(exhaustivePeriod)}`);
    }
  }
}

function wrapYahooError(operation: string, symbol: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Yahoo Finance ${operation} failed for ${symbol}: ${message}`);
}

async function getQuoteSummaryStatements(
  symbol: string,
  period: StatementPeriod
): Promise<{
  incomeStatement: StatementRecord[];
  balanceSheet: StatementRecord[];
  cashFlow: StatementRecord[];
}> {
  const modules = QUOTE_SUMMARY_MODULES_BY_PERIOD[period];
  const summary = await queueYahooCall(() =>
    yahooFinance.quoteSummary(symbol, {
      modules: [modules.income, modules.balance, modules.cashFlow],
    })
  );

  const typedSummary = summary as QuoteSummaryResult;

  return {
    incomeStatement: normalizeQuoteSummarySection(typedSummary[modules.income], modules.income),
    balanceSheet: normalizeQuoteSummarySection(typedSummary[modules.balance], 'balanceSheetStatements'),
    cashFlow: normalizeQuoteSummarySection(typedSummary[modules.cashFlow], 'cashflowStatements'),
  };
}

async function getFundamentalsStatements(
  symbol: string,
  period: StatementPeriod,
  sections: Array<keyof typeof FUNDAMENTALS_MODULE_BY_SECTION>
): Promise<Partial<Record<keyof typeof FUNDAMENTALS_MODULE_BY_SECTION, StatementRecord[]>>> {
  const window = getStatementWindow(period);
  const output: Partial<Record<keyof typeof FUNDAMENTALS_MODULE_BY_SECTION, StatementRecord[]>> = {};

  for (const section of sections) {
    const results = await queueYahooCall(() =>
      yahooFinance.fundamentalsTimeSeries(symbol, {
        period1: window.period1,
        period2: window.period2,
        type: window.type,
        module: FUNDAMENTALS_MODULE_BY_SECTION[section],
      })
    );

    output[section] = normalizeFundamentalsResults(results as FundamentalsTimeSeriesResult[]);
  }

  return output;
}

export class YahooFinanceProvider implements FinanceProvider {
  readonly name = 'yahoo';
  readonly capabilities = yahooCapabilities;

  async getQuote(symbol: string): Promise<Quote> {
    try {
      const result = await queueYahooCall(() => yahooFinance.quote(symbol));
      const typedResult = result as YahooQuote;
      const price = toNullableNumber(typedResult.regularMarketPrice);

      if (price === null) {
        throw new Error(`Yahoo quote response missing price for ${symbol}`);
      }

      return {
        symbol: typedResult.symbol ?? symbol,
        price,
        currency: typedResult.currency ?? null,
        asOf: new Date().toISOString(),
      };
    } catch (error) {
      throw wrapYahooError('quote lookup', symbol, error);
    }
  }

  async getPriceHistory(symbol: string, range: PriceRange): Promise<PriceBar[]> {
    try {
      const { period1, period2, interval } = getHistoryWindow(range);
      const result = await queueYahooCall(() =>
        yahooFinance.chart(symbol, {
          period1,
          period2,
          interval,
        })
      );
      const typedResult = result as ChartResultArray;

      return typedResult.quotes.flatMap((quote) => {
        const open = toNullableNumber(quote.open);
        const high = toNullableNumber(quote.high);
        const low = toNullableNumber(quote.low);
        const close = toNullableNumber(quote.close);

        if (open === null || high === null || low === null || close === null) {
          return [];
        }

        return [{
          date: quote.date.toISOString(),
          open,
          high,
          low,
          close,
          volume: toNullableNumber(quote.volume) ?? undefined,
        }];
      });
    } catch (error) {
      throw wrapYahooError('price history lookup', symbol, error);
    }
  }

  async getStatements(symbol: string, period: StatementPeriod): Promise<FinancialStatements> {
    const warnings: string[] = [];
    let incomeStatement: StatementRecord[] = [];
    let balanceSheet: StatementRecord[] = [];
    let cashFlow: StatementRecord[] = [];

    try {
      const summaryStatements = await getQuoteSummaryStatements(symbol, period);
      incomeStatement = summaryStatements.incomeStatement;
      balanceSheet = summaryStatements.balanceSheet;
      cashFlow = summaryStatements.cashFlow;
    } catch (error) {
      warnings.push(wrapYahooError('statement summary lookup', symbol, error).message);
    }

    const missingSections = (['incomeStatement', 'balanceSheet', 'cashFlow'] as const).filter((section) => {
      switch (section) {
        case 'incomeStatement':
          return incomeStatement.length === 0;
        case 'balanceSheet':
          return balanceSheet.length === 0;
        case 'cashFlow':
          return cashFlow.length === 0;
      }
    });

    if (missingSections.length > 0) {
      try {
        const fallbackStatements = await getFundamentalsStatements(symbol, period, [...missingSections]);
        incomeStatement = dedupeStatementRecords([
          ...incomeStatement,
          ...(fallbackStatements.incomeStatement ?? []),
        ]);
        balanceSheet = dedupeStatementRecords([
          ...balanceSheet,
          ...(fallbackStatements.balanceSheet ?? []),
        ]);
        cashFlow = dedupeStatementRecords([...cashFlow, ...(fallbackStatements.cashFlow ?? [])]);
      } catch (error) {
        warnings.push(wrapYahooError('fundamentals lookup', symbol, error).message);
      }
    }

    let currency: string | null | undefined;
    try {
      const quote = await this.getQuote(symbol);
      currency = quote.currency;
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
    }

    return {
      symbol,
      period,
      currency,
      incomeStatement,
      balanceSheet,
      cashFlow,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }
}

export const yahooProvider = new YahooFinanceProvider();
