// Persistent bearer token, mirroring kap-server's scheme: a 32-byte random
// token stored 0600 under the server home dir, reused across restarts so
// browsers that cached it keep working.

import { readFileSync, writeFileSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export function serverHomeDir(): string {
  return process.env['PI_CODE_HOME'] ?? join(homedir(), '.pi-code');
}

export function loadOrCreateToken(): string {
  if (process.env['PI_CODE_TOKEN']) return process.env['PI_CODE_TOKEN'];
  const dir = serverHomeDir();
  const file = join(dir, 'server.token');
  if (existsSync(file)) {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return existing;
  }
  const token = randomBytes(32).toString('base64url');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, token + '\n', { mode: 0o600, flag: 'w' });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows and some filesystems reject chmod — best effort.
  }
  return token;
}

export function checkToken(presented: string | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the bearer credential from a WebSocket subprotocol header value. */
export function tokenFromSubprotocols(protocols: string[] | undefined): string | undefined {
  if (!protocols) return undefined;
  for (const p of protocols) {
    if (p.startsWith('kimi-code.bearer.')) return p.slice('kimi-code.bearer.'.length);
  }
  return undefined;
}
