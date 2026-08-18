// Wire envelope + error codes, mirroring kimi-code's packages/protocol shapes
// so the kimi-web front end can talk to this server unmodified.

export interface Envelope<T> {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
}

export const ErrorCodes = {
  OK: 0,
  VALIDATION: 40001,
  UNAUTHORIZED: 40101,
  SESSION_NOT_FOUND: 40401,
  MESSAGE_NOT_FOUND: 40402,
  APPROVAL_NOT_FOUND: 40403,
  QUESTION_NOT_FOUND: 40404,
  NOT_IMPLEMENTED: 40411,
  PROMPT_NOT_FOUND: 40903,
  SESSION_BUSY: 40904,
  CONFIG_CHANGED: 40910,
  CREDENTIAL_CHANGED: 40911,
  PROVIDER_INTERACTION_REQUIRED: 42201,
  PROVIDER_UNSUPPORTED: 42202,
  UPSTREAM: 50201,
  INTERNAL: 50000,
} as const;

export function ok<T>(data: T, requestId: string): Envelope<T> {
  return { code: 0, msg: 'ok', data, request_id: requestId };
}

export function fail(code: number, msg: string, requestId: string): Envelope<null> {
  return { code, msg, data: null, request_id: requestId };
}

let requestCounter = 0;

export function newRequestId(): string {
  const t = Date.now().toString(36);
  const r = (++requestCounter).toString(36).padStart(4, '0');
  const rand = Math.random().toString(36).slice(2, 8);
  return `req_${t}${r}${rand}`;
}

/** Sortable unique id with a prefix, same style the web client generates. */
export function newId(prefix: string): string {
  const t = Date.now().toString(36).padStart(10, '0');
  const rand = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `${prefix}${t}${rand}`;
}
