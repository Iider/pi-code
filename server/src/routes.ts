// REST layer: implements the /api/v1 subset the kimi-web front end consumes,
// backed by PiBridge. Missing kimi features degrade to empty/501-style data.

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename, extname, relative, isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { PiBridge, workspaceIdFor, workspaceName, SessionNotFoundError } from './bridge.ts';
import { ErrorCodes, fail, newRequestId, ok } from './envelope.ts';
import { checkToken } from './token.ts';
import { ModelConfigurationService } from './models/configuration-service.ts';
import { ConfigurationError, redactText } from './models/errors.ts';

interface RouteContext {
  bridge: PiBridge;
  token: string;
  bypassAuth: boolean;
  workspaceRoots: Set<string>;
  modelConfiguration?: ModelConfigurationService;
}

/** Split "/sessions/<id>:<action>" style segments. */
function splitAction(raw: string): { id: string; action?: string } {
  const idx = raw.indexOf(':');
  if (idx === -1) return { id: raw };
  return { id: raw.slice(0, idx), action: raw.slice(idx + 1) };
}

function encodeId(id: string): string {
  return encodeURIComponent(id).replaceAll('%3A', ':');
}

async function sendOk(reply: FastifyReply, data: unknown, requestId: string): Promise<void> {
  return reply.send(ok(data, requestId));
}

