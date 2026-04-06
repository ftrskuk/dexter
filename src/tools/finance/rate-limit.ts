import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { dexterPath } from '../../utils/paths.js';
import type { ProviderName } from './types.js';

export type RateLimitWindow = 'minute' | 'hour' | 'day';

export interface RateLimitRule {
  maxRequests: number;
  window: RateLimitWindow;
}

export type RateLimitConfig = Partial<
  Record<ProviderName, Partial<Record<string, RateLimitRule>>>
>;

interface CounterEntry {
  count: number;
  windowStartedAt: string;
}

type CounterState = Partial<Record<ProviderName, Partial<Record<string, CounterEntry>>>>;

const DEFAULT_STORE_PATH = dexterPath('cache', 'finance-rate-limit.json');

function getWindowDurationMs(window: RateLimitWindow): number {
  switch (window) {
    case 'minute':
      return 60_000;
    case 'hour':
      return 60 * 60_000;
    case 'day':
      return 24 * 60 * 60_000;
  }
}

function isCounterEntry(value: unknown): value is CounterEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.count === 'number' && typeof candidate.windowStartedAt === 'string';
}

function normalizeState(value: unknown): CounterState {
  if (typeof value !== 'object' || value === null) {
    return {};
  }

  const normalized: CounterState = {};

  for (const [provider, operations] of Object.entries(value as Record<string, unknown>)) {
    if (typeof operations !== 'object' || operations === null) {
      continue;
    }

    const providerState: Partial<Record<string, CounterEntry>> = {};
    for (const [operation, entry] of Object.entries(operations)) {
      if (isCounterEntry(entry)) {
        providerState[operation] = entry;
      }
    }

    if (Object.keys(providerState).length > 0) {
      normalized[provider as ProviderName] = providerState;
    }
  }

  return normalized;
}

export class FinanceRateLimiter {
  private state: CounterState;

  constructor(
    private readonly config: RateLimitConfig,
    private readonly storePath: string = DEFAULT_STORE_PATH,
  ) {
    this.state = this.loadState();
  }

  tryConsume(provider: ProviderName, operation: string, cost = 1): boolean {
    const rule = this.config[provider]?.[operation];
    if (!rule) {
      return true;
    }

    if (!Number.isInteger(cost) || cost <= 0) {
      throw new Error(`Rate limit cost must be a positive integer. Received: ${cost}`);
    }

    const now = Date.now();
    const providerState = (this.state[provider] ??= {});
    const existing = providerState[operation];
    const windowDurationMs = getWindowDurationMs(rule.window);

    if (!existing || now - Date.parse(existing.windowStartedAt) >= windowDurationMs) {
      providerState[operation] = {
        count: cost,
        windowStartedAt: new Date(now).toISOString(),
      };
      this.persistState();
      return true;
    }

    if (existing.count + cost > rule.maxRequests) {
      return false;
    }

    existing.count += cost;
    this.persistState();
    return true;
  }

  private loadState(): CounterState {
    if (!existsSync(this.storePath)) {
      return {};
    }

    try {
      const content = readFileSync(this.storePath, 'utf-8');
      return normalizeState(JSON.parse(content) as unknown);
    } catch {
      return {};
    }
  }

  private persistState(): void {
    const directory = dirname(this.storePath);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    writeFileSync(this.storePath, JSON.stringify(this.state, null, 2));
  }
}
