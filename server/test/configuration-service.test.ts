import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelConfigurationService } from '../src/models/configuration-service.ts';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const validConfig = (id: string) => ({
  providers: {
    custom: {
      api: 'openai-completions',
      baseUrl: 'https://example.test/v1',
      models: [{ id }],
    },
  },
});

describe('ModelConfigurationService models.json reload', () => {
  it('persists full-form edits as a local override for a built-in provider', async () => {
    const runtime = {
      getProvider: vi.fn().mockReturnValue({ id: 'built-in', auth: { apiKey: {} } }),
    };
    const service = new ModelConfigurationService(runtime as never, '/tmp/pi-code-provider-override-test');
    vi.spyOn(service.store, 'readUnsafe').mockResolvedValue({
      document: { providers: {} },
      revision: 'revision-1',
    });
    const saveCustomProvider = vi.spyOn(
      service as unknown as { saveCustomProvider: (...args: unknown[]) => Promise<unknown> },
      'saveCustomProvider',
    )
      .mockResolvedValue({ provider: { id: 'built-in' } } as never);
    const input = {
      type: 'openai',
      base_url: 'https://example.test/v1',
      models: [
        { model: 'model-one', max_context_size: 32_768 },
        { model: 'model-two', max_context_size: 65_536 },
      ],
    };

    await expect(service.updateProvider('built-in', input)).resolves.toEqual({
      provider: { id: 'built-in' },
    });
    expect(saveCustomProvider).toHaveBeenCalledWith(
      'built-in',
      input,
      'built-in',
      { document: { providers: {} }, revision: 'revision-1' },
    );
  });

  it('restores the previous file when the shared runtime cannot reload', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-code-model-service-'));
    const runtime = {
      refresh: vi.fn()
        .mockResolvedValueOnce({ aborted: false, errors: new Map([['custom', new Error('reload failed')]]) })
        .mockResolvedValueOnce({ aborted: false, errors: new Map() }),
    };
    const service = new ModelConfigurationService(runtime as never, directory);
    await service.store.write(validConfig('working-model'));
    const before = await service.store.read();

    await expect(service.saveModelsConfig(validConfig('replacement-model'), before.revision))
      .rejects.toThrow('previous configuration was restored');
    expect((await service.store.readUnsafe()).document).toEqual(validConfig('working-model'));
  });

  it('does not invent a max output size when the official form omits it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-code-model-service-'));
    const runtime = await ModelRuntime.create({
      authPath: join(directory, 'auth.json'),
      modelsPath: join(directory, 'models.json'),
      modelsStorePath: join(directory, 'models-store.json'),
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const service = new ModelConfigurationService(runtime, directory);

    await service.addProvider({
      id: 'custom',
      type: 'openai',
      api_key: 'test-key',
      base_url: 'https://example.test/v1',
      models: [{ model: 'model', max_context_size: 32_768 }],
    });

    const provider = (await service.store.readUnsafe()).document.providers.custom as { models: Array<Record<string, unknown>> };
    expect(provider.models[0]).not.toHaveProperty('maxTokens');

    expect(await service.models()).toEqual([
      expect.objectContaining({ provider: 'custom', model: 'custom/model', available: true }),
    ]);

    await service.setDefault({ default_model: 'model' });
    await expect(service.config()).resolves.toMatchObject({
      default_provider: 'custom',
      default_model: 'custom/model',
    });
    await expect(service.authStatus()).resolves.toMatchObject({
      providers_count: 1,
      default_model: 'custom/model',
    });
  });

  it('returns the official provider refresh contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-code-model-service-'));
    let modelIds = ['before'];
    const provider = {
      id: 'custom',
      name: 'Custom',
      getModels: () => modelIds.map((id) => ({ id })),
    };
    const runtime = {
      getProviders: () => [provider],
      getProvider: () => provider,
      refresh: vi.fn().mockImplementation(async () => {
        modelIds = ['after'];
        return { aborted: false, errors: new Map() };
      }),
    };
    const service = new ModelConfigurationService(runtime as never, directory);

    await expect(service.refresh()).resolves.toMatchObject({
      changed: [{
        provider_id: 'custom',
        provider_name: 'Custom',
        added: ['after'],
        removed: ['before'],
      }],
      unchanged: [],
      failed: [],
    });
  });
});

