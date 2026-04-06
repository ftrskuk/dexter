export type ProviderName = 'yahoo' | 'fmp' | 'finnhub';
export type StatementPeriod = 'annual' | 'quarterly';
export type PriceRange = '1d' | '5d' | '1mo' | '6mo' | '1y' | '5y';

export type StatementValue = number | string | null | undefined;
export type StatementRecord = Record<string, StatementValue> & { date: string };

export interface Quote {
  symbol: string;
  price: number;
  currency?: string;
  asOf: string;
}

export interface PriceBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface FinancialStatements {
  period: StatementPeriod;
  income?: Array<Record<string, number | string | null>>;
  balance?: Array<Record<string, number | string | null>>;
  cashflow?: Array<Record<string, number | string | null>>;
  symbol?: string;
  currency?: string | null;
  warnings?: string[];
  incomeStatement?: StatementRecord[];
  balanceSheet?: StatementRecord[];
  cashFlow?: StatementRecord[];
}

export interface KeyRatios {
  pe?: number;
  pb?: number;
  ps?: number;
  roe?: number;
  roa?: number;
  grossMargin?: number;
  operatingMargin?: number;
  debtToEquity?: number;
}

export interface AnalystEstimates {
  epsCurrentYear?: number;
  epsNextYear?: number;
  revenueCurrentYear?: number;
  revenueNextYear?: number;
  targetPrice?: number;
}

export interface InsiderTrade {
  symbol?: string;
  name?: string;
  share?: number;
  change?: number;
  filingDate?: string;
  transactionDate?: string;
  transactionCode?: string;
  transactionPrice?: number;
}

export interface FinanceProvider {
  readonly name: ProviderName;
  readonly capabilities: Partial<
    Record<'quote' | 'priceHistory' | 'statements' | 'ratios' | 'estimates' | 'insiderTrades', true>
  >;

  getQuote?(symbol: string): Promise<Quote>;
  getPriceHistory?(symbol: string, range: PriceRange): Promise<PriceBar[]>;
  getStatements?(symbol: string, period: StatementPeriod): Promise<FinancialStatements>;
  getRatios?(symbol: string): Promise<KeyRatios>;
  getEstimates?(symbol: string): Promise<AnalystEstimates>;
  getInsiderTrades?(symbol: string): Promise<InsiderTrade[]>;
}
