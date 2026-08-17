// Integration test: real Fastify app + real WebSocket server + a scripted
// mock AgentSession adopted into the bridge. Verifies the wire contract the
// kimi-web front end depends on: REST envelope, WS sync protocol, event
// translation fan-out, snapshot shape and the approval round-trip.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { PiBridge } from '../src/bridge.ts';
import { buildApp } from '../src/routes.ts';
import { attachWebSocket } from '../src/ws.ts';
import WebSocket from 'ws';

type Emit = (event: AgentSessionEvent) => void;

class MockAgentSession {
  sessionId: string;
  isStreaming = false;
  messages: unknown[] = [];
  thinkingLevel = 'medium';
  model = { provider: 'mock', id: 'mock-1', contextWindow: 100_000 };
  sessionName: string | undefined;
  listener?: Emit;
  promptCalls: string[] = [];
  aborted = false;
  setModelCalls: string[] = [];
  agent = { state: { streamingMessage: undefined }, beforeToolCall: undefined as unknown };

  constructor(id: string) {
    this.sessionId = id;
  }
  subscribe(listener: Emit): () => void {
    this.listener = listener;
    return () => undefined;
  }
  emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }
  async prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
  }
  async steer(): Promise<void> {}
  async abort(): Promise<void> {
    this.aborted = true;
  }
  async setModel(model: { id: string }): Promise<void> {
    this.setModelCalls.push(model.id);
  }
  setThinkingLevel(): void {}
  setSessionName(name: string): void {
    this.sessionName = name;
  }
  async compact(): Promise<unknown> {
    return {};
  }
  getSessionStats() {
    return {
      sessionFile: undefined,
      sessionId: this.sessionId,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 1,
      toolResults: 1,
      totalMessages: 3,
      tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
      cost: 0.25,
      contextUsage: { tokens: 200, contextWindow: 100_000, percent: 0.2 },
    };
  }
  get cwd(): string {
    return process.cwd();
  }
}

const mock = new MockAgentSession('mock-session-1');

let bridge: PiBridge;
let baseUrl: string;
let wsUrl: string;
let token: string;
const cleanupFns: (() => Promise<void>)[] = [];

process.env['PI_CODE_HOME'] = '/tmp/pi-code-test-home';

