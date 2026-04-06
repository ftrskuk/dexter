import { DynamicStructuredTool } from '@langchain/core/tools';
import YahooFinance from 'yahoo-finance2';
import { z } from 'zod';
import { financeApi } from './api.js';
import { formatToolResult } from '../types.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

export const STOCK_PRICE_DESCRIPTION = `
Fetches current stock price snapshots for equities, including open, high, low, close prices, volume, and market cap. Powered by Yahoo Finance.
`.trim();

type StockInterval = 'day' | 'week' | 'month' | 'year';

function getQuoteUrl(ticker: string): string {
  return `https://finance.yahoo.com/quote/${ticker}`;
}

function getHistoryUrl(ticker: string): string {
  return `https://finance.yahoo.com/quote/${ticker}/history`;
}

function toStartOfUtcDay(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }

  return date;
}

function toEndOfUtcDay(value: string): Date {
  const date = new Date(`${value}T23:59:59.999Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }

  return date;
}

function getPriceRange(startDate: string, endDate: string): '1d' | '5d' | '1mo' | '6mo' | '1y' | '5y' {
  const start = toStartOfUtcDay(startDate);
  const end = toEndOfUtcDay(endDate);
  const diffMs = end.getTime() - start.getTime();

  if (diffMs < 0) {
    throw new Error('start_date must be on or before end_date');
  }

  const days = diffMs / 86_400_000;

  if (days <= 1) return '1d';
  if (days <= 5) return '5d';
  if (days <= 31) return '1mo';
  if (days <= 183) return '6mo';
  if (days <= 366) return '1y';
  if (days <= 365 * 5 + 2) return '5y';

  throw new Error('Yahoo-backed historical price windows currently support up to 5 years');
}

function filterBarsByDateRange(
  bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume?: number }>,
  startDate: string,
  endDate: string,
) {
  const start = toStartOfUtcDay(startDate).getTime();
  const end = toEndOfUtcDay(endDate).getTime();

  return bars.filter((bar) => {
    const time = new Date(bar.date).getTime();
    return Number.isFinite(time) && time >= start && time <= end;
  });
}

function getBucketKey(date: Date, interval: StockInterval): string {
  switch (interval) {
    case 'day':
      return date.toISOString().slice(0, 10);
    case 'week': {
      const weekStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      const day = weekStart.getUTCDay();
      const diff = day === 0 ? -6 : 1 - day;
      weekStart.setUTCDate(weekStart.getUTCDate() + diff);
      return weekStart.toISOString().slice(0, 10);
    }
    case 'month':
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
    case 'year':
      return String(date.getUTCFullYear());
  }
}

function aggregateBars(
  bars: Array<{ date: string; open: number; high: number; low: number; close: number; volume?: number }>,
  interval: StockInterval,
) {
  if (interval === 'day') {
    return bars;
  }

  const grouped = new Map<string, Array<{ date: string; open: number; high: number; low: number; close: number; volume?: number }>>();

  for (const bar of bars) {
    const date = new Date(bar.date);
    if (Number.isNaN(date.getTime())) {
      continue;
    }

    const key = getBucketKey(date, interval);
    const bucket = grouped.get(key);
    if (bucket) {
      bucket.push(bar);
    } else {
      grouped.set(key, [bar]);
    }
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, bucket]) => {
      const sortedBucket = [...bucket].sort((left, right) => left.date.localeCompare(right.date));
      const first = sortedBucket[0];
      const last = sortedBucket[sortedBucket.length - 1];

      return {
        date: key,
        open: first.open,
        high: Math.max(...sortedBucket.map((bar) => bar.high)),
        low: Math.min(...sortedBucket.map((bar) => bar.low)),
        close: last.close,
        volume: sortedBucket.reduce((sum, bar) => sum + (bar.volume ?? 0), 0) || undefined,
      };
    });
}

function isLikelyUsEquityTicker(symbol: string): boolean {
  return /^[A-Z]{1,5}$/.test(symbol);
}

const StockPriceInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch current price for. For example, 'AAPL' for Apple."),
});

export const getStockPrice = new DynamicStructuredTool({
  name: 'get_stock_price',
  description:
    'Fetches the current stock price snapshot for an equity ticker, including open, high, low, close prices, volume, and market cap.',
  schema: StockPriceInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const [quote, recentBars] = await Promise.all([
      financeApi.getQuote(ticker),
      financeApi.getPriceHistory(ticker, '5d').catch(() => []),
    ]);
    const latestBar = recentBars[recentBars.length - 1];

    return formatToolResult({
      ticker: quote.symbol,
      price: quote.price,
      close: quote.price,
      currency: quote.currency,
      as_of: quote.asOf,
      open: latestBar?.open,
      high: latestBar?.high,
      low: latestBar?.low,
      volume: latestBar?.volume,
    }, [getQuoteUrl(ticker)]);
  },
});

const StockPricesInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch historical prices for. For example, 'AAPL' for Apple."),
  interval: z
    .enum(['day', 'week', 'month', 'year'])
    .default('day')
    .describe("The time interval for price data. Defaults to 'day'."),
  start_date: z.string().describe('Start date in YYYY-MM-DD format. Required.'),
  end_date: z.string().describe('End date in YYYY-MM-DD format. Required.'),
});

export const getStockPrices = new DynamicStructuredTool({
  name: 'get_stock_prices',
  description:
    'Retrieves historical price data for a stock over a specified date range, including open, high, low, close prices and volume.',
  schema: StockPricesInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const range = getPriceRange(input.start_date, input.end_date);
    const history = await financeApi.getPriceHistory(ticker, range);
    const filtered = filterBarsByDateRange(history, input.start_date, input.end_date);
    const aggregated = aggregateBars(filtered, input.interval);

    return formatToolResult(aggregated, [getHistoryUrl(ticker)]);
  },
});

export const getStockTickers = new DynamicStructuredTool({
  name: 'get_available_stock_tickers',
  description:
    'Retrieves a filtered snapshot of currently trending U.S. equity tickers from Yahoo Finance for quick exploration. This excludes obvious crypto, futures, index, and FX symbols and is not a complete market-wide ticker directory or general company lookup.',
  schema: z.object({}),
  func: async () => {
    const result = await yahooFinance.trendingSymbols('US', { count: 25 });
    const tickers = result.quotes
      .map((quote) => quote.symbol)
      .filter((symbol): symbol is string => typeof symbol === 'string' && isLikelyUsEquityTicker(symbol));

    return formatToolResult(tickers, ['https://finance.yahoo.com/trending-tickers']);
  },
});
