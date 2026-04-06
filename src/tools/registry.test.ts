import { describe, expect, it } from '@jest/globals';
import { getToolRegistry } from './registry.js';

describe('tool registry finance contracts', () => {
  it('does not expose removed finance tools in the public registry', () => {
    const toolNames = getToolRegistry('gpt-5.4').map((tool) => tool.name);
    const expectedFinanceToolNames = ['get_financials', 'get_market_data'];

    expect(toolNames).toEqual(expect.arrayContaining(expectedFinanceToolNames));
    expect(toolNames).not.toEqual(
      expect.arrayContaining([
        'read_filings',
        'stock_screener',
        'get_crypto_price_snapshot',
        'get_crypto_prices',
        'get_available_crypto_tickers',
      ])
    );
  });
});
