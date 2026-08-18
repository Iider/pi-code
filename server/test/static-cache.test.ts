import { describe, expect, it } from 'vitest';
import { cacheControlForWebAsset } from '../src/static-cache.ts';

describe('cacheControlForWebAsset', () => {
  it('caches fingerprinted asset files immutably', () => {
    expect(cacheControlForWebAsset('/app/webui/assets/index-CgXirkUy.js'))
      .toBe('public, max-age=31536000, immutable');
    expect(cacheControlForWebAsset('C:\\app\\webui\\assets\\index-BkulrdXm.css'))
      .toBe('public, max-age=31536000, immutable');
  });

  it('revalidates mutable entry and adapter files', () => {
    expect(cacheControlForWebAsset('/app/webui/index.html')).toBe('no-cache');
    expect(cacheControlForWebAsset('/app/webui/boot.js')).toBe('no-cache');
    expect(cacheControlForWebAsset('/app/webui/model-config.js')).toBe('no-cache');
    expect(cacheControlForWebAsset('/app/webui/assets/runtime-config.json')).toBe('no-cache');
  });
});
