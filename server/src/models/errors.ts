const SECRET_KEYS = /(?:api[-_]?key|authorization|token|secret|password|credential|header)/i;
const SECRET_ASSIGNMENT = /((?:api[-_ ]?key|authorization|token|secret|password|credential)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const SECRET_QUERY = /([?&](?:api[-_]?key|access[-_]?token|token|key)=)[^&#\s]+/gi;
const SECRET_VALUE = /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{6,}|\b(?:sk|key)[-_][a-z0-9._~+/=-]{6,}/gi;
export const CONFIGURED_SECRET = '[configured]';

export class ConfigurationError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(redactText(message));
  }
}

export function redactText(value: string): string {
  return value
    .replace(SECRET_QUERY, '$1[redacted]')
    .replace(SECRET_VALUE, '[redacted]')
    .replace(SECRET_ASSIGNMENT, '$1[redacted]');
}

export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactConfig);
  if (!value || typeof value !== 'object') {
    if (typeof value !== 'string') return value;
    return redactText(value) === value ? value : CONFIGURED_SECRET;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SECRET_KEYS.test(key) ? CONFIGURED_SECRET : redactConfig(child),
    ]),
  );
}

export function restoreConfiguredSecrets(redacted: unknown, original: unknown): unknown {
  if (redacted === CONFIGURED_SECRET && original !== undefined) return structuredClone(original);
  if (Array.isArray(redacted)) {
    const source = Array.isArray(original) ? original : [];
    return redacted.map((item, index) => restoreConfiguredSecrets(item, source[index]));
  }
  if (!redacted || typeof redacted !== 'object') return redacted;
  const source = original && typeof original === 'object' && !Array.isArray(original)
    ? original as Record<string, unknown>
    : {};
  return Object.fromEntries(
    Object.entries(redacted as Record<string, unknown>)
      .map(([key, child]) => [key, restoreConfiguredSecrets(child, source[key])]),
  );
}
