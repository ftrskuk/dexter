import type {
  AnalystEstimates,
  FinanceProvider,
  InsiderTrade,
  KeyRatios,
  PriceBar,
  PriceRange,
  Quote,
} from '../types.js';

const BASE_URL = 'https://finnhub.io/api/v1';
const MIN_REQUEST_INTERVAL_MS = 1_000;

interface FinnhubQuoteResponse {
  c?: number;
  t?: number;
}

interface FinnhubCandleResponse {
  c?: number[];
  h?: number[];
  l?: number[];
  o?: number[];
  s?: string;
  t?: number[];
  v?: number[];
}

interface FinnhubMetricResponse {
  metric?: Record<string, unknown>;
}

interface FinnhubEstimateEntry {
  avg?: number;
  period?: string;
  revenueAvg?: number;
}

interface FinnhubEstimateResponse {
  data?: FinnhubEstimateEntry[];
}

interface FinnhubInsiderTradeEntry {
  change?: number;
  filingDate?: string;
  name?: string;
  share?: number;
  symbol?: string;
  transactionCode?: string;
  transactionDate?: string;
  transactionPrice?: number;
}

interface FinnhubInsiderTradeResponse {
  data?: FinnhubInsiderTradeEntry[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getApiKey(): string {
  const apiKey = process.env.FINNHUB_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('Missing FINNHUB_API_KEY environment variable');
  }

  return apiKey;
}

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function toIsoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1_000).toISOString();
}

function getRangeConfig(range: PriceRange): { resolution: 'D' | 'W' | 'M'; from: number } {
  const now = Date.now();

  switch (range) {
    case '1d':
      return { resolution: 'D', from: Math.floor((now - 24 * 60 * 60_000) / 1_000) };
    case '5d':
      return { resolution: 'D', from: Math.floor((now - 5 * 24 * 60 * 60_000) / 1_000) };
    case '1mo':
      return { resolution: 'D', from: Math.floor((now - 30 * 24 * 60 * 60_000) / 1_000) };
    case '6mo':
      return { resolution: 'W', from: Math.floor((now - 182 * 24 * 60 * 60_000) / 1_000) };
    case '1y':
      return { resolution: 'W', from: Math.floor((now - 365 * 24 * 60 * 60_000) / 1_000) };
    case '5y':
      return { resolution: 'M', from: Math.floor((now - 5 * 365 * 24 * 60 * 60_000) / 1_000) };
  }
}

function pickEstimateValues(
  entries: FinnhubEstimateEntry[] | undefined,
  valueSelector: (entry: FinnhubEstimateEntry) => number | undefined,
): { current?: number; next?: number } {
  const currentYear = new Date().getUTCFullYear();
  const normalized = (entries ?? [])
    .map((entry) => {
      const year = Number.parseInt((entry.period ?? '').slice(0, 4), 10);
      const value = valueSelector(entry);

      if (!Number.isFinite(year) || !isFiniteNumber(value)) {
        return null;
      }

      return { year, value };
    })
    .filter((entry): entry is { year: number; value: number } => entry !== null)
    .sort((left, right) => left.year - right.year);

  if (normalized.length === 0) {
    return {};
  }

  const currentIndex = normalized.findIndex((entry) => entry.year >= currentYear);
  if (currentIndex >= 0) {
    return {
      current: normalized[currentIndex]?.value,
      next: normalized[currentIndex + 1]?.value,
    };
  }

  return {
    current: normalized[normalized.length - 1]?.value,
  };
}

function readMetricNumber(metric: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = metric[key];
    if (isFiniteNumber(value)) {
      return value;
    }
  }

  return undefined;
}

export class FinnhubFinanceProvider implements FinanceProvider {
  private static nextAvailableAt = 0;
  private static queue = Promise.resolve();

  readonly name = 'finnhub' as const;

  readonly capabilities = {
    quote: true,
    priceHistory: true,
    ratios: true,
    estimates: true,
    insiderTrades: true,
  } as const;

  private async waitForRateLimitSlot(): Promise<void> {
    const slot = FinnhubFinanceProvider.queue.then(async () => {
      const waitMs = Math.max(0, FinnhubFinanceProvider.nextAvailableAt - Date.now());
      if (waitMs > 0) {
        await delay(waitMs);
      }

      FinnhubFinanceProvider.nextAvailableAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
    });

    FinnhubFinanceProvider.queue = slot.catch(() => undefined);
    await slot;
  }

  private async request<TResponse>(
    endpoint: string,
    params: Record<string, string | number>,
  ): Promise<TResponse> {
    await this.waitForRateLimitSlot();

    const url = new URL(`${BASE_URL}${endpoint}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    url.searchParams.set('token', getApiKey());

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Finnhub request failed (${response.status} ${response.statusText})`);
    }

