// pi-code server entry: serves the kimi-web front end (built with Vite) and
// the /api/v1 bridge on one origin, kimi `web` style.

import { existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fastifyStatic from '@fastify/static';
import { PiBridge } from './bridge.ts';
import { buildApp } from './routes.ts';
import { attachWebSocket } from './ws.ts';
import { loadOrCreateToken } from './token.ts';
import type { ApprovalPolicy } from './approvals.ts';

const args = process.argv.slice(2);
function argValue(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1]!;
  const prefix = `--${name}=`;
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const here = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const port = Number(argValue('port') ?? 8765);
  const workspaceRoot = resolve(argValue('workspace') ?? process.cwd());
  const approvalPolicy: ApprovalPolicy = (argValue('approvals') as ApprovalPolicy) ?? 'dangerous';
  const bypassAuth = hasFlag('dangerous-bypass-auth') || process.env['PI_CODE_BYPASS_AUTH'] === '1';
  const noOpen = hasFlag('no-open');
  const webDist = resolve(argValue('web-dist') ?? join(here, '..', '..', 'webapp', 'dist'));

  const bridge = new PiBridge({ workspaceRoot, approvalPolicy });
  await bridge.init();

  const token = bypassAuth ? '' : loadOrCreateToken();

  const app = buildApp({
    bridge,
    token,
    bypassAuth,
    workspaceRoots: new Set([workspaceRoot]),
  });

  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => {
      if ((request.raw.url ?? '').startsWith('/api/')) {
        reply.statusCode = 404;
        await reply.send({ code: 40400, msg: 'Not found', data: null, request_id: 'static' });
        return;
      }
      await reply.sendFile('index.html');
    });
  } else {
    console.warn(`[pi-code] webapp dist not found at ${webDist} — serving API only.`);
    console.warn('[pi-code] build the front end with:  cd webapp && npm install && npm run build');
  }

  attachWebSocket(app, bridge, token, bypassAuth);

  await app.listen({ port, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${port}`;
  const authedUrl = bypassAuth ? url : `${url}/#token=${token}`;
  console.log(`[pi-code] workspace: ${workspaceRoot}`);
  console.log(`[pi-code] approval policy: ${approvalPolicy}`);
  console.log(`[pi-code] listening on ${url}`);
  console.log(`[pi-code] open ${bypassAuth ? url : `${url}/  (token appended automatically when opening)`}`);

  if (!noOpen) {
    openBrowser(authedUrl);
  }

  // Desktop mode: exit when the Tauri shell dies, so a force-quit never
  // leaves an orphaned server holding a port.
  if (process.env['PI_CODE_DESKTOP'] === '1') {
    const parentPid = process.ppid;
    setInterval(() => {
      try {
        process.kill(parentPid!, 0);
      } catch {
        process.exit(0);
      }
    }, 2000).unref();
  }
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const command =
    platform === 'darwin' ? ['open', url] : platform === 'win32' ? ['cmd', '/c', 'start', '', url] : ['xdg-open', url];
  try {
    spawn(command[0]!, command.slice(1), { detached: true, stdio: 'ignore' }).unref();
  } catch {
    console.log(`[pi-code] open manually: ${url}`);
  }
}

main().catch((error) => {
  console.error('[pi-code] fatal:', error);
  process.exit(1);
});
