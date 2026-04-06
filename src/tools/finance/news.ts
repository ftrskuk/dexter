import { DynamicStructuredTool } from '@langchain/core/tools';
import YahooFinance from 'yahoo-finance2';
import { z } from 'zod';
import { financeApi } from './api.js';
import { formatToolResult } from '../types.js';

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

const CompanyNewsInputSchema = z.object({
  ticker: z
    .string()
    .describe("The stock ticker symbol to fetch company news for. For example, 'AAPL' for Apple."),
  limit: z
    .number()
    .default(5)
    .describe('Maximum number of news articles to return (default: 5, max: 10).'),
});

export const getCompanyNews = new DynamicStructuredTool({
  name: 'get_company_news',
  description:
    'Retrieves recent company news headlines for a stock ticker, including title, source, publication date, and URL. Use for company catalysts, price move explanations, press releases, and recent announcements.',
  schema: CompanyNewsInputSchema,
  func: async (input) => {
    const ticker = input.ticker.trim().toUpperCase();
    const limit = Math.min(input.limit, 10);

    await financeApi.getQuote(ticker).catch(() => null);

    const result = await yahooFinance.search(ticker, {
      quotesCount: 1,
      newsCount: limit,
      enableFuzzyQuery: false,
    });

    return formatToolResult(result.news.map((item) => ({
      title: item.title,
      source: item.publisher,
      date: item.providerPublishTime instanceof Date
        ? item.providerPublishTime.toISOString()
        : undefined,
      url: item.link,
      related_tickers: item.relatedTickers,
    })), [`https://finance.yahoo.com/quote/${ticker}/news`]);
  },
});
