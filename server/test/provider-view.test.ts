import { describe, expect, it } from 'vitest';
import { catalogProviderView } from '../src/models/provider-view.ts';

function provider(auth: Record<string, unknown>) {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    auth,
    getModels: () => [],
  } as never;
}

describe('catalogProviderView', () => {
  it('advertises OAuth-only providers to the Pi Code adapter', () => {
    expect(catalogProviderView(provider({ oauth: {} }))).toMatchObject({
      rejected: true,
      reject_reason: 'oauth-only',
      supports_oauth: true,
      auth_type: 'oauth',
    });
  });

  it('keeps API-key providers on the official import path', () => {
    expect(catalogProviderView(provider({ apiKey: { login: () => undefined } }))).toMatchObject({
      rejected: false,
      supports_oauth: false,
      auth_type: 'api_key',
    });
  });
});
