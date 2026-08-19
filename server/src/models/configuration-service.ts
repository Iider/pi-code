import { randomUUID } from 'node:crypto';
import { getAgentDir, SettingsManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AuthEvent, AuthPrompt, AuthType } from '@earendil-works/pi-ai';
import { ErrorCodes } from '../envelope.ts';
import { ConfigurationError, redactConfig, redactText } from './errors.ts';
import { ModelsConfigStore, type ModelsConfigDocument } from './models-config-store.ts';
import { PiCodeSettingsStore, type DefaultPermissionMode } from './pi-code-settings-store.ts';
import {
  catalogProviderView,
  configModelViews,
  piApiForWireType,
  providerViews,
  type ProviderView,
} from './provider-view.ts';

interface ProviderModelInput {
  model?: unknown;
  max_context_size?: unknown;
  display_name?: unknown;
  capabilities?: unknown;
  max_output_size?: unknown;
}

interface ProviderInput {
  id?: unknown;
  new_id?: unknown;
  type?: unknown;
  api_key?: unknown;
  base_url?: unknown;
  default_model?: unknown;
  models?: unknown;
}

interface PendingPrompt {
  id: string;
  prompt: AuthPrompt;
  resolve(value: string): void;
  reject(error: Error): void;
}

interface OAuthFlow {
  id: string;
  provider: string;
  status: 'pending' | 'authenticated' | 'failed' | 'cancelled';
  events: AuthEvent[];
  contextEvents: AuthEvent[];
  prompt?: PendingPrompt;
  controller: AbortController;
  expiresAt: number;
  error?: string;
  expiryTimer?: NodeJS.Timeout;
  cleanupTimer?: NodeJS.Timeout;
}

const OAUTH_FLOW_TTL_MS = 10 * 60_000;
const OAUTH_RESULT_TTL_MS = 60_000;
const MAX_OAUTH_EVENTS = 100;
const MAX_SECRET_LENGTH = 16 * 1024;
const MAX_PROVIDER_ID_LENGTH = 128;

export class ModelConfigurationService {
  readonly store: ModelsConfigStore;
  readonly piCodeSettings: PiCodeSettingsStore;
  private readonly settings: SettingsManager;
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly flows = new Map<string, OAuthFlow>();
  private version = 0;

  constructor(readonly runtime: ModelRuntime, agentDir = getAgentDir()) {
    this.store = new ModelsConfigStore(agentDir);
    this.piCodeSettings = new PiCodeSettingsStore(agentDir);
    this.settings = SettingsManager.create(process.cwd(), agentDir);
  }

  async providers() {
    return (await this.visibleProviderViews()).filter((provider) => provider.has_api_key);
  }

  async provider(providerId: string) {
    return this.requireProviderView(providerId);
  }

  catalogProviders() {
    return this.runtime.getProviders().map(catalogProviderView);
  }

  catalogProvider(providerId: string) {
    return catalogProviderView(this.requireProvider(providerId));
  }

  async models() {
    const available = await this.visibleAvailableModels();
    return available.map((m) => ({
      provider: String(m.provider),
      model: `${m.provider}/${m.id}`,
      id: `${m.provider}/${m.id}`,
      display_name: m.name,
      max_context_size: m.contextWindow ?? 0,
      capabilities: [...(m.reasoning ? ['reasoning'] : []), ...(m.input.includes('image') ? ['image'] : [])],
      available: true,
    }));
  }

  async authStatus() {
    await this.settings.reload();
    const available = await this.visibleAvailableModels();
    const configuredProvider = this.settings.getDefaultProvider();
    const configuredModel = this.settings.getDefaultModel();
    const configured = configuredProvider && configuredModel
      ? available.find((model) => model.provider === configuredProvider && model.id === configuredModel)
      : undefined;
    const selected = configured ?? available[0];
    return {
      ready: true,
      providers_count: new Set(available.map((model) => model.provider)).size,
      default_model: selected ? `${selected.provider}/${selected.id}` : null,
    };
  }