    return response.json() as Promise<TResponse>;
  }

  async getQuote(symbol: string): Promise<Quote> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const data = await this.request<FinnhubQuoteResponse>('/quote', { symbol: normalizedSymbol });

    if (!isFiniteNumber(data.c)) {
      throw new Error(`Finnhub quote response missing current price for ${normalizedSymbol}`);
    }

    return {
      symbol: normalizedSymbol,
      price: data.c,
      asOf: data.t ? toIsoDate(data.t) : new Date().toISOString(),
    };
  }

  async getPriceHistory(symbol: string, range: PriceRange): Promise<PriceBar[]> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const { resolution, from } = getRangeConfig(range);
    const to = Math.floor(Date.now() / 1_000);
    const data = await this.request<FinnhubCandleResponse>('/stock/candle', {
      symbol: normalizedSymbol,
      resolution,
      from,
      to,
    });

    if (data.s === 'no_data') {
      return [];
    }

    const opens = data.o ?? [];
    const highs = data.h ?? [];
    const lows = data.l ?? [];
    const closes = data.c ?? [];
    const timestamps = data.t ?? [];
    const volumes = data.v ?? [];
    const barCount = Math.min(opens.length, highs.length, lows.length, closes.length, timestamps.length);

    return Array.from({ length: barCount }, (_, index) => ({
      date: toIsoDate(timestamps[index] as number),
      open: opens[index] as number,
      high: highs[index] as number,
      low: lows[index] as number,
      close: closes[index] as number,
      volume: volumes[index],
    }));
  }

  async getRatios(symbol: string): Promise<KeyRatios> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const data = await this.request<FinnhubMetricResponse>('/stock/metric', {
      symbol: normalizedSymbol,
      metric: 'all',
    });
    const metric = data.metric ?? {};

    return {
      pe: readMetricNumber(metric, ['peBasicExclExtraTTM', 'peTTM']),
      pb: readMetricNumber(metric, ['pbAnnual']),
      ps: readMetricNumber(metric, ['psTTM']),
      roe: readMetricNumber(metric, ['roeTTM', 'roeAnnual']),
      roa: readMetricNumber(metric, ['roaTTM', 'roaAnnual']),
      grossMargin: readMetricNumber(metric, ['grossMarginTTM', 'grossMargin5Y']),
      operatingMargin: readMetricNumber(metric, ['operatingMarginTTM', 'operatingMargin5Y']),
      debtToEquity: readMetricNumber(metric, [
        'totalDebtToEquityQuarterly',
        'totalDebtToEquityAnnual',
        'netDebtToTotalEquityQuarterly',
        'netDebtToTotalEquityAnnual',
      ]),
    };
  }

  async getEstimates(symbol: string): Promise<AnalystEstimates> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const [epsData, revenueData, metricData] = await Promise.all([
      this.request<FinnhubEstimateResponse>('/stock/eps-estimate', {
        symbol: normalizedSymbol,
        freq: 'annual',
      }),
      this.request<FinnhubEstimateResponse>('/stock/revenue-estimate', {
        symbol: normalizedSymbol,
        freq: 'annual',
      }),
      this.request<FinnhubMetricResponse>('/stock/metric', {
        symbol: normalizedSymbol,
        metric: 'all',
      }),
    ]);

    const eps = pickEstimateValues(epsData.data, (entry) => entry.avg);
    const revenue = pickEstimateValues(revenueData.data, (entry) => entry.revenueAvg);
    const metric = metricData.metric ?? {};

    return {
      epsCurrentYear: eps.current,
      epsNextYear: eps.next,
      revenueCurrentYear: revenue.current,
      revenueNextYear: revenue.next,
      targetPrice: readMetricNumber(metric, ['targetMeanPrice']),
    };
  }

  async getInsiderTrades(symbol: string): Promise<InsiderTrade[]> {
    const normalizedSymbol = normalizeSymbol(symbol);
    const data = await this.request<FinnhubInsiderTradeResponse>('/stock/insider-transactions', {
      symbol: normalizedSymbol,
    });

    return (data.data ?? []).map((entry) => ({
      symbol: entry.symbol ?? normalizedSymbol,
      name: entry.name,
      share: entry.share,
      change: entry.change,
      filingDate: entry.filingDate,
      transactionDate: entry.transactionDate,
      transactionCode: entry.transactionCode,
      transactionPrice: entry.transactionPrice,
    }));
  }
}

export const finnhubProvider = new FinnhubFinanceProvider();
