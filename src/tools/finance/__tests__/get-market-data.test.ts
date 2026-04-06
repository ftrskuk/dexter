import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
jest.mock('../../../agent/prompts.js', () => ({
  getCurrentDate: () => '2026-04-06',
}));
jest.mock('../../../model/llm.js', () => ({
  callLlm: jest.fn(),
}));
import { callLlm } from '../../../model/llm.js';
import * as newsModule from '../news.js';
import * as stockPriceModule from '../stock-price.js';
import { createGetMarketData } from '../get-market-data.js';

const callLlmMock = callLlm as jest.MockedFunction<typeof callLlm>;

function getToolSchema(tool: unknown): z.ZodTypeAny | undefined {
  if (!tool || typeof tool !== 'object') {
    return undefined;
  }

  const candidate = tool as { schema?: unknown; lc_kwargs?: { schema?: unknown } };
  const schema = candidate.schema ?? candidate.lc_kwargs?.schema;

  if (schema && typeof schema === 'object' && 'toJSONSchema' in schema) {
    return schema as z.ZodTypeAny;
  }

  return undefined;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('get_market_data contract', () => {
  it('keeps public name and schema unchanged', () => {
    const tool = createGetMarketData('gpt-5.4');
    const schema = getToolSchema(tool)?.toJSONSchema();

    expect(tool.name).toBe('get_market_data');
    expect(schema).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
  });

  it('routes only surviving market data tools', async () => {
    callLlmMock.mockResolvedValue({
      response: new AIMessage({ content: '', tool_calls: [] }),
    } as Awaited<ReturnType<typeof callLlm>>);

    const tool = createGetMarketData('gpt-5.4');
    const result = await tool.invoke({ query: 'Show me Apple market data' });

    expect(JSON.parse(result as string)).toEqual({ data: { error: 'No tools selected for query' } });
    expect(callLlmMock).toHaveBeenCalledTimes(1);
    const options = callLlmMock.mock.calls[0]?.[1];
    expect(options).toBeDefined();
    const toolNames = (options?.tools ?? []).map((subTool) => subTool.name);
    expect(toolNames).toEqual([
      'get_stock_price',
      'get_stock_prices',
      'get_available_stock_tickers',
      'get_company_news',
      'get_insider_trades',
    ]);
  });

  it('returns the combined result envelope', async () => {
    callLlmMock.mockResolvedValue({
      response: new AIMessage({
        content: '',
        tool_calls: [
          { id: 'call_1', name: 'get_stock_price', args: { ticker: 'AAPL' }, type: 'tool_call' },
          { id: 'call_2', name: 'get_company_news', args: { ticker: 'AAPL', limit: 2 }, type: 'tool_call' },
        ],
      }),
    } as Awaited<ReturnType<typeof callLlm>>);
    jest.spyOn(stockPriceModule.getStockPrice, 'invoke').mockResolvedValue(
      JSON.stringify({ data: { ticker: 'AAPL', price: 201.5, open: 200, high: 202, low: 199, volume: 1000 }, sourceUrls: ['https://example.com/stock-price'] })
    );
    jest.spyOn(newsModule.getCompanyNews, 'invoke').mockResolvedValue(
      JSON.stringify({ data: [{ title: 'Headline' }], sourceUrls: ['https://example.com/news'] })
    );

    const tool = createGetMarketData('gpt-5.4');
    const result = await tool.invoke({ query: 'Why is Apple up today?' });
    const parsed = JSON.parse(result as string);

    expect(parsed.sourceUrls).toEqual(['https://example.com/stock-price', 'https://example.com/news']);
    expect(parsed.data).toMatchObject({
      get_stock_price_AAPL: 'AAPL: $201.50 (O: $200.00 H: $202.00 L: $199.00) Vol: 1.0K',
      get_company_news_AAPL: '1. Headline',
    });
  });
});