describe('ModelConfigurationService OAuth lifecycle', () => {
  afterEach(() => vi.useRealTimers());

  interface TestInteraction {
    signal: AbortSignal;
    notify(event: { type: string; message?: string }): void;
    prompt(prompt: { type: 'text'; message: string }): Promise<string>;
  }

  function serviceWithLogin(login: (provider: string, type: string, interaction: TestInteraction) => Promise<unknown>) {
    const runtime = {
      getProvider: () => ({ id: 'oauth-provider', auth: { oauth: {} } }),
      login,
    };
    return new ModelConfigurationService(runtime as never, '/tmp/pi-code-oauth-test');
  }

  it('keeps a completed result briefly, then removes it', async () => {
    vi.useFakeTimers();
    const service = serviceWithLogin(async () => ({}));
    const started = service.startOAuth('oauth-provider');
    await Promise.resolve();
    expect(service.getOAuth(started.flow_id).status).toBe('authenticated');

    await vi.advanceTimersByTimeAsync(60_001);
    expect(() => service.getOAuth(started.flow_id)).toThrow('OAuth flow not found');
  });

  it('returns structured events and prompts, then accepts the response', async () => {
    vi.useFakeTimers();
    let answer = '';
    const service = serviceWithLogin(async (_provider, _type, interaction) => {
      interaction.notify({ type: 'progress', message: 'Waiting for confirmation' });
      interaction.notify({ type: 'auth_url', url: 'https://example.test/oauth' } as never);
      answer = await interaction.prompt({ type: 'text', message: 'Confirmation code' });
      return {};
    });
    const started = service.startOAuth('oauth-provider');
    expect(started.events).toEqual([
      { type: 'progress', message: 'Waiting for confirmation' },
      { type: 'auth_url', url: 'https://example.test/oauth' },
    ]);
    expect(started.context_events).toEqual([{ type: 'auth_url', url: 'https://example.test/oauth' }]);
    expect(started.prompt).toMatchObject({ type: 'text', message: 'Confirmation code' });

    const resumed = service.startOAuth('oauth-provider');
    expect(resumed.events).toEqual([]);
    expect(resumed.context_events).toEqual([{ type: 'auth_url', url: 'https://example.test/oauth' }]);

    service.answerOAuth(started.flow_id, started.prompt!.id, 'confirmed');
    await Promise.resolve();
    await Promise.resolve();
    expect(answer).toBe('confirmed');
    expect(service.getOAuth(started.flow_id).status).toBe('authenticated');
  });

  it('aborts and removes a pending flow when it expires', async () => {
    vi.useFakeTimers();
    let aborted = false;
    const service = serviceWithLogin((_provider, _type, interaction) => new Promise((_resolve, reject) => {
      interaction.signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('aborted'));
      });
    }));
    const started = service.startOAuth('oauth-provider');

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(aborted).toBe(true);
    expect(() => service.getOAuth(started.flow_id)).toThrow('OAuth flow not found');
  });

  it('resumes the active flow for the same provider', () => {
    const service = serviceWithLogin(() => new Promise(() => undefined));
    const first = service.startOAuth('oauth-provider');
    const resumed = service.startOAuth('oauth-provider');
    expect(resumed.flow_id).toBe(first.flow_id);
    expect(resumed.status).toBe('pending');
  });

  it('keeps cancellation terminal when the login promise resolves later', async () => {
    let resolveLogin!: () => void;
    const service = serviceWithLogin(() => new Promise<void>((resolve) => { resolveLogin = resolve; }));
    const started = service.startOAuth('oauth-provider');
    service.cancelOAuth(started.flow_id);
    resolveLogin();
    await Promise.resolve();
    await Promise.resolve();
    expect(service.getOAuth(started.flow_id).status).toBe('cancelled');
  });

  it('bounds queued events and prompt responses', async () => {
    const service = serviceWithLogin(async (_provider, _type, interaction) => {
      for (let index = 0; index < 110; index += 1) {
        interaction.notify({ type: 'progress', message: `event-${index}` });
      }
      await interaction.prompt({ type: 'text', message: 'Code' });
    });
    const started = service.startOAuth('oauth-provider');
    expect(started.events).toHaveLength(100);
    expect(started.events[0]).toMatchObject({ message: 'event-10' });
    expect(() => service.answerOAuth(started.flow_id, started.prompt!.id, 'x'.repeat(16 * 1024 + 1)))
      .toThrow('too long');
  });
});
