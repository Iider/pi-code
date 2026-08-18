import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export interface ProviderView {
  id: string;
  type: string;
  base_url?: string;
  default_model?: string;
  has_api_key: boolean;
  status: 'connected' | 'error' | 'unconfigured' | 'unsupported';
  models: string[];

  // Pi Code-only metadata. The official WebUI ignores these fields, while
  // credential operations use them to preserve pi agent's native semantics.
  display_name: string;
  auth_source?: string;
  credential_type?: string;
  supports_api_key: boolean;
  supports_oauth: boolean;
  model_count: number;
  refreshable: boolean;
}

export async function providerViews(runtime: ModelRuntime): Promise<ProviderView[]> {
  const credentials = new Map((await runtime.listCredentials()).map((item) => [item.providerId, item.type]));
  const signal = AbortSignal.timeout(10_000);

  return Promise.all(runtime.getProviders().map(async (provider) => {
    const auth = runtime.getProviderAuthStatus(provider.id);
    let connected = auth.configured;
    if (auth.configured) {
      try {
        connected = Boolean(await runtime.checkAuth(provider.id, { signal }));
      } catch {
        connected = false;
      }
    }

    const models = provider.getModels();
    const defaultModel = models[0];
    return {
      id: provider.id,
      type: providerWireType(provider),
      base_url: provider.baseUrl ?? defaultModel?.baseUrl,
      has_api_key: auth.configured,
      status: providerStatus(connected, auth.configured, Boolean(provider.auth.apiKey || provider.auth.oauth)),
      models: models.map((model) => model.id),
      display_name: provider.name,
      auth_source: authSource(auth.source, auth.configured),
      credential_type: credentials.get(provider.id),
      supports_api_key: Boolean(provider.auth.apiKey?.login),
      supports_oauth: Boolean(provider.auth.oauth),
      model_count: models.length,
      refreshable: Boolean(provider.refreshModels),
    };
  }));
}

export function catalogProviderView(provider: Provider) {
  const models = provider.getModels();
  const supportsApiKey = Boolean(provider.auth.apiKey?.login);
  const supportsOAuth = Boolean(provider.auth.oauth);
  return {
    id: provider.id,
    name: provider.name,
    wire_type: providerWireType(provider),
    guessed: false,
    needs_base_url: false,
    rejected: !supportsApiKey,
    reject_reason: supportsApiKey ? undefined : supportsOAuth ? 'oauth-only' : 'proprietary-sdk',
    supports_oauth: supportsOAuth,
    auth_type: supportsApiKey ? 'api_key' : supportsOAuth ? 'oauth' : undefined,
    env_key: undefined,
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      max_context_size: model.contextWindow,
      capabilities: modelCapabilities(model),
      reasoning: model.reasoning,
    })),
  };
}

export function configModelViews(models: readonly Model<Api>[]) {
  return Object.fromEntries(models.map((model) => [
    `${model.provider}/${model.id}`,
    {
      provider: String(model.provider),
      model: `${model.provider}/${model.id}`,
      displayName: model.name,
      maxContextSize: model.contextWindow,
      capabilities: modelCapabilities(model),
      supportEfforts: supportedEfforts(model),
      adaptiveThinking: model.reasoning,
    },
  ]));
}

export function providerWireType(provider: Provider): string {
  return wireTypeForApi(provider.getModels()[0]?.api);
}

export function wireTypeForApi(api: Api | undefined): string {
  if (api === 'anthropic-messages') return 'anthropic';
  if (api === 'openai-responses' || api === 'azure-openai-responses' || api === 'openai-codex-responses') {
    return 'openai_responses';
  }
  if (api === 'google-generative-ai') return 'google-genai';
  if (api === 'google-vertex') return 'vertexai';
  return 'openai';
}

export function piApiForWireType(type: unknown): Api {
  switch (type) {
    case 'anthropic': return 'anthropic-messages';
    case 'openai_responses': return 'openai-responses';
    case 'google-genai': return 'google-generative-ai';
    case 'vertexai': return 'google-vertex';
    case 'kimi': return 'openai-completions';
    case 'openai': return 'openai-completions';
    default: return 'openai-completions';
  }
}

function providerStatus(connected: boolean, configured: boolean, supportsAuth: boolean): ProviderView['status'] {
  if (connected) return 'connected';
  if (configured) return 'error';
  return supportsAuth ? 'unconfigured' : 'unsupported';
}

function authSource(source: string | undefined, configured: boolean) {
  if (source === 'environment' || source === 'runtime' || source === 'stored'
    || source === 'models_json_key' || source === 'models_json_command') return source;
  return configured ? 'configured' : undefined;
}

function modelCapabilities(model: Model<Api>): string[] {
  return [
    'tool_use',
    ...(model.reasoning ? ['thinking'] : []),
    ...(model.input.includes('image') ? ['image_input'] : []),
  ];
}

function supportedEfforts(model: Model<Api>): string[] {
  const map = model.thinkingLevelMap;
  if (!model.reasoning) return [];
  if (!map) return ['low', 'medium', 'high'];
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
    .filter((effort) => map[effort as keyof typeof map] !== null);
}
