// WebSocket layer: implements kimi-web's WS control protocol on top of the
// bridge's per-session frame stream.
//
//   S→C  server_hello | ping | ack | resync_required | event frames
//   C→S  client_hello | subscribe | unsubscribe | abort | pong | terminal_*
//
// Sync model: every event frame carries a per-session `seq` and the server
// `epoch`. Clients resume from a {seq, epoch} cursor; on epoch mismatch or a
// replay gap the server answers resync_required and the client reloads via
// the snapshot endpoint.

import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import type { PiBridge } from './bridge.ts';
import { checkToken, tokenFromSubprotocols } from './token.ts';
import type { EventFrame } from './wire.ts';

const WS_PROTOCOL_PREFIX = 'kimi-code.bearer.';
const PING_INTERVAL_MS = 25_000;

interface ClientState {
  socket: WebSocket;
  subscriptions: Map<string, number>; // sessionId → last sent seq
}

export function attachWebSocket(app: FastifyInstance, bridge: PiBridge, token: string, bypassAuth: boolean): void {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<ClientState>();

  app.server.on('upgrade', (request, socket, head) => {
    const url = request.url ?? '';
    if (!url.startsWith('/api/v1/ws')) return; // let other upgrades fail naturally
    const protocols = (request.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
    const presented = tokenFromSubprotocols(protocols);
    if (!bypassAuth && !checkToken(presented, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (socket: WebSocket) => {
    const client: ClientState = { socket, subscriptions: new Map() };
    clients.add(client);

    send(socket, {
      type: 'server_hello',
      timestamp: new Date().toISOString(),
      payload: {
        server_id: bridge.serverId,
        heartbeat_ms: PING_INTERVAL_MS,
        max_event_buffer_size: 512,
        capabilities: { event_batching: false, compression: false },
      },
    });

    socket.on('message', (raw: unknown) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        return;
      }
      handleMessage(client, message).catch(() => undefined);
    });

    socket.on('close', () => {
      clients.delete(client);
    });
    socket.on('error', () => {
      clients.delete(client);
    });
  });

  const pingTimer = setInterval(() => {
    for (const client of clients) {
      if (client.socket.readyState === 1) {
        send(client.socket, { type: 'ping', timestamp: new Date().toISOString(), payload: { nonce: String(Date.now()) } });
      }
    }
  }, PING_INTERVAL_MS);
  pingTimer.unref?.();

  // Fan out bridge frames to subscribed clients.
  bridge.onFrame((sessionId, frame) => {
    for (const client of clients) {
      const lastSeq = client.subscriptions.get(sessionId);
      if (lastSeq === undefined) continue;
      if (frame.seq <= lastSeq) continue;
      if (client.socket.readyState !== 1) continue;
      client.subscriptions.set(sessionId, frame.seq);
      send(client.socket, frame);
    }
  });

  async function handleMessage(client: ClientState, message: Record<string, unknown>): Promise<void> {
    const type = typeof message['type'] === 'string' ? (message['type'] as string) : '';
    const id = typeof message['id'] === 'string' ? (message['id'] as string) : '';
    const payload = (message['payload'] ?? {}) as Record<string, unknown>;

    switch (type) {
      case 'client_hello':
      case 'subscribe': {
        const sessionIds = extractSessionIds(payload);
        const cursors = (payload['cursors'] ?? {}) as Record<string, { seq?: number; epoch?: string }>;
        for (const sessionId of sessionIds) {
          await subscribeClient(client, sessionId, cursors[sessionId]);
        }
        ack(client.socket, id, { subscribed: sessionIds });
        break;
      }
      case 'unsubscribe': {
        const sessionIds = extractSessionIds(payload);
        for (const sessionId of sessionIds) client.subscriptions.delete(sessionId);
        ack(client.socket, id, { unsubscribed: sessionIds });
        break;
      }
      case 'abort': {
        const sessionId = typeof payload['session_id'] === 'string' ? (payload['session_id'] as string) : '';
        if (sessionId) await bridge.abortSession(sessionId);
        ack(client.socket, id, { aborted: true });
        break;
      }
      case 'pong':
        // Nothing to do — the client answered our ping.
        break;
      case 'terminal_attach':
      case 'terminal_input':
      case 'terminal_resize':
      case 'terminal_detach':
      case 'terminal_close':
      case 'watch_fs_add':
      case 'watch_fs_remove':
        ack(client.socket, id, {});
        break;
      default:
        ack(client.socket, id, { ignored: type });
        break;
    }
  }

  async function subscribeClient(
    client: ClientState,
    sessionId: string,
    cursor: { seq?: number; epoch?: string } | undefined,
  ): Promise<void> {
    const entry = await bridge.openSession(sessionId).catch(() => undefined);
    if (!entry) {
      send(client.socket, {
        type: 'error',
        timestamp: new Date().toISOString(),
        payload: { code: 40401, msg: `Session not found: ${sessionId}`, fatal: false },
      });
      return;
    }

    const cursorSeq = cursor?.seq ?? 0;
    const cursorEpoch = cursor?.epoch;

    if (cursorSeq > 0 && cursorEpoch !== undefined && cursorEpoch !== bridge.epoch) {
      // Stale cursor from a previous server instance — force a snapshot reload.
      client.subscriptions.set(sessionId, entry.seq);
      send(client.socket, {
        type: 'resync_required',
        timestamp: new Date().toISOString(),
        payload: { session_id: sessionId, reason: 'epoch_changed', current_seq: entry.seq, epoch: bridge.epoch },
      });
      return;
    }

    // Replay buffered frames newer than the cursor.
    const replay = entry.ring.filter((frame) => frame.seq > cursorSeq);
    const oldest = entry.ring.length > 0 ? entry.ring[0] : undefined;
    if (cursorSeq > 0 && replay.length === 0 && oldest !== undefined && cursorSeq < oldest.seq && entry.seq > cursorSeq) {
      client.subscriptions.set(sessionId, entry.seq);
      send(client.socket, {
        type: 'resync_required',
        timestamp: new Date().toISOString(),
        payload: { session_id: sessionId, reason: 'buffer_overflow', current_seq: entry.seq, epoch: bridge.epoch },
      });
      return;
    }

    let last = cursorSeq;
    for (const frame of replay) {
      send(client.socket, frame);
      last = frame.seq;
    }
    client.subscriptions.set(sessionId, Math.max(last, cursorSeq));
  }
}

function extractSessionIds(payload: Record<string, unknown>): string[] {
  const raw = payload['session_ids'] ?? payload['subscriptions'];
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string');
  return [];
}

function send(socket: WebSocket, frame: unknown): void {
  if (socket.readyState !== 1) return;
  try {
    socket.send(JSON.stringify(frame));
  } catch {
    // Socket closed mid-send.
  }
}

function ack(socket: WebSocket, id: string, payload: unknown): void {
  send(socket, { type: 'ack', id, code: 0, msg: 'ok', payload });
}

export { WS_PROTOCOL_PREFIX };