  async config() {
    await this.settings.reload();
    const provider = this.settings.getDefaultProvider();
    const model = this.settings.getDefaultModel();
    const id = provider && model ? `${provider}/${model}` : undefined;
    const providers = await this.providers();
    const availableModels = await this.visibleAvailableModels();
    return {
      providers: Object.fromEntries(providers.map((item) => [item.id, {
        type: item.type,
        base_url: item.base_url,
        default_model: provider === item.id ? model : undefined,
        has_api_key: item.has_api_key,
      }])),
      default_provider: provider,
      default_model: id,
      models: configModelViews(availableModels),
      default_model_available: provider && model ? Boolean(this.runtime.getModel(provider, model)) : false,
      thinking: this.settings.getDefaultThinkingLevel(),
      default_permission_mode: await this.piCodeSettings.defaultPermissionMode(),
      raw: redactConfig(this.settings.getGlobalSettings()),
      version: this.version,
    };
  }

  async updateConfig(input: Record<string, unknown>) {
    if (input.default_model !== undefined || input.default_provider !== undefined) {
      await this.setDefault(input);
    }
    if (typeof input.thinking === 'string') {
      this.settings.setDefaultThinkingLevel(input.thinking as never);
      await this.settings.flush();
      this.version += 1;
    }
    if (input.default_permission_mode !== undefined) {
      await this.piCodeSettings.updateDefaultPermissionMode(requireDefaultPermissionMode(input.default_permission_mode));
      this.version += 1;
    }
    return this.config();
  }