export function buildApp(ctx: RouteContext): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024 });
  const { bridge } = ctx;
  const modelConfiguration = ctx.modelConfiguration ?? new ModelConfigurationService(bridge.getModelRuntime());

  app.setErrorHandler(async (error, _request, reply) => {
    const requestId = newRequestId();
    if (error instanceof ConfigurationError) {
      reply.statusCode = error.status;
      await reply.send(fail(error.code, error.message, requestId));
      return;
    }
    const fastifyError = error as { statusCode?: unknown; message?: unknown };
    const status = typeof fastifyError.statusCode === 'number'
      && fastifyError.statusCode >= 400
      && fastifyError.statusCode < 500
      ? fastifyError.statusCode
      : 500;
    reply.statusCode = status;
    const code = status === 401
      ? ErrorCodes.UNAUTHORIZED
      : status < 500 ? ErrorCodes.VALIDATION : ErrorCodes.INTERNAL;
    const message = status < 500 ? redactText(String(fastifyError.message ?? 'Bad request')) : 'Internal server error';
    await reply.send(fail(code, message, requestId));
  });

  // --- auth hook -----------------------------------------------------------
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url ?? '';
    if (
      ctx.bypassAuth ||
      request.method === 'OPTIONS' ||
      url === '/api/v1/healthz' ||
      !url.startsWith('/api/')
    ) {
      return;
    }
    const header = request.headers['authorization'];
    const presented = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!checkToken(presented, ctx.token)) {
      reply.statusCode = 401;
      await reply.send(fail(ErrorCodes.UNAUTHORIZED, 'Missing or invalid bearer token', newRequestId()));
    }
  });

  // --- helpers -------------------------------------------------------------
  const wireWorkspace = (root: string) => ({
    id: workspaceIdFor(root),
    root,
    name: workspaceName(root),
    session_count: 0,
  });

  // --- health / meta -------------------------------------------------------
  app.get('/api/v1/healthz', async (_req, reply) => {
    await sendOk(reply, { ok: true, uptime_sec: Math.floor(process.uptime()) }, newRequestId());
  });

  app.get('/api/v1/meta', async (_req, reply) => {
    await sendOk(
      reply,
      {
        server_version: bridge.version,
        server_id: bridge.serverId,
        started_at: bridge.startedAt,
        capabilities: {},
        open_in_apps: [],
        dangerous_bypass_auth: ctx.bypassAuth,
        backend: 'v2',
      },
      newRequestId(),
    );
  });

  app.get('/api/v1/auth', async (_req, reply) => {
    const auth = await modelConfiguration.authStatus();
    await sendOk(reply, { ready: auth.ready, providers_count: auth.providers_count, default_model: auth.default_model, managed_provider: null }, newRequestId());
  });

  // --- oauth ---------------------------------------------------------------
  app.post('/api/v1/oauth/login', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as { provider?: string };
    if (!body.provider) throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'provider is required');
    await sendOk(reply, modelConfiguration.startOAuth(body.provider), newRequestId());
  });
  app.get('/api/v1/oauth/login', async (req, reply) => {
    const { flow_id } = req.query as { flow_id?: string };
    if (!flow_id) throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'flow_id is required');
    await sendOk(reply, modelConfiguration.getOAuth(flow_id), newRequestId());
  });
  app.post('/api/v1/oauth/login/:id/respond', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { prompt_id?: string; value?: string };
    if (!body.prompt_id || typeof body.value !== 'string') throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'prompt_id and value are required');
    await sendOk(reply, modelConfiguration.answerOAuth(id, body.prompt_id, body.value), newRequestId());
  });
  app.delete('/api/v1/oauth/login', async (req, reply) => {
    const { flow_id } = req.query as { flow_id?: string };
    if (!flow_id) throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'flow_id is required');
    await sendOk(reply, modelConfiguration.cancelOAuth(flow_id), newRequestId());
  });
  app.post('/api/v1/oauth/logout', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as { provider?: string };
    if (!body.provider) throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'provider is required');
    await sendOk(reply, await modelConfiguration.logout(body.provider, 'oauth'), newRequestId());
  });

  // --- models / providers / config -----------------------------------------
  app.get('/api/v1/models', async (_req, reply) => {
    await sendOk(reply, { items: await modelConfiguration.models() }, newRequestId());
  });

  app.get('/api/v1/providers', async (_req, reply) => {
    await sendOk(reply, { items: await modelConfiguration.providers() }, newRequestId());
  });

  app.post('/api/v1/providers', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    await sendOk(reply, await modelConfiguration.addProvider((req.body ?? {}) as never), newRequestId());
  });

  app.get('/api/v1/providers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await sendOk(reply, await modelConfiguration.provider(id), newRequestId());
  });

  app.put('/api/v1/providers/:id', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await sendOk(reply, await modelConfiguration.updateProvider(id, (req.body ?? {}) as never), newRequestId());
  });

  app.delete('/api/v1/providers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await sendOk(reply, await modelConfiguration.deleteProvider(id), newRequestId());
  });

  app.get('/api/v1/catalog/providers', async (_req, reply) => {
    await sendOk(reply, { items: modelConfiguration.catalogProviders() }, newRequestId());
  });

  app.get('/api/v1/catalog/providers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    await sendOk(reply, modelConfiguration.catalogProvider(id), newRequestId());
  });

  app.post('/api/v1/providers::import_catalog', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    await sendOk(reply, await modelConfiguration.importCatalogProvider((req.body ?? {}) as never), newRequestId());
  });

  app.post('/api/v1/providers/:idAction', async (req, reply) => {
    const { id, action } = splitAction((req.params as { idAction: string }).idAction);
    if (action !== 'refresh') throw new ConfigurationError(404, ErrorCodes.NOT_IMPLEMENTED, 'Unsupported provider action');
    await sendOk(reply, await modelConfiguration.refresh([id]), newRequestId());
  });
  app.post('/api/v1/providers::refresh', async (_req, reply) => {
    await sendOk(reply, await modelConfiguration.refresh(), newRequestId());
  });
  app.post('/api/v1/providers::refresh_oauth', async (_req, reply) => {
    await sendOk(reply, await modelConfiguration.refresh(), newRequestId());
  });

  app.get('/api/v1/config', async (_req, reply) => {
    await sendOk(reply, await modelConfiguration.config(), newRequestId());
  });

  app.post('/api/v1/config', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    await sendOk(reply, await modelConfiguration.updateConfig((req.body ?? {}) as Record<string, unknown>), newRequestId());
  });

  app.get('/api/v1/models-config', async (_req, reply) => {
    await sendOk(reply, await modelConfiguration.store.read(), newRequestId());
  });
  app.put('/api/v1/models-config', { bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const body = (req.body ?? {}) as { document?: unknown; revision?: string };
    if (typeof body.revision !== 'string' || !body.revision) throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'revision is required');
    await sendOk(reply, await modelConfiguration.saveModelsConfig(body.document, body.revision), newRequestId());
  });
  app.delete('/api/v1/models-config/providers/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { revision } = req.query as { revision?: string };
    if (!revision) throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'revision is required');
    await sendOk(reply, await modelConfiguration.deleteCustomProvider(id, revision), newRequestId());
  });
  app.post('/api/v1/models-config::discover', async (req, reply) => {
    const body = (req.body ?? {}) as { provider?: string };
    await sendOk(reply, await modelConfiguration.refresh(body.provider ? [body.provider] : undefined), newRequestId());
  });
  app.post('/api/v1/models-config::test', { bodyLimit: 32 * 1024 }, async (req, reply) => {
    await sendOk(reply, await modelConfiguration.testModel((req.body ?? {}) as never), newRequestId());
  });

  // --- workspaces -----------------------------------------------------------
  app.get('/api/v1/workspaces', async (_req, reply) => {
    const sessions = await bridge.listSessions();
    const counts = new Map<string, number>();
    for (const s of sessions) counts.set(s.cwd, (counts.get(s.cwd) ?? 0) + 1);
    const roots = new Set<string>([...ctx.workspaceRoots, ...sessions.map((s) => s.cwd)]);
    await sendOk(
      reply,
      { items: [...roots].map((root) => ({ ...wireWorkspace(root), session_count: counts.get(root) ?? 0 })), has_more: false },
      newRequestId(),
    );
  });

  app.post('/api/v1/workspaces', async (req, reply) => {
    const body = (req.body ?? {}) as { root?: string };
    const root = body.root && isAbsolute(body.root) ? resolve(body.root) : ctx.workspaceRoots.values().next().value!;
    if (!existsSync(root)) {
      reply.statusCode = 400;
      await reply.send(fail(ErrorCodes.VALIDATION, `Directory does not exist: ${root}`, newRequestId()));
      return;
    }
    ctx.workspaceRoots.add(root);
    await sendOk(reply, wireWorkspace(root), newRequestId());
  });

  app.patch('/api/v1/workspaces/:id', async (req, reply) => {
    const body = (req.body ?? {}) as { name?: string };
    await sendOk(reply, { ...(body.name ? { name: body.name } : {}) }, newRequestId());
  });

  app.delete('/api/v1/workspaces/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    for (const root of [...ctx.workspaceRoots]) {
      if (workspaceIdFor(root) === id) ctx.workspaceRoots.delete(root);
    }
    reply.statusCode = 204;
    await reply.send();
  });

  app.post('/api/v1/workspaces/:id/trust', async (_req, reply) => sendOk(reply, { trusted: true }, newRequestId()));
  app.post('/api/v1/workspaces/:id/untrust', async (_req, reply) => sendOk(reply, { trusted: false }, newRequestId()));

  // --- fs browse ------------------------------------------------------------
  // find-my-way splits static/param at the first ':' in a segment, so source
  // paths carry a DOUBLE colon and are served on the wire as single-colon
  // URLs — byte-for-byte the kimi-web contract (same trick as kap-server).
  app.get('/api/v1/fs::browse', async (req, reply) => {
    const query = req.query as { path?: string };
    const dir = query.path && isAbsolute(query.path) ? query.path : homedir();
    await sendOk(reply, browseDirectory(dir), newRequestId());
  });

  app.get('/api/v1/fs::home', async (_req, reply) => {
    await sendOk(reply, { home: homedir(), recent_roots: [...ctx.workspaceRoots] }, newRequestId());
  });

  app.post('/api/v1/workspace/fs::search', async (req, reply) => {
    void req;
    await sendOk(reply, { items: [], truncated: false }, newRequestId());
  });

  // --- sessions collection ---------------------------------------------------
  app.get('/api/v1/sessions', async (req, reply) => {
    const query = req.query as Record<string, string | undefined>;
    let items = await bridge.listSessions();
    if (query['archived_only'] === 'true') items = items.filter((s) => s.archived);
    else if (query['include_archive'] !== 'true') items = items.filter((s) => !s.archived);
    if (query['busy'] === 'true') items = items.filter((s) => s.busy);
    if (query['busy'] === 'false') items = items.filter((s) => !s.busy);
    if (query['exclude_empty'] === 'true') items = items.filter((s) => s.messageCount > 0);
    if (query['workspace_id']) {
      const roots = [...ctx.workspaceRoots].filter((r) => workspaceIdFor(r) === query['workspace_id']);
      if (roots.length > 0) items = items.filter((s) => roots.includes(s.cwd));
    }
    const pageSize = Number(query['page_size'] ?? 50);
    const page = items.slice(0, Number.isFinite(pageSize) ? pageSize : 50);
    await sendOk(
      reply,
      {
        items: page.map((s) => {
          const entry = bridge.getEntry(s.id);
          return entry
            ? bridge.toWireSession(entry)
            : diskSessionToWire(s, bridge.epoch);
        }),
        has_more: items.length > page.length,
      },
      newRequestId(),
    );
  });

  app.post('/api/v1/sessions', async (req, reply) => {
    const requestId = newRequestId();
    const body = (req.body ?? {}) as {
      metadata?: { cwd?: string };
      title?: string;
      agent_config?: { model?: string };
    };
    if (typeof body.metadata !== 'object' || body.metadata === null) {
      reply.statusCode = 400;
      await reply.send(fail(ErrorCodes.VALIDATION, 'metadata must be an object', requestId));
      return;
    }
    try {
      const entry = await bridge.createSession({
        cwd: body.metadata.cwd,
        title: body.title,
        model: body.agent_config?.model,
      });
      await sendOk(reply, bridge.toWireSession(entry), requestId);
    } catch (error) {
      reply.statusCode = 500;
      await reply.send(fail(ErrorCodes.INTERNAL, 'Internal server error', requestId));
    }
  });

  // --- single session + action-suffix routes --------------------------------
  // Registered most-specific first; Fastify's router prefers static segments.
  const notFoundSession = async (reply: FastifyReply, requestId: string): Promise<void> => {
    reply.statusCode = 404;
    await reply.send(fail(ErrorCodes.SESSION_NOT_FOUND, 'Session not found', requestId));
  };

  app.get('/api/v1/sessions/:idAction', async (req, reply) => {
    const requestId = newRequestId();
    const { id, action } = splitAction((req.params as { idAction: string }).idAction);
    if (action) {
      reply.statusCode = 404;
      await reply.send(fail(ErrorCodes.NOT_IMPLEMENTED, `Unsupported session action: ${action}`, requestId));
      return;
    }
    try {
      const entry = await bridge.openSession(id);
      await sendOk(reply, bridge.toWireSession(entry), requestId);
    } catch (error) {
      if (error instanceof SessionNotFoundError) return notFoundSession(reply, requestId);
      throw error;
    }
  });

  app.post('/api/v1/sessions/:idAction', async (req, reply) => {
    const requestId = newRequestId();
    const { id, action } = splitAction((req.params as { idAction: string }).idAction);
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      switch (action) {
        case 'abort': {
          const result = await bridge.abortSession(id);
          await sendOk(reply, result, requestId);
          return;
        }
        case 'archive': {
          await bridge.setArchived(id, true);
          await sendOk(reply, { archived: true }, requestId);
          return;
        }
        case 'restore': {
          await bridge.setArchived(id, false);
          const entry = await bridge.openSession(id);
          await sendOk(reply, bridge.toWireSession(entry), requestId);
          return;
        }
        case 'compact': {
          const entry = await bridge.openSession(id);
          void entry.session.compact(typeof body['instruction'] === 'string' ? (body['instruction'] as string) : undefined).catch(() => undefined);
          await sendOk(reply, {}, requestId);
          return;
        }
        default: {
          reply.statusCode = 404;
          await reply.send(fail(ErrorCodes.NOT_IMPLEMENTED, `Unsupported session action: ${action ?? '(none)'}`, requestId));
        }
      }
    } catch (error) {
      if (error instanceof SessionNotFoundError) return notFoundSession(reply, requestId);
      reply.statusCode = 500;
      await reply.send(fail(ErrorCodes.INTERNAL, 'Internal server error', requestId));
    }
  });

  // --- prompts ---------------------------------------------------------------
  app.post('/api/v1/sessions/:id/prompts', async (req, reply) => {
    const requestId = newRequestId();
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      content?: { type: string; text?: string; source?: { kind: string; media_type?: string; data?: string } }[];
      model?: string;
    };
    try {
      const result = await bridge.submitPrompt(id, body.content ?? [], { model: body.model });
      await sendOk(reply, result, requestId);
    } catch (error) {
      if (error instanceof SessionNotFoundError) return notFoundSession(reply, requestId);
      reply.statusCode = 500;
      await reply.send(fail(ErrorCodes.INTERNAL, 'Internal server error', requestId));
    }
  });

  app.post('/api/v1/sessions/:id/prompts::steer', async (req, reply) => {
    void req;
    await sendOk(reply, { steered: false, prompt_ids: [] }, newRequestId());
  });

  app.post('/api/v1/sessions/:id/prompts/:promptAction', async (req, reply) => {
    const requestId = newRequestId();
    const { id, promptAction } = req.params as { id: string; promptAction: string };
    const { action } = splitAction(promptAction);
    if (action !== 'abort' && promptAction !== 'abort') {
      reply.statusCode = 404;
      await reply.send(fail(ErrorCodes.NOT_IMPLEMENTED, `Unsupported prompt action: ${promptAction}`, requestId));
      return;
    }
    const result = await bridge.abortSession(id);
    await sendOk(reply, { aborted: result.aborted }, requestId);
  });

  // --- session sub-resources ---------------------------------------------------
  app.get('/api/v1/sessions/:id/status', async (req, reply) => {
    const requestId = newRequestId();
    const { id } = req.params as { id: string };
    try {
      const entry = await bridge.openSession(id);
      const model = entry.session.model;
      const stats = entry.session.getSessionStats();
      await sendOk(
        reply,
        {
          model: model ? `${model.provider}/${model.id}` : '',
          thinking_level: entry.session.thinkingLevel,
          permission: 'auto',
          plan_mode: false,
          swarm_mode: false,
          context_tokens: stats.contextUsage?.tokens ?? 0,
          max_context_tokens: stats.contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
          context_usage: stats.contextUsage?.percent ?? 0,
        },
        requestId,
      );
    } catch (error) {
      if (error instanceof SessionNotFoundError) return notFoundSession(reply, requestId);
      throw error;
    }
  });

  app.get('/api/v1/sessions/:id/snapshot', async (req, reply) => {
    const requestId = newRequestId();
    const { id } = req.params as { id: string };
    try {
      const entry = await bridge.openSession(id);
      await sendOk(reply, bridge.buildSnapshot(entry), requestId);
    } catch (error) {
      if (error instanceof SessionNotFoundError) return notFoundSession(reply, requestId);
      throw error;
    }
  });

  app.get('/api/v1/sessions/:id/messages', async (req, reply) => {
    const requestId = newRequestId();
    const { id } = req.params as { id: string };
    try {
      const entry = await bridge.openSession(id);
      const snapshot = bridge.buildSnapshot(entry);
      await sendOk(reply, snapshot.messages, requestId);
    } catch (error) {
      if (error instanceof SessionNotFoundError) return notFoundSession(reply, requestId);
      throw error;
    }
  });

  app.post('/api/v1/sessions/:id/profile', async (req, reply) => {
    const requestId = newRequestId();
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      title?: string;
      metadata?: { cwd?: string };
      agent_config?: { model?: string; thinking?: string };
    };
    try {
      if (typeof body.title === 'string' && body.title.length > 0) {
        await bridge.renameSession(id, body.title);
      }
      const cfg = body.agent_config;
      if (cfg?.model) {
        if (!bridge.resolveModel(cfg.model)) {
          reply.statusCode = 400;
          await reply.send(fail(ErrorCodes.VALIDATION, `Unknown model: ${cfg.model}`, requestId));
          return;
        }
        await bridge.setModel(id, cfg.model);
      }
      if (cfg?.thinking) bridge.setThinking(id, cfg.thinking);
      const entry = await bridge.openSession(id);
      await sendOk(reply, bridge.toWireSession(entry), requestId);
    } catch (error) {
      if (error instanceof SessionNotFoundError) return notFoundSession(reply, requestId);
      reply.statusCode = 500;
      await reply.send(fail(ErrorCodes.INTERNAL, 'Internal server error', requestId));
    }
  });

  app.get('/api/v1/sessions/:id/approvals', async (_req, reply) => {
    await sendOk(reply, { items: [] }, newRequestId());
  });

  app.post('/api/v1/sessions/:id/approvals/:approvalId', async (req, reply) => {
    const requestId = newRequestId();
    const { id, approvalId } = req.params as { id: string; approvalId: string };
    const body = (req.body ?? {}) as { decision?: string; feedback?: string };
    const approved = body.decision === 'approved';
    const result = bridge.resolveApproval(id, approvalId, approved, body.feedback);
    if (!result.resolved) {
      reply.statusCode = 404;
      await reply.send(fail(ErrorCodes.APPROVAL_NOT_FOUND, 'Approval not found', requestId));
      return;
    }
    await sendOk(reply, { resolved: true, resolved_at: new Date().toISOString() }, requestId);
  });

  app.get('/api/v1/sessions/:id/questions', async (_req, reply) => {
    await sendOk(reply, { items: [] }, newRequestId());
  });
  app.post('/api/v1/sessions/:id/questions/:qidAction', async (req, reply) => {
    const requestId = newRequestId();
    const { action } = splitAction((req.params as { qidAction: string }).qidAction);
    if (action === 'dismiss') {
      await sendOk(reply, { dismissed: true }, requestId);
      return;
    }
    reply.statusCode = 404;
    await reply.send(fail(ErrorCodes.QUESTION_NOT_FOUND, 'No pending question', requestId));
  });

  // Degraded kimi-specific sub-resources
  app.get('/api/v1/sessions/:id/goal', async (_req, reply) => sendOk(reply, null, newRequestId()));
  app.get('/api/v1/sessions/:id/warnings', async (_req, reply) => sendOk(reply, { warnings: [] }, newRequestId()));
  app.get('/api/v1/sessions/:id/children', async (_req, reply) => sendOk(reply, { items: [], has_more: false }, newRequestId()));
  app.post('/api/v1/sessions/:id/children', async (req, reply) => sendOk(reply, { items: [], has_more: false }, newRequestId()));
  app.get('/api/v1/sessions/:id/tasks', async (_req, reply) => sendOk(reply, { items: [] }, newRequestId()));
  app.post('/api/v1/sessions/:id/tasks/:rest', async (_req, reply) => sendOk(reply, {}, newRequestId()));
  app.get('/api/v1/sessions/:id/terminals', async (_req, reply) => sendOk(reply, { items: [] }, newRequestId()));
  app.post('/api/v1/sessions/:id/terminals/:rest', async (_req, reply) => sendOk(reply, {}, newRequestId()));
  app.get('/api/v1/sessions/:id/skills', async (_req, reply) => sendOk(reply, { skills: [] }, newRequestId()));
  app.post('/api/v1/sessions/:id/skills/:rest', async (_req, reply) => sendOk(reply, {}, newRequestId()));
  app.post('/api/v1/sessions/:id/export', async (_req, reply) => {
    reply.statusCode = 404;
    await reply.send(fail(ErrorCodes.NOT_IMPLEMENTED, 'Session export is not supported by pi-code', newRequestId()));
  });
  app.get('/api/v1/sessions/:id/title/generate', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const entry = await bridge.openSession(id);
      await sendOk(reply, { title: bridge.toWireSession(entry).title }, newRequestId());
    } catch {
      await sendOk(reply, { title: 'Session' }, newRequestId());
    }
  });

  // --- session fs -------------------------------------------------------------
  app.post('/api/v1/sessions/:id/fs::list', async (req, reply) => {
    const requestId = newRequestId();
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { path?: string; recursive?: boolean };
    try {
      const entry = await bridge.openSession(id);
      const root = entry.cwd;
      const target = body.path ? resolve(join(root, body.path)) : root;
      const result = listDirectory(root, target, body.recursive === true ? 2 : 1);
      await sendOk(reply, result, requestId);
    } catch (error) {
      reply.statusCode = 500;
      await reply.send(fail(ErrorCodes.INTERNAL, 'Internal server error', requestId));
    }
  });

  app.post('/api/v1/sessions/:id/fs::read', async (req, reply) => {
    const requestId = newRequestId();
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { path?: string };
    try {
      const entry = await bridge.openSession(id);
      const abs = resolve(join(entry.cwd, body.path ?? ''));
      const content = readFileSync(abs);
      const text = content.toString('utf8');
      const isBinary = text.includes('\u0000');
      await sendOk(
        reply,
        {
          path: body.path ?? '',
          content: isBinary ? content.toString('base64') : text,
          encoding: isBinary ? 'base64' : 'utf-8',
          size: content.byteLength,
          truncated: false,
          etag: createHash('sha1').update(content).digest('hex').slice(0, 16),
          mime: mimeOf(abs),
          is_binary: isBinary,
        },
        requestId,
      );
    } catch (error) {
      reply.statusCode = 500;
      await reply.send(fail(ErrorCodes.INTERNAL, 'Internal server error', requestId));
    }
  });

  app.post('/api/v1/sessions/:id/fs::grep', async (_req, reply) => sendOk(reply, { items: [], truncated: false }, newRequestId()));
  app.post('/api/v1/sessions/:id/fs::git_status', async (_req, reply) => sendOk(reply, { files: [], branch: '', ahead: 0, behind: 0 }, newRequestId()));
  app.post('/api/v1/sessions/:id/fs::diff', async (_req, reply) => sendOk(reply, { files: [] }, newRequestId()));
  app.post('/api/v1/sessions/:id/fs::open', async (_req, reply) => sendOk(reply, { opened: true }, newRequestId()));
  app.post('/api/v1/sessions/:id/fs::reveal', async (_req, reply) => sendOk(reply, { revealed: true }, newRequestId()));
  app.post('/api/v1/sessions/:id/fs::open-in', async (_req, reply) => sendOk(reply, { opened: true }, newRequestId()));

  app.post('/api/v1/shutdown', async (_req, reply) => {
    await sendOk(reply, { shutting_down: true }, newRequestId());
    setTimeout(() => process.exit(0), 100);
  });

  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function diskSessionToWire(
  s: { id: string; cwd: string; title: string; createdAt: Date; updatedAt: Date; messageCount: number; archived: boolean; busy: boolean },
  epoch: string,
) {
  void epoch;
  return {
    id: s.id,
    title: s.title,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
    busy: s.busy,
    archived: s.archived,
    metadata: { cwd: s.cwd },
    agent_config: { model: '' },
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_cost_usd: 0,
      context_tokens: 0,
      context_limit: 0,
      turn_count: 0,
    },
    permission_rules: [],
    message_count: s.messageCount,
    last_seq: 0,
  };
}

