import { getCache, type Cache } from '../../utils/cache.js';
import { FmpFinanceProvider, fmpProvider } from './providers/fmp.js';
import { FinnhubFinanceProvider, finnhubProvider } from './providers/finnhub.js';
import { YahooFinanceProvider, yahooProvider } from './providers/yahoo.js';
import { FinanceRateLimiter, type RateLimitConfig } from './rate-limit.js';
import type {
  AnalystEstimates,
  FinanceProvider,
  FinancialStatements,
  InsiderTrade,
  KeyRatios,
  PriceBar,
  PriceRange,
  ProviderName,
  Quote,
  StatementPeriod,
} from './types.js';

const TTL = {
  quote: 60_000,
  priceHistory: 900_000,
  statements: 86_400_000,
  ratios: 21_600_000,
  estimates: 21_600_000,
  insiderTrades: 3_600_000,
} as const;

const ROUTES = {
  quote: ['yahoo', 'finnhub'],
  priceHistory: ['yahoo', 'finnhub'],
  statements: ['fmp', 'yahoo'],
  ratios: ['finnhub', 'fmp'],
  estimates: ['finnhub'],
  insiderTrades: ['finnhub'],
} as const;

const RATE_LIMITS: RateLimitConfig = {
  finnhub: {
    quote: { maxRequests: 60, window: 'minute' },
    priceHistory: { maxRequests: 60, window: 'minute' },
    ratios: { maxRequests: 60, window: 'minute' },
    estimates: { maxRequests: 60, window: 'minute' },
    insiderTrades: { maxRequests: 60, window: 'minute' },
  },
  fmp: {
    statements: { maxRequests: 250, window: 'day' },
    ratios: { maxRequests: 250, window: 'day' },
  },
};

type RouteName = keyof typeof ROUTES;
type ProviderRegistry = {
  yahoo: YahooFinanceProvider;
  fmp: FmpFinanceProvider;
  finnhub: FinnhubFinanceProvider;
};

export interface ApiResponse {
  data: Record<string, unknown>;
  url: string;
}

export function stripFieldsDeep(value: unknown, fields: readonly string[]): unknown {
  const fieldsToStrip = new Set(fields);

  function walk(node: unknown): unknown {
    if (Array.isArray(node)) {
      return node.map(walk);
    }

    if (!node || typeof node !== 'object') {
      return node;
    }

    const record = node as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};

    for (const [key, child] of Object.entries(record)) {
      if (fieldsToStrip.has(key)) {
        continue;
      }

      cleaned[key] = walk(child);
    }

    return cleaned;
  }

  return walk(value);
}

const removedLegacyApiError = new Error(
  'Legacy generic finance API wrapper removed. Use financeApi domain methods instead.',
);

export const api = {
  async get(
    _endpoint: string,
    _params: Record<string, string | number | string[] | undefined>,
    _options?: { cacheable?: boolean; ttlMs?: number },
  ): Promise<ApiResponse> {
    throw removedLegacyApiError;
  },
  async post(
    _endpoint: string,
    _body: Record<string, unknown>,
  ): Promise<ApiResponse> {
    throw removedLegacyApiError;
  },
};

export const callApi = api.get;

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function getProviderRequestCost(providerName: ProviderName, route: RouteName): number {
  if (providerName !== 'fmp') {
    return 1;
  }

  switch (route) {
    case 'statements':
      return 3;
    case 'ratios':
      return 2;
    default:
      return 1;
  }
}

export class FinanceApi {
  private providers: ProviderRegistry;
  private cache: Cache;
  private limiter: FinanceRateLimiter;

  constructor(cache: Cache) {
    this.providers = {
      yahoo: yahooProvider,
      fmp: fmpProvider,
      finnhub: finnhubProvider,
    };
    this.cache = cache;
    this.limiter = new FinanceRateLimiter(RATE_LIMITS);
  }