  async setDefault(input: { default_provider?: unknown; default_model?: unknown }) {
    if (typeof input.default_model !== 'string') {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'default_model is required');
    }
    const available = await this.visibleAvailableModels();
    const selected = resolveDefaultModel(available, input.default_model, input.default_provider);
    if (!selected) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'Default model must be an existing provider/model');
    }
    const provider = String(selected.provider);
    const model = selected.id;
    this.settings.setDefaultModelAndProvider(provider, model);
    await this.settings.flush();
    this.version += 1;
    return this.config();
  }

  async addProvider(input: ProviderInput) {
    const id = requireProviderId(input.id);
    return this.saveCustomProvider(id, input);
  }

  async updateProvider(providerId: string, input: ProviderInput) {
    const stored = await this.store.readUnsafe();
    if (providerId in stored.document.providers) {
      const nextId = input.new_id === undefined ? providerId : requireProviderId(input.new_id);
      return this.saveCustomProvider(nextId, input, providerId, stored);
    }

    const provider = this.requireProvider(providerId);
    if (typeof input.new_id === 'string' && input.new_id !== providerId) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'Built-in pi agent providers cannot be renamed');
    }
    // The official provider editor always submits the complete model list.
    // Persisting it under the same id intentionally turns a built-in provider
    // into a local override; otherwise model/base URL edits are silently
    // discarded while the UI is told that saving succeeded.
    if (Array.isArray(input.models)) {
      return this.saveCustomProvider(providerId, input, providerId, stored);
    }
    if (typeof input.api_key === 'string' && input.api_key.trim()) {
      await this.loginApiKey(providerId, input.api_key);
    }
    if (typeof input.default_model === 'string' && input.default_model) {
      await this.setDefault({ default_provider: providerId, default_model: `${providerId}/${input.default_model}` });
    }
    return { provider: await this.requireProviderView(provider.id) };
  }

  async importCatalogProvider(input: ProviderInput & { catalog_id?: unknown }) {
    const providerId = requireProviderId(input.catalog_id);
    if (input.id !== undefined && input.id !== providerId) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'Built-in pi agent providers keep their native id');
    }
    if (typeof input.api_key !== 'string' || !input.api_key.trim()) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'api_key is required');
    }
    await this.loginApiKey(providerId, input.api_key);
    const provider = await this.requireProviderView(providerId);
    return { provider, models_imported: provider.model_count };
  }

  async deleteProvider(providerId: string) {
    const stored = await this.store.readUnsafe();
    if (providerId in stored.document.providers) {
      const next = structuredClone(stored.document);
      delete next.providers[providerId];
      await this.saveModelsConfig(next, stored.revision);
      return { deleted: providerId };
    }

    const view = await this.requireProviderView(providerId);
    if (view.auth_source === 'environment') {
      throw new ConfigurationError(409, ErrorCodes.CREDENTIAL_CHANGED, 'Credential comes from the environment; remove it from the process environment');
    }
    if (view.credential_type !== 'api_key' && view.credential_type !== 'oauth') {
      throw new ConfigurationError(409, ErrorCodes.CREDENTIAL_CHANGED, 'Credential type changed; reload before deleting');
    }
    await this.logout(providerId, view.credential_type);
    return { deleted: providerId };
  }

  async loginApiKey(providerId: string, apiKey: string) {
    if (!apiKey.trim()) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'api_key is required');
    }
    if (apiKey.length > MAX_SECRET_LENGTH) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'API key is too long');
    }
    return this.serial(providerId, async () => {
      const provider = this.requireProvider(providerId);
      if (!provider.auth.apiKey?.login) {
        throw new ConfigurationError(422, ErrorCodes.PROVIDER_UNSUPPORTED, 'This provider does not support API key setup');
      }
      let used = false;
      await this.runtime.login(providerId, 'api_key', {
        prompt: async (prompt) => {
          if (prompt.type !== 'secret' || used) {
            throw new ConfigurationError(422, ErrorCodes.PROVIDER_INTERACTION_REQUIRED, 'This provider requires additional interactive setup');
          }
          used = true;
          return apiKey;
        },
        notify: () => undefined,
      });
      this.version += 1;
      return { provider: providerId, credential_type: 'api_key', saved: true, version: this.version };
    });
  }

  async logout(providerId: string, expectedType: AuthType) {
    return this.serial(providerId, async () => {
      const view = (await this.providers()).find((item) => item.id === providerId);
      if (!view) throw new ConfigurationError(404, ErrorCodes.VALIDATION, 'Unknown provider');
      if (view.auth_source === 'environment') {
        throw new ConfigurationError(409, ErrorCodes.CREDENTIAL_CHANGED, 'Credential comes from the environment; remove it from the process environment');
      }
      if (view.credential_type !== expectedType) {
        throw new ConfigurationError(409, ErrorCodes.CREDENTIAL_CHANGED, 'Credential type changed; reload before deleting');
      }
      await this.runtime.logout(providerId);
      this.version += 1;
      return { provider: providerId, removed: true, version: this.version };
    });
  }

  async refresh(providerIds?: string[]) {
    const selectedProviders = [...new Set(providerIds ?? this.runtime.getProviders().map((provider) => provider.id))];
    const before = providerModelIds(this.runtime, selectedProviders);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const result = await this.runtime.refresh({
        allowNetwork: true,
        force: true,
        providers: providerIds,
        signal: controller.signal,
      });
      this.version += 1;
      const after = providerModelIds(this.runtime, selectedProviders);
      const failed = [...result.errors].map(([provider, error]) => ({
        provider,
        reason: redactText(error.message),
      }));
      const failedProviders = new Set(failed.map((item) => item.provider));
      const changed = [];
      const unchanged = [];
      for (const providerId of selectedProviders) {
        if (failedProviders.has(providerId)) continue;
        const previous = before.get(providerId) ?? new Set<string>();
        const current = after.get(providerId) ?? new Set<string>();
        const added = [...current].filter((model) => !previous.has(model));
        const removed = [...previous].filter((model) => !current.has(model));
        if (added.length === 0 && removed.length === 0) {
          unchanged.push(providerId);
          continue;
        }
        changed.push({
          provider_id: providerId,
          provider_name: this.runtime.getProvider(providerId)?.name ?? providerId,
          added,
          removed,
        });
      }
      return {
        changed,
        unchanged,
        failed,
        aborted: result.aborted,
        version: this.version,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async saveModelsConfig(document: unknown, revision: string) {
    return this.serial('models-config', () => this.saveModelsConfigNow(document, revision));
  }

  private async saveModelsConfigNow(document: unknown, revision: string) {
    const previous = await this.store.readUnsafe();
    const saved = await this.store.write(document, revision);
    const result = await this.runtime.refresh({ allowNetwork: false });
    if (result.errors.size) {
      try {
        await this.store.write(previous.document, saved.revision);
        const rollback = await this.runtime.refresh({ allowNetwork: false });
        if (rollback.errors.size) throw new Error('Runtime rejected the restored models.json');
      } catch {
        throw new ConfigurationError(500, ErrorCodes.INTERNAL, 'models.json reload failed and the previous configuration could not be restored');
      }
      throw new ConfigurationError(500, ErrorCodes.INTERNAL, 'models.json reload failed; the previous configuration was restored');
    }
    this.version += 1;
    return { ...saved, version: this.version };
  }

  async deleteCustomProvider(providerId: string, revision: string) {
    const current = await this.store.readUnsafe();
    const providers = current.document.providers;
    if (!(providerId in providers)) throw new ConfigurationError(404, ErrorCodes.VALIDATION, 'Custom provider not found');
    const next = structuredClone(current.document);
    delete next.providers[providerId];
    return this.saveModelsConfig(next, revision);
  }

  private async saveCustomProvider(
    providerId: string,
    input: ProviderInput,
    previousId?: string,
    current?: { document: ModelsConfigDocument; revision: string },
  ) {
    const stored = current ?? await this.store.readUnsafe();
    const existing = previousId
      ? stored.document.providers[previousId] as Record<string, unknown> | undefined
      : undefined;
    const document = structuredClone(stored.document);
    if (previousId && previousId !== providerId) delete document.providers[previousId];
    document.providers[providerId] = customProviderDocument(providerId, input, existing);
    await this.saveModelsConfig(document, stored.revision);
    return previousId
      ? { provider: await this.requireProviderView(providerId) }
      : await this.requireProviderView(providerId);
  }

  async testModel(input: { provider?: string; model?: string }) {
    if (!input.provider || !input.model) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'provider and model are required');
    }
    const model = this.runtime.getModel(input.provider, input.model);
    if (!model) {
      throw new ConfigurationError(404, ErrorCodes.VALIDATION, 'Unknown model');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.runtime.completeSimple(
        model,
        {
          messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }],
          systemPrompt: 'This is a connectivity test. Reply with OK only.',
          tools: [],
        },
        { signal: controller.signal, maxTokens: 8, maxRetries: 0 },
      );
      return {
        ok: response.stopReason !== 'error',
        provider: input.provider,
        model: input.model,
        stop_reason: response.stopReason,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  startOAuth(providerId: string) {
    const provider = this.requireProvider(providerId);
    if (!provider.auth.oauth) {
      throw new ConfigurationError(422, ErrorCodes.PROVIDER_UNSUPPORTED, 'OAuth is not supported by this provider');
    }
    const existing = [...this.flows.values()]
      .find((flow) => flow.provider === providerId && flow.status === 'pending');
    if (existing) return this.oauthView(existing);
    const id = randomUUID();
    const controller = new AbortController();
    const flow: OAuthFlow = {
      id,
      provider: providerId,
      status: 'pending',
      events: [],
      contextEvents: [],
      controller,
      expiresAt: Date.now() + OAUTH_FLOW_TTL_MS,
    };
    this.flows.set(id, flow);
    void this.runtime.login(providerId, 'oauth', {
      signal: controller.signal,
      notify: (event) => {
        flow.events.push(event);
        if (flow.events.length > MAX_OAUTH_EVENTS) flow.events.shift();
        if (event.type === 'auth_url' || event.type === 'device_code') {
          flow.contextEvents = [
            ...flow.contextEvents.filter((item) => item.type !== 'auth_url' && item.type !== 'device_code'),
            event,
          ];
        }
      },
      prompt: (prompt) => new Promise<string>((resolve, reject) => {
        flow.prompt = { id: randomUUID(), prompt, resolve, reject };
      }),
    }).then(
      () => this.finishOAuth(flow, 'authenticated'),
      (error) => this.finishOAuth(flow, controller.signal.aborted ? 'cancelled' : 'failed', error),
    );
    flow.expiryTimer = setTimeout(() => this.expireOAuth(id), OAUTH_FLOW_TTL_MS);
    flow.expiryTimer.unref();
    return this.oauthView(flow);
  }

  getOAuth(id: string) {
    return this.oauthView(this.requireFlow(id));
  }

  answerOAuth(id: string, promptId: string, value: string) {
    if (value.length > MAX_SECRET_LENGTH) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'OAuth response is too long');
    }
    const flow = this.requireFlow(id);
    if (!flow.prompt || flow.prompt.id !== promptId) {
      throw new ConfigurationError(409, ErrorCodes.CREDENTIAL_CHANGED, 'OAuth prompt is no longer active');
    }
    const prompt = flow.prompt;
    flow.prompt = undefined;
    prompt.resolve(value);
    return this.oauthView(flow);
  }
  cancelOAuth(id: string) {
    const flow = this.flows.get(id);
    if (!flow || flow.status !== 'pending') return { cancelled: false };
    flow.controller.abort();
    flow.prompt?.reject(new Error('Cancelled'));
    flow.prompt = undefined;
    this.finishOAuth(flow, 'cancelled');
    return { cancelled: true, status: flow.status };
  }

  private oauthView(flow: OAuthFlow) {
    return {
      flow_id: flow.id,
      provider: flow.provider,
      status: flow.status,
      events: flow.events.splice(0),
      context_events: flow.contextEvents,
      prompt: flow.prompt ? { id: flow.prompt.id, ...flow.prompt.prompt, signal: undefined } : undefined,
      expires_at: new Date(flow.expiresAt).toISOString(),
      error: flow.error,
    };
  }

  private requireFlow(id: string) {
    const flow = this.flows.get(id);
    if (!flow) throw new ConfigurationError(404, ErrorCodes.VALIDATION, 'OAuth flow not found');
    return flow;
  }

  private requireProvider(id: string) {
    const provider = this.runtime.getProvider(id);
    if (!provider) throw new ConfigurationError(404, ErrorCodes.VALIDATION, 'Unknown provider');
    return provider;
  }

  private async requireProviderView(id: string): Promise<ProviderView> {
    const view = (await this.visibleProviderViews()).find((provider) => provider.id === id);
    if (!view) throw new ConfigurationError(404, ErrorCodes.VALIDATION, 'Unknown provider');
    return view;
  }

  private async visibleProviderViews(): Promise<ProviderView[]> {
    const views = await providerViews(this.runtime);
    const configured = (await this.store.readUnsafe()).document.providers;
    return views.map((view) => {
      const ids = configuredModelIds(configured[view.id], view.id);
      if (!ids) return view;
      const models = view.models.filter((id) => ids.has(id));
      return { ...view, models, model_count: models.length };
    });
  }

  private async visibleAvailableModels() {
    const available = await this.runtime.getAvailable();
    const configured = (await this.store.readUnsafe()).document.providers;
    return available.filter((model) => {
      const providerId = String(model.provider);
      const ids = configuredModelIds(configured[providerId], providerId);
      return !ids || ids.has(model.id);
    });
  }

  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.mutations.set(key, next);
    void next.finally(() => {
      if (this.mutations.get(key) === next) this.mutations.delete(key);
    }).catch(() => undefined);
    return next;
  }

  private finishOAuth(flow: OAuthFlow, status: OAuthFlow['status'], error?: unknown) {
    if (this.flows.get(flow.id) !== flow) return;
    if (flow.status !== 'pending') return;
    flow.status = status;
    flow.prompt = undefined;
    if (status === 'authenticated') this.version += 1;
    if (status === 'failed') flow.error = redactText(error instanceof Error ? error.message : String(error));
    if (flow.expiryTimer) clearTimeout(flow.expiryTimer);
    flow.expiresAt = Date.now() + OAUTH_RESULT_TTL_MS;
    flow.cleanupTimer = setTimeout(() => this.deleteOAuth(flow), OAUTH_RESULT_TTL_MS);
    flow.cleanupTimer.unref();
  }

  private expireOAuth(id: string) {
    const flow = this.flows.get(id);
    if (!flow) return;
    if (flow.status === 'pending') {
      flow.controller.abort();
      flow.prompt?.reject(new Error('OAuth flow expired'));
      flow.prompt = undefined;
    }
    this.deleteOAuth(flow);
  }

  private deleteOAuth(flow: OAuthFlow) {
    if (flow.expiryTimer) clearTimeout(flow.expiryTimer);
    if (flow.cleanupTimer) clearTimeout(flow.cleanupTimer);
    if (this.flows.get(flow.id) === flow) this.flows.delete(flow.id);
  }
}

