import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { AIMessage } from '@langchain/core/messages';
import { z } from 'zod';
import * as earningsModule from '../earnings.js';
import * as keyRatiosModule from '../key-ratios.js';
jest.mock('../../../agent/prompts.js', () => ({
  getCurrentDate: () => '2026-04-06',
}));
jest.mock('../../../model/llm.js', () => ({
  callLlm: jest.fn(),
}));
import { callLlm } from '../../../model/llm.js';
import { createGetFinancials } from '../get-financials.js';

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

describe('get_financials contract', () => {
  it('keeps public name and schema unchanged', () => {
    const tool = createGetFinancials('gpt-5.4');
    const schema = getToolSchema(tool)?.toJSONSchema();

    expect(tool.name).toBe('get_financials');
    expect(schema).toMatchObject({
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    });
  });

  it('routes only surviving finance tools', async () => {
    callLlmMock.mockResolvedValue({
      response: new AIMessage({ content: '', tool_calls: [] }),
    } as Awaited<ReturnType<typeof callLlm>>);

    const tool = createGetFinancials('gpt-5.4');
    const result = await tool.invoke({ query: 'Show me Apple financials' });

    expect(JSON.parse(result as string)).toEqual({ data: { error: 'No tools selected for query' } });
    expect(callLlmMock).toHaveBeenCalledTimes(1);
    const options = callLlmMock.mock.calls[0]?.[1];
    expect(options).toBeDefined();
    const toolNames = (options?.tools ?? []).map((subTool) => subTool.name);
    expect(toolNames).toEqual([
      'get_income_statements',
      'get_balance_sheets',
      'get_cash_flow_statements',
      'get_all_financial_statements',
      'get_earnings',
      'get_key_ratios',
      'get_historical_key_ratios',
      'get_analyst_estimates',
    ]);
  });

  it('returns the combined result envelope', async () => {
    callLlmMock.mockResolvedValue({
      response: new AIMessage({
        content: '',
        tool_calls: [
          { id: 'call_1', name: 'get_key_ratios', args: { ticker: 'AAPL' }, type: 'tool_call' },
          { id: 'call_2', name: 'get_earnings', args: { ticker: 'AAPL' }, type: 'tool_call' },
        ],
      }),
    } as Awaited<ReturnType<typeof callLlm>>);
    jest.spyOn(keyRatiosModule.getKeyRatios, 'invoke').mockResolvedValue(
      JSON.stringify({ data: { pe_ratio: 28.4 }, sourceUrls: ['https://example.com/key-ratios'] })
    );
    jest.spyOn(earningsModule.getEarnings, 'invoke').mockResolvedValue(
      JSON.stringify({ data: { revenue: 1000 }, sourceUrls: ['https://example.com/earnings'] })
    );

    const tool = createGetFinancials('gpt-5.4');
    const result = await tool.invoke({ query: 'Show me Apple valuation and earnings' });
    const parsed = JSON.parse(result as string);

    expect(parsed.sourceUrls).toEqual(['https://example.com/key-ratios', 'https://example.com/earnings']);
    expect(parsed.data).toMatchObject({
      get_key_ratios_AAPL: expect.stringContaining('P/E: 28.4'),
      get_earnings_AAPL: expect.stringContaining('Revenue: 1.0K'),
    });
  });
});
