import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/routes.ts';

describe('model configuration routes', () => {
  const token = 'model-route-token';
  let app: ReturnType<typeof buildApp>;
  let modelConfiguration: Record<string, unknown>;

  beforeEach(() => {
    modelConfiguration = {
      refresh: vi.fn().mockResolvedValue({ changed: [], unchanged: [], failed: [] }),
      authStatus: vi.fn().mockResolvedValue({ ready: true, providers_count: 1, default_model: 'custom/model' }),
      saveModelsConfig: vi.fn(),
      testModel: vi.fn().mockResolvedValue({ ok: true }),
      catalogProviders: vi.fn().mockReturnValue([{ id: 'anthropic' }]),
      catalogProvider: vi.fn().mockReturnValue({ id: 'anthropic' }),
      importCatalogProvider: vi.fn().mockResolvedValue({ provider: { id: 'anthropic' }, models_imported: 1 }),
      updateConfig: vi.fn().mockResolvedValue({ providers: {}, models: {} }),
      startOAuth: vi.fn().mockReturnValue({ flow_id: 'flow-1', provider: 'openai-codex', status: 'pending' }),
      getOAuth: vi.fn().mockReturnValue({ flow_id: 'flow-1', provider: 'openai-codex', status: 'pending' }),
      answerOAuth: vi.fn().mockReturnValue({ flow_id: 'flow-1', provider: 'openai-codex', status: 'pending' }),
      cancelOAuth: vi.fn().mockReturnValue({ cancelled: true, status: 'cancelled' }),
      logout: vi.fn().mockResolvedValue({ provider: 'openai-codex', removed: true }),
    };
    app = buildApp({
      bridge: {} as never,
      token,
      bypassAuth: false,
      workspaceRoots: new Set(),
      modelConfiguration: modelConfiguration as never,
    });
  });

  afterEach(async () => app.close());

  const request = (options: { method: string; url: string; headers?: Record<string, string>; payload?: unknown }) => app.inject({
    ...options,
    headers: { authorization: `Bearer ${token}`, ...options.headers },
  } as never);

  it('preserves Fastify client-error status codes in the response envelope', async () => {
    const response = await request({
      method: 'POST',
      url: '/api/v1/config',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 40001, data: null });
  });

  it('reads auth readiness and the default model from the shared configuration service', async () => {
    const response = await request({ method: 'GET', url: '/api/v1/auth' });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      ready: true,
      providers_count: 1,
      default_model: 'custom/model',
    });
    expect(modelConfiguration.authStatus).toHaveBeenCalledOnce();
  });

  it('matches provider and models-config colon actions', async () => {
    const provider = await request({ method: 'POST', url: '/api/v1/providers/custom:refresh', payload: {} });
    expect(provider.statusCode).toBe(200);
    expect(modelConfiguration.refresh).toHaveBeenCalledWith(['custom']);

    const all = await request({ method: 'POST', url: '/api/v1/providers:refresh', payload: {} });
    expect(all.statusCode).toBe(200);
    expect(modelConfiguration.refresh).toHaveBeenCalledWith();

    const test = await request({
      method: 'POST',
      url: '/api/v1/models-config:test',
      payload: { provider: 'custom', model: 'model' },
    });
    expect(test.statusCode).toBe(200);
    expect(modelConfiguration.testModel).toHaveBeenCalledWith({ provider: 'custom', model: 'model' });
  });

  it('exposes the official provider catalog and import contract', async () => {
    const catalog = await request({ method: 'GET', url: '/api/v1/catalog/providers' });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().data.items).toEqual([{ id: 'anthropic' }]);

    const detail = await request({ method: 'GET', url: '/api/v1/catalog/providers/anthropic' });
    expect(detail.statusCode).toBe(200);
    expect(modelConfiguration.catalogProvider).toHaveBeenCalledWith('anthropic');

    const imported = await request({
      method: 'POST',
      url: '/api/v1/providers:import_catalog',
      payload: { catalog_id: 'anthropic', api_key: 'secret' },
    });
    expect(imported.statusCode).toBe(200);
    expect(modelConfiguration.importCatalogProvider).toHaveBeenCalledWith({ catalog_id: 'anthropic', api_key: 'secret' });
  });

  it('accepts partial official config updates', async () => {
    const response = await request({
      method: 'POST',
      url: '/api/v1/config',
      payload: { default_model: 'anthropic/model' },
    });
    expect(response.statusCode).toBe(200);
    expect(modelConfiguration.updateConfig).toHaveBeenCalledWith({ default_model: 'anthropic/model' });
  });

  it('forwards the complete provider-scoped OAuth lifecycle', async () => {
    const started = await request({
      method: 'POST',
      url: '/api/v1/oauth/login',
      payload: { provider: 'openai-codex' },
    });
    expect(started.statusCode).toBe(200);
    expect(modelConfiguration.startOAuth).toHaveBeenCalledWith('openai-codex');

    const polled = await request({ method: 'GET', url: '/api/v1/oauth/login?flow_id=flow-1' });
    expect(polled.statusCode).toBe(200);
    expect(modelConfiguration.getOAuth).toHaveBeenCalledWith('flow-1');

    const answered = await request({
      method: 'POST',
      url: '/api/v1/oauth/login/flow-1/respond',
      payload: { prompt_id: 'prompt-1', value: 'browser' },
    });
    expect(answered.statusCode).toBe(200);
    expect(modelConfiguration.answerOAuth).toHaveBeenCalledWith('flow-1', 'prompt-1', 'browser');

    const cancelled = await request({ method: 'DELETE', url: '/api/v1/oauth/login?flow_id=flow-1' });
    expect(cancelled.statusCode).toBe(200);
    expect(modelConfiguration.cancelOAuth).toHaveBeenCalledWith('flow-1');
  });

  it('requires a revision before saving a complete models.json document', async () => {
    const response = await request({
      method: 'PUT',
      url: '/api/v1/models-config',
      payload: { document: { providers: {} } },
    });
    expect(response.statusCode).toBe(400);
    expect(modelConfiguration.saveModelsConfig).not.toHaveBeenCalled();
  });

  it('rejects oversized models.json requests without converting 413 to 500', async () => {
    const response = await request({
      method: 'PUT',
      url: '/api/v1/models-config',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ revision: 'revision', document: { providers: {}, padding: 'x'.repeat(1024 * 1024) } }),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 40001, data: null });
  });

  it('bounds credential request bodies', async () => {
    const response = await request({
      method: 'POST',
      url: '/api/v1/providers:import_catalog',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ catalog_id: 'anthropic', api_key: 'x'.repeat(32 * 1024) }),
    });
    expect(response.statusCode).toBe(413);
    expect(modelConfiguration.importCatalogProvider).not.toHaveBeenCalled();
  });
});