function resolveDefaultModel(
  available: Awaited<ReturnType<ModelRuntime['getAvailable']>>,
  requestedModel: string,
  requestedProvider: unknown,
) {
  if (typeof requestedProvider === 'string' && requestedProvider) {
    const direct = available.find((model) => model.provider === requestedProvider && model.id === requestedModel);
    if (direct) return direct;
    const prefix = `${requestedProvider}/`;
    if (requestedModel.startsWith(prefix)) {
      return available.find((model) => (
        model.provider === requestedProvider && model.id === requestedModel.slice(prefix.length)
      ));
    }
    return undefined;
  }

  const qualified = available.find((model) => `${model.provider}/${model.id}` === requestedModel);
  if (qualified) return qualified;
  const candidates = available.filter((model) => model.id === requestedModel);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function providerModelIds(runtime: ModelRuntime, providerIds: readonly string[]) {
  return new Map(providerIds.map((providerId) => [
    providerId,
    new Set(runtime.getProvider(providerId)?.getModels().map((model) => model.id) ?? []),
  ]));
}

function requireProviderId(value: unknown): string {
  if (typeof value !== 'string'
    || value.trim().length > MAX_PROVIDER_ID_LENGTH
    || !/^[\p{L}\p{N}][\p{L}\p{N}\-_ ]*$/u.test(value.trim())) {
    throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'A valid provider id is required');
  }
  return value.trim();
}

