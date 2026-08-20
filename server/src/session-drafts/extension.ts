import { Type } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { SessionDraftStore } from './store.ts';

export const SESSION_DRAFT_TOOL = 'session_draft';
export const SESSION_DRAFT_SETTINGS_TYPE = 'pi-code.session-draft.settings';
export const SESSION_DRAFT_CAPABILITY = '<session-capability name="draft">Use session_draft for provisional plans or documents. Publish only when the user explicitly requests it.</session-capability>';

export function excerptOf(content: string, limit = 120): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  const segments = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(normalized)];
  return segments.slice(0, limit).map((item) => item.segment).join('') + (segments.length > limit ? '…' : '');
}

export function createSessionDraftExtension(options: { sessionId: string; cwd: string; store: SessionDraftStore; enabled: () => boolean }) {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: SESSION_DRAFT_TOOL,
      label: 'Session draft',
      description: 'Create, list, read, update, or request publishing of provisional documents isolated to this session.',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('create'), Type.Literal('list'), Type.Literal('read'), Type.Literal('update'), Type.Literal('request_publish')]),
        draftId: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        expectedRevision: Type.Optional(Type.Number()),
        targetPath: Type.Optional(Type.String()),
        overwrite: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params) {
        if (!options.enabled()) throw new Error('Session drafts are disabled');
        const { store, sessionId } = options;
        if (params.action === 'list') {
          const drafts = await store.list(sessionId);
          return { content: [{ type: 'text', text: JSON.stringify({ status: 'listed', drafts }) }], details: undefined };
        }
        if (params.action === 'create') {
          if (!params.title || params.content === undefined) throw new Error('create requires title and content');
          return result('created', await store.create(sessionId, params.title, params.content));
        }
        if (!params.draftId) throw new Error(`${params.action} requires draftId`);
        if (params.action === 'read') return result('read', await store.read(sessionId, params.draftId), true);
        if (params.action === 'request_publish') {
          if (params.expectedRevision === undefined || !params.targetPath) throw new Error('request_publish requires expectedRevision and targetPath');
          const published = await store.publish({
            sessionId,
            draftId: params.draftId,
            revision: params.expectedRevision,
            targetPath: params.targetPath,
            cwd: options.cwd,
            overwrite: params.overwrite === true,
          });
          return result('published', published, false, { path: published.path, overwritten: published.overwritten });
        }
        if (params.content === undefined || params.expectedRevision === undefined) throw new Error('update requires content and expectedRevision');
        return result('updated', await store.update(sessionId, params.draftId, params.expectedRevision, params.content, params.title));
      },
    });

    pi.on('context', (event) => {
      if (!options.enabled()) return;
      const messages = compressDraftHistory(event.messages);
      const lastUser = messages.findLastIndex((message) => message.role === 'user');
      const capability = { role: 'user', content: SESSION_DRAFT_CAPABILITY, timestamp: Date.now() } as AgentMessage;
      messages.splice(lastUser < 0 ? messages.length : lastUser, 0, capability);
      return { messages };
    });

    pi.on('session_before_compact', (event) => {
      event.preparation.messagesToSummarize = compressDraftHistory(event.preparation.messagesToSummarize, true);
      event.preparation.turnPrefixMessages = compressDraftHistory(event.preparation.turnPrefixMessages, true);
    });
  };
}

export function compressDraftHistory(messages: AgentMessage[], all = false): AgentMessage[] {
  const result = structuredClone(messages);
  const boundary = all ? result.length : result.findLastIndex((message) => message.role === 'user');
  const draftCalls = new Set<string>();
  for (let index = 0; index < boundary; index++) {
    const message = result[index];
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type !== 'toolCall' || part.name !== SESSION_DRAFT_TOOL) continue;
        draftCalls.add(part.id);
        const args = part.arguments as Record<string, unknown>;
        if (typeof args.content === 'string') {
          part.arguments = { ...args, content: `[draft content omitted; ${Buffer.byteLength(args.content)} bytes]` };
        }
      }
    }
    if (message?.role === 'toolResult' && draftCalls.has(message.toolCallId)) {
      const text = message.content.find((part) => part.type === 'text');
      if (!text || text.type !== 'text') continue;
      try {
        const metadata = JSON.parse(text.text) as Record<string, unknown>;
        delete metadata.content;
        text.text = JSON.stringify(metadata);
      } catch { /* Preserve malformed native output for diagnostics. */ }
    }
  }
  return result;
}

function result(
  status: 'created' | 'read' | 'updated' | 'published',
  value: Awaited<ReturnType<SessionDraftStore['read']>>,
  includeContent = false,
  extra: Record<string, unknown> = {},
) {
  const metadata = {
    status,
    draftId: value.draftId,
    title: value.draft.title,
    revision: value.revision,
    excerpt: excerptOf(value.content),
    digest: value.digest,
    ...(includeContent ? { content: value.content } : {}),
    ...extra,
  };
  return { content: [{ type: 'text' as const, text: JSON.stringify(metadata) }], details: undefined };
}
