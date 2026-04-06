import axios, { AxiosError } from 'axios';

import type {
  AnalystEstimates,
  FinanceProvider,
  FinancialStatements,
  KeyRatios,
  PriceBar,
  PriceRange,
  Quote,
  StatementPeriod,
} from '../types.js';

const BASE_URL = 'https://financialmodelingprep.com/api/v3';

type FmpPrimitive = number | string | boolean | null;
type FmpRecord = Record<string, FmpPrimitive>;

function notImplemented(method: string): never {
  throw new Error(`FMP provider method not implemented: ${method}`);
}

function getApiKey(): string {
  const apiKey = process.env.FMP_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('FMP_API_KEY is not set');
  }

  return apiKey;
}

function getFmpPeriod(period: StatementPeriod): 'annual' | 'quarter' {
  return period === 'quarterly' ? 'quarter' : 'annual';
}

function normalizeStatementRow(row: Record<string, unknown>): Record<string, number | string | null> {
  const normalized: Record<string, number | string | null> = {};

  for (const [key, value] of Object.entries(row)) {
    if (
      typeof value === 'number'
      || typeof value === 'string'
      || value === null
    ) {
      normalized[key] = value;
    }
  }

  return normalized;
}

function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function pickFirstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = coerceNumber(record[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

async function fetchFmp<T>(endpoint: string, params: Record<string, string>): Promise<T> {
  try {
    const response = await axios.get<T>(`${BASE_URL}${endpoint}`, {
      params: {
        ...params,
        apikey: getApiKey(),
      },
    });

    return response.data;
  } catch (error) {
    if (error instanceof AxiosError) {
      if (error.response?.status === 429) {
        throw new Error('FMP rate limit exceeded (HTTP 429)');
      }

      const detail = error.response
        ? `${error.response.status} ${error.response.statusText}`
        : error.message;
      throw new Error(`FMP request failed for ${endpoint}: ${detail}`);
    }

    throw error;
  }
}

export class FmpFinanceProvider implements FinanceProvider {
  readonly name = 'fmp' as const;

  readonly capabilities = {
    statements: true,
    ratios: true,
  } as const;

  async getQuote(_symbol: string): Promise<Quote> {
    return notImplemented('getQuote');
  }

  async getPriceHistory(_symbol: string, _range: PriceRange): Promise<PriceBar[]> {
    return notImplemented('getPriceHistory');
  }

  async getStatements(symbol: string, period: StatementPeriod): Promise<FinancialStatements> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const fmpPeriod = getFmpPeriod(period);

    const [income, balance, cashflow] = await Promise.all([
      fetchFmp<FmpRecord[]>(`/income-statement/${normalizedSymbol}`, { period: fmpPeriod }),
      fetchFmp<FmpRecord[]>(`/balance-sheet-statement/${normalizedSymbol}`, { period: fmpPeriod }),
      fetchFmp<FmpRecord[]>(`/cash-flow-statement/${normalizedSymbol}`, { period: fmpPeriod }),
    ]);

    return {
      period,
      income: Array.isArray(income) ? income.map(normalizeStatementRow) : [],
      balance: Array.isArray(balance) ? balance.map(normalizeStatementRow) : [],
      cashflow: Array.isArray(cashflow) ? cashflow.map(normalizeStatementRow) : [],
    };
  }

  async getRatios(symbol: string): Promise<KeyRatios> {
    const normalizedSymbol = symbol.trim().toUpperCase();
    const ratios = await fetchFmp<Array<Record<string, unknown>>>(`/ratios/${normalizedSymbol}`, {});
    const latestRatios = Array.isArray(ratios) ? ratios[0] : undefined;

    if (!latestRatios || typeof latestRatios !== 'object') {
      const metrics = await fetchFmp<Array<Record<string, unknown>>>(`/key-metrics/${normalizedSymbol}`, {});
      const latestMetrics = Array.isArray(metrics) ? metrics[0] : undefined;

      if (!latestMetrics || typeof latestMetrics !== 'object') {
        return {};
      }

      return {
        pe: pickFirstNumber(latestMetrics, ['peRatio']),
        pb: pickFirstNumber(latestMetrics, ['pbRatio']),
        ps: pickFirstNumber(latestMetrics, ['priceToSalesRatio']),
        roe: pickFirstNumber(latestMetrics, ['roe']),
        roa: pickFirstNumber(latestMetrics, ['roa']),
        grossMargin: pickFirstNumber(latestMetrics, ['grossProfitMargin']),
        operatingMargin: pickFirstNumber(latestMetrics, ['operatingProfitMargin']),
        debtToEquity: pickFirstNumber(latestMetrics, ['debtToEquity']),
      };
    }

    return {
      pe: pickFirstNumber(latestRatios, ['priceEarningsRatio', 'priceToEarningsRatio', 'peRatio']),
      pb: pickFirstNumber(latestRatios, ['priceToBookRatio', 'pbRatio']),
      ps: pickFirstNumber(latestRatios, ['priceToSalesRatio', 'psRatio']),
      roe: pickFirstNumber(latestRatios, ['returnOnEquity', 'roe']),
      roa: pickFirstNumber(latestRatios, ['returnOnAssets', 'roa']),
      grossMargin: pickFirstNumber(latestRatios, ['grossProfitMargin', 'grossMargin']),
      operatingMargin: pickFirstNumber(latestRatios, ['operatingProfitMargin', 'operatingMargin']),
      debtToEquity: pickFirstNumber(latestRatios, ['debtEquityRatio', 'debtToEquity']),
    };
  }

  async getEstimates(_symbol: string): Promise<AnalystEstimates> {
    return notImplemented('getEstimates');
  }
}

export const fmpProvider = new FmpFinanceProvider();