  private async getCachedOrFetch<T>(
    route: RouteName,
    cacheKey: string,
    ttl: number,
    invoke: (providerName: ProviderName, provider: FinanceProvider) => Promise<T | null>,
    errorMessage: string,
  ): Promise<T> {
    const cached = await this.cache.get<T>(cacheKey);
    if (cached !== null) {
      return cached;
    }

    for (const providerName of ROUTES[route]) {
      const provider: FinanceProvider = this.providers[providerName];

        if (!this.limiter.tryConsume(providerName, route, getProviderRequestCost(providerName, route))) {
          continue;
        }

      try {
        const result = await invoke(providerName, provider);
        if (result === null) {
          continue;
        }

        await this.cache.set(cacheKey, result, { ttl });
        return result;
      } catch (error) {
        console.error(`${providerName} ${route} failed:`, error);
      }
    }

    throw new Error(errorMessage);
  }

  async getQuote(symbol: string): Promise<Quote> {
    const normalizedSymbol = normalizeSymbol(symbol);

    return this.getCachedOrFetch(
      'quote',
      `quote:${normalizedSymbol}`,
      TTL.quote,
      async (_providerName, provider) => {
        if (!provider.getQuote) {
          return null;
        }

        return provider.getQuote(normalizedSymbol);
      },
      `Unable to fetch quote for ${normalizedSymbol} from any provider`,
    );
  }

  async getPriceHistory(symbol: string, range: PriceRange): Promise<PriceBar[]> {
    const normalizedSymbol = normalizeSymbol(symbol);

    return this.getCachedOrFetch(
      'priceHistory',
      `priceHistory:${normalizedSymbol}:${range}`,
      TTL.priceHistory,
      async (_providerName, provider) => {
        if (!provider.getPriceHistory) {
          return null;
        }

        return provider.getPriceHistory(normalizedSymbol, range);
      },
      `Unable to fetch price history for ${normalizedSymbol} (${range}) from any provider`,
    );
  }

  async getStatements(
    symbol: string,
    period: StatementPeriod = 'annual',
  ): Promise<FinancialStatements> {
    const normalizedSymbol = normalizeSymbol(symbol);

    return this.getCachedOrFetch(
      'statements',
      `statements:${normalizedSymbol}:${period}`,
      TTL.statements,
      async (_providerName, provider) => {
        if (!provider.getStatements) {
          return null;
        }

        return provider.getStatements(normalizedSymbol, period);
      },
      `Unable to fetch financial statements for ${normalizedSymbol} (${period}) from any provider`,
    );
  }

  async getKeyRatios(symbol: string): Promise<KeyRatios> {
    const normalizedSymbol = normalizeSymbol(symbol);

    return this.getCachedOrFetch(
      'ratios',
      `ratios:${normalizedSymbol}`,
      TTL.ratios,
      async (_providerName, provider) => {
        if (!provider.getRatios) {
          return null;
        }

        return provider.getRatios(normalizedSymbol);
      },
      `Unable to fetch key ratios for ${normalizedSymbol} from any provider`,
    );
  }

  async getAnalystEstimates(symbol: string): Promise<AnalystEstimates> {
    const normalizedSymbol = normalizeSymbol(symbol);

    return this.getCachedOrFetch(
      'estimates',
      `estimates:${normalizedSymbol}`,
      TTL.estimates,
      async (_providerName, provider) => {
        if (!provider.getEstimates) {
          return null;
        }

        return provider.getEstimates(normalizedSymbol);
      },
      `Unable to fetch analyst estimates for ${normalizedSymbol} from any provider`,
    );
  }

  async getInsiderTrades(symbol: string): Promise<InsiderTrade[]> {
    const normalizedSymbol = normalizeSymbol(symbol);

    return this.getCachedOrFetch(
      'insiderTrades',
      `insiderTrades:${normalizedSymbol}`,
      TTL.insiderTrades,
      async (_providerName, provider) => {
        if (!provider.getInsiderTrades) {
          return null;
        }

        return provider.getInsiderTrades(normalizedSymbol);
      },
      `Unable to fetch insider trades for ${normalizedSymbol} from any provider`,
    );
  }
}

export const financeApi = new FinanceApi(getCache());
