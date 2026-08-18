import { describe, expect, it } from 'vitest';
import { redactText } from '../src/models/errors.ts';

describe('model configuration error redaction', () => {
  it('redacts common credential forms without hiding the surrounding error', () => {
    const message = 'request failed: api_key=plain-secret-value&mode=test Authorization: Bearer bearer-secret-value';
    const redacted = redactText(message);
    expect(redacted).toContain('request failed');
    expect(redacted).not.toContain('plain-secret-value');
    expect(redacted).not.toContain('bearer-secret-value');
  });
});