beforeAll(async () => {
  const { mkdirSync, rmSync } = await import('node:fs');
  try {
    rmSync('/tmp/pi-code-test-home', { recursive: true });
  } catch {
    // ignore
  }
  mkdirSync('/tmp/pi-code-test-home', { recursive: true });
  bridge = new PiBridge({ workspaceRoot: process.cwd(), approvalPolicy: 'all' });
  await bridge.init();
  bridge.adoptSession(mock as never, undefined, process.cwd());

  token = 'test-token-123';
  const app = buildApp({ bridge, token, bypassAuth: false, workspaceRoots: new Set([process.cwd()]) });
  attachWebSocket(app, bridge, token, false);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}/api/v1/ws`;
  cleanupFns.push(async () => {
    app.server.closeAllConnections?.();
    await app.close();
  });
});

afterAll(async () => {
  for (const fn of cleanupFns) await fn();
});

function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}/api/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function connectWs(): Promise<{ ws: WebSocket; frames: unknown[]; wait: (type: string, timeoutMs?: number) => Promise<any> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, ['kimi-code.bearer.' + token]);
    const frames: unknown[] = [];
    ws.on('error', reject);
    ws.on('open', () => {
      resolve({
        ws,
        frames,
        wait: (type: string, timeoutMs = 3000) =>
          new Promise((res, rej) => {
            const started = Date.now();
            const check = () => {
              const hits = frames.filter((f) => (f as { type?: string }).type === type);
              if (hits.length > 0) return res(hits[hits.length - 1]);
              if (Date.now() - started > timeoutMs) return rej(new Error(`timeout waiting for ${type}; got ${frames.map((f) => (f as { type: string }).type).join(',')}`));
              setTimeout(check, 25);
            };
            check();
          }),
      });
    });
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  });
}

describe('REST wire contract', () => {
  it('healthz responds without auth', async () => {
    const res = await fetch(`${baseUrl}/api/v1/healthz`);
    const body = (await res.json()) as { code: number; data: { ok: boolean } };
    expect(res.status).toBe(200);
    expect(body.code).toBe(0);
    expect(body.data.ok).toBe(true);
  });

  it('rejects missing bearer token with 401 + 40101', async () => {
    const res = await fetch(`${baseUrl}/api/v1/meta`);
    const body = (await res.json()) as { code: number };
    expect(res.status).toBe(401);
    expect(body.code).toBe(40101);
  });

  it('meta reports v2 backend', async () => {
    const res = await api('/meta');
    const body = (await res.json()) as { data: { backend: string; server_id: string } };
    expect(body.data.backend).toBe('v2');
    expect(body.data.server_id).toBeTruthy();
  });

  it('lists the adopted session with usage and model', async () => {
    const res = await api('/sessions');
    const body = (await res.json()) as { data: { items: { id: string; usage: { input_tokens: number }; agent_config: { model: string } }[] } };
    const item = body.data.items.find((i) => i.id === 'mock-session-1');
    expect(item).toBeDefined();
    expect(item!.usage.input_tokens).toBe(100);
    expect(item!.agent_config.model).toBe('mock/mock-1');
  });

  it('snapshot carries session/messages/approvals with seq+epoch', async () => {
    const res = await api('/sessions/mock-session-1/snapshot');
    const body = (await res.json()) as { data: { as_of_seq: number; epoch: string; session: unknown; messages: unknown; pending_approvals: unknown[]; in_flight_turn: unknown } };
    expect(body.data.as_of_seq).toBeGreaterThan(0);
    expect(typeof body.data.epoch).toBe('string');
    expect(body.data.pending_approvals).toEqual([]);
  });

  it('status reports model and context usage', async () => {
    const res = await api('/sessions/mock-session-1/status');
    const body = (await res.json()) as { data: { model: string; context_tokens: number; max_context_tokens: number } };
    expect(body.data.model).toBe('mock/mock-1');
    expect(body.data.context_tokens).toBe(200);
    expect(body.data.max_context_tokens).toBe(100_000);
  });

  it('404s unknown sessions with code 40401', async () => {
    const res = await api('/sessions/does-not-exist');
    const body = (await res.json()) as { code: number };
    expect(res.status).toBe(404);
    expect(body.code).toBe(40401);
  });

  it('degraded kimi endpoints return empty shapes', async () => {
    for (const path of ['/sessions/mock-session-1/goal', '/sessions/mock-session-1/tasks', '/sessions/mock-session-1/children']) {
      const res = await api(path);
      const body = (await res.json()) as { code: number; data: unknown };
      expect(body.code).toBe(0);
    }
  });

  it('profile rename round-trips and rejects unknown models', async () => {
    const res = await api('/sessions/mock-session-1/profile', {
      method: 'POST',
      body: JSON.stringify({ title: 'Renamed' }),
    });
    const body = (await res.json()) as { data: { title: string } };
    expect(body.data.title).toBe('Renamed');

    const bad = await api('/sessions/mock-session-1/profile', {
      method: 'POST',
      body: JSON.stringify({ agent_config: { model: 'no/such-model' } }),
    });
    expect(bad.status).toBe(400);
  });

  it('fs endpoints serve real directory listings', async () => {
    const res = await api('/sessions/mock-session-1/fs:list', { method: 'POST', body: JSON.stringify({ path: 'src' }) });
    const body = (await res.json()) as { data: { items: { name: string }[] } };
    expect(body.data.items.some((i) => i.name === 'bridge.ts')).toBe(true);
  });
});

describe('WS sync protocol', () => {
  it('handshake, subscribe with replay, live fan-out, resync on stale epoch', async () => {
    const { ws, wait, frames } = await connectWs();
    cleanupFns.push(async () => {
      try { ws.close(); } catch {}
    });
    const hello = await wait('server_hello');
    expect(hello.payload.capabilities).toBeDefined();

    ws.send(JSON.stringify({ type: 'client_hello', id: 'c1', payload: { client_id: 't', subscriptions: ['mock-session-1'], cursors: {} } }));
    const ack = await wait('ack');
    expect(ack.id).toBe('c1');

    // Replay: the session.created + approval work_changed frames emitted before
    // subscribing come back with seq ordering.
    await wait('event.session.created');

    // Live: a pi event fans out as translated raw agent-core frames.
    mock.emit({ type: 'agent_start' } as never);
    const turnStarted = await wait('turn.started');
    expect(turnStarted.payload.turnId).toBeGreaterThan(0);
    expect(turnStarted.session_id).toBe('mock-session-1');
    expect(typeof turnStarted.seq).toBe('number');

    mock.emit({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi ', partial: {} },
    } as never);
    mock.emit({
      type: 'message_update',
      message: { role: 'assistant' },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'there', partial: {} },
    } as never);
    await wait('assistant.delta');
    const deltas = frames.filter((f) => (f as { type?: string }).type === 'assistant.delta');
    expect(deltas.map((f) => (f as { payload: { delta: string } }).payload.delta)).toEqual(['hi ', 'there']);

    mock.emit({
      type: 'tool_execution_start',
      toolCallId: 'tc-live',
      toolName: 'bash',
      args: { command: 'echo x' },
    } as never);
    const toolStarted = await wait('tool.call.started');
    expect(toolStarted.payload.name).toBe('bash');

    // Stale epoch cursor → resync_required.
    ws.send(JSON.stringify({
      type: 'subscribe',
      id: 'c2',
      payload: { session_ids: ['mock-session-1'], cursors: { 'mock-session-1': { seq: 1, epoch: 'ep_stale' } } },
    }));
    const resync = await wait('resync_required');
    expect(resync.payload.reason).toBe('epoch_changed');
    expect(resync.payload.current_seq).toBeGreaterThan(0);
    ws.close();
  });

  it('streams a full prompt turn and the approval round-trip', async () => {
    const { ws, wait } = await connectWs();
    cleanupFns.push(async () => {
      try { ws.close(); } catch {}
    });
    ws.send(JSON.stringify({ type: 'client_hello', id: 'c1', payload: { client_id: 't', subscriptions: ['mock-session-1'], cursors: {} } }));
    await wait('ack');

    // Mock the tool execution: when the approval gate approves, the loop
    // continues with tool result + assistant completion.
    const submitted = await api('/sessions/mock-session-1/prompts', {
      method: 'POST',
      body: JSON.stringify({ content: [{ type: 'text', text: 'run a command' }] }),
    });
    const submitBody = (await submitted.json()) as { data: { prompt_id: string; user_message_id: string; status: string } };
    expect(submitBody.data.status).toBe('running');
    expect(mock.promptCalls).toContain('run a command');

    const promptSubmitted = await wait('prompt.submitted');
    expect(promptSubmitted.payload.promptId).toBe(submitBody.data.prompt_id);

    mock.emit({ type: 'agent_start' } as never);
    await wait('turn.started');
    mock.emit({
      type: 'tool_execution_start',
      toolCallId: 'tc-approval',
      toolName: 'bash',
      args: { command: 'echo approved-flow' },
    } as never);

    // Approval policy 'all' gates the bash call. The real agent loop invokes
    // beforeToolCall before tool execution; simulate that call here — the
    // bridge-installed gate parks it and broadcasts event.approval.requested.
    const gate = mock.agent.beforeToolCall as (ctx: unknown) => Promise<unknown>;
    const gatePromise = gate({ toolCall: { id: 'tc-approval', name: 'bash' }, args: { command: 'echo approved-flow' } });

    const approval = await wait('event.approval.requested');
    expect(approval.payload.tool_name).toBe('bash');
    expect(approval.payload.action).toBe('echo approved-flow');

    const approvalId = approval.payload.approval_id as string;
    const resolved = await api(`/sessions/mock-session-1/approvals/${approvalId}`, {
      method: 'POST',
      body: JSON.stringify({ decision: 'approved' }),
    });
    expect(((await resolved.json()) as { code: number }).code).toBe(0);
    await wait('event.approval.resolved');
    // The approved gate resolves without a block decision.
    expect(await gatePromise).toBeUndefined();

    mock.emit({
      type: 'tool_execution_end',
      toolCallId: 'tc-approval',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'approved-flow' }] },
      isError: false,
    } as never);
    const toolResult = await wait('tool.result');
    expect(toolResult.payload.output).toBe('approved-flow');

    mock.emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 }, stopReason: 'stop', timestamp: Date.now() },
    } as never);
    mock.emit({ type: 'agent_end', messages: [], willRetry: false } as never);
    const turnEnded = await wait('turn.ended');
    expect(turnEnded.payload.reason).toBe('completed');
    const promptCompleted = await wait('prompt.completed');
    expect(promptCompleted.payload.promptId).toBe(submitBody.data.prompt_id);
    const workChanged = await wait('event.session.work_changed');
    expect(workChanged.payload.busy).toBe(false);
    ws.close();
  });
});