function customProviderDocument(providerId: string, input: ProviderInput, existing?: Record<string, unknown>) {
  const models = requireProviderModels(input.models, providerId);
  const api = piApiForWireType(input.type);
  const baseUrl = stringOrUndefined(input.base_url) ?? stringOrUndefined(existing?.baseUrl);
  const apiKey = secretOrUndefined(input.api_key) ?? existing?.apiKey;
  const defaultModel = stringOrUndefined(input.default_model) ?? stringOrUndefined(existing?.defaultModel);
  return {
    ...(existing ?? {}),
    api,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    models,
  };
}

function requireProviderModels(value: unknown, providerId: string) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'At least one model is required');
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, `Model ${index + 1} must be an object`);
    }
    const model = entry as ProviderModelInput;
    if (typeof model.model !== 'string' || !model.model.trim()) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, `Model ${index + 1} requires an id`);
    }
    const contextWindow = positiveInteger(model.max_context_size, `Model ${index + 1} context size`);
    const maxTokens = model.max_output_size === undefined
      ? undefined
      : positiveInteger(model.max_output_size, `Model ${index + 1} output size`);
    const capabilities = Array.isArray(model.capabilities)
      ? model.capabilities.filter((capability): capability is string => typeof capability === 'string')
      : [];
    const rawId = model.model.trim();
    const prefix = `${providerId}/`;
    return {
      id: rawId.startsWith(prefix) ? rawId.slice(prefix.length) : rawId,
      ...(stringOrUndefined(model.display_name) ? { name: stringOrUndefined(model.display_name) } : {}),
      reasoning: capabilities.includes('thinking'),
      input: capabilities.includes('image_input') ? ['text', 'image'] : ['text'],
      contextWindow,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    };
  });
}

function requireDefaultPermissionMode(value: unknown): DefaultPermissionMode {
  if (value === 'manual' || value === 'auto' || value === 'yolo') return value;
  throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'default_permission_mode must be manual, auto, or yolo');
}

function configuredModelIds(value: unknown, providerId: string): Set<string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const models = (value as { models?: unknown }).models;
  if (!Array.isArray(models)) return undefined;
  const prefix = `${providerId}/`;
  return new Set(models.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string') return [];
    return [id.startsWith(prefix) ? id.slice(prefix.length) : id];
  }));
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ConfigurationError(400, ErrorCodes.VALIDATION, `${label} must be a positive integer`);
  }
  return value;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function secretOrUndefined(value: unknown): string | undefined {
  const secret = stringOrUndefined(value);
  if (secret && secret.length > MAX_SECRET_LENGTH) {
    throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'API key is too long');
  }
  return secret;
}
