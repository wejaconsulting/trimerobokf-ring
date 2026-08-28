import { MockFortnoxAdapter, type MockFortnoxDataset } from './mock-adapter.js';
import type { FortnoxReadPort } from './ports.js';
import { RealFortnoxAdapter, type AccessTokenProvider } from './real-adapter.js';

export interface FortnoxAdapterConfig {
  readonly adapter: 'mock' | 'real';
  readonly shadowMode: boolean;
  readonly writesEnabled: boolean;
  readonly baseUrl?: string;
  readonly tokenProvider?: AccessTokenProvider;
}

/**
 * Composition root for the Fortnox boundary.
 *
 * Phase 1 refuses to hand back a real adapter while shadow mode is on. This is
 * the single place where the choice is made, so there is exactly one line to
 * audit.
 */
export function createFortnoxAdapter(
  config: FortnoxAdapterConfig,
  dataset: MockFortnoxDataset,
): FortnoxReadPort {
  if (config.adapter === 'mock') {
    return new MockFortnoxAdapter(dataset);
  }

  if (config.shadowMode) {
    throw new Error(
      'Refusing to construct the real Fortnox adapter while SHADOW_MODE is enabled. ' +
        'Phase 1 supports FORTNOX_ADAPTER=mock only.',
    );
  }
  if (!config.tokenProvider || !config.baseUrl) {
    throw new Error('Real Fortnox adapter requires baseUrl and a tokenProvider.');
  }

  return new RealFortnoxAdapter({
    baseUrl: config.baseUrl,
    tokenProvider: config.tokenProvider,
    writesEnabled: config.writesEnabled,
    shadowMode: config.shadowMode,
  });
}