function browseDirectory(dir: string): { path: string; parent: string | null; entries: { name: string; path: string; is_dir: boolean }[] } {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: join(dir, e.name), is_dir: e.isDirectory() }))
      .sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
    return { path: dir, parent: dirname(dir) === dir ? null : dirname(dir), entries };
  } catch {
    return { path: dir, parent: null, entries: [] };
  }
}

function listDirectory(
  root: string,
  target: string,
  depth: number,
  currentDepth = 0,
): { items: { path: string; name: string; kind: 'file' | 'directory' | 'symlink'; size?: number; modified_at: string; child_count?: number }[]; truncated: boolean } {
  const items: { path: string; name: string; kind: 'file' | 'directory' | 'symlink'; size?: number; modified_at: string; child_count?: number }[] = [];
  let truncated = false;
  let dirents;
  try {
    dirents = readdirSync(target, { withFileTypes: true });
  } catch {
    return { items: [], truncated: false };
  }
  dirents.sort((a, b) => a.name.localeCompare(b.name));
  for (const dirent of dirents) {
    if (dirent.name.startsWith('.') ) continue;
    const abs = join(target, dirent.name);
    const rel = relative(root, abs);
    let kind: 'file' | 'directory' | 'symlink' = 'file';
    if (dirent.isSymbolicLink()) kind = 'symlink';
    else if (dirent.isDirectory()) kind = 'directory';
    let size: number | undefined;
    let modifiedAt = new Date().toISOString();
    let childCount: number | undefined;
    try {
      const st = statSync(abs);
      modifiedAt = new Date(st.mtimeMs).toISOString();
      if (kind === 'file') size = st.size;
    } catch {
      // Broken symlink etc.
    }
    if (kind === 'directory' && currentDepth < depth - 1) {
      const sub = listDirectory(root, abs, depth, currentDepth + 1);
      items.push({ path: rel, name: dirent.name, kind, modified_at: modifiedAt, child_count: sub.items.length });
      items.push(...sub.items);
    } else {
      if (kind === 'directory') {
        try {
          childCount = readdirSync(abs).length;
        } catch {
          childCount = 0;
        }
      }
      items.push({ path: rel, name: dirent.name, kind, size, modified_at: modifiedAt, ...(childCount !== undefined ? { child_count: childCount } : {}) });
    }
    if (items.length > 2000) {
      truncated = true;
      break;
    }
  }
  return { items, truncated };
}

function mimeOf(path: string): string {
  const ext = extname(path).toLowerCase();
  const table: Record<string, string> = {
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
  };
  return table[ext] ?? 'text/plain';
}

export { encodeId };
