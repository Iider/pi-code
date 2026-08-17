// Pure translation: pi agent messages/events → kimi-web wire shapes.
//
// Two exports:
//  - piMessagesToWire()        snapshot / messages endpoint payloads
//  - translatePiEvent()        live AgentSessionEvent → raw agent-core frames
//
// The web client's agentEventProjector consumes raw agent-core events
// (turn.started, assistant.delta, tool.call.started, …) and does the UI
// projection itself, so this module only has to speak that vocabulary.

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { WireMessage, WireMessageContent } from './wire.ts';

// ---------------------------------------------------------------------------
// Message translation (snapshot path)
// ---------------------------------------------------------------------------

function joinToolOutput(content: { type: string; text?: string }[]): string {
  return content
    .map((part) => (part.type === 'text' ? (part.text ?? '') : '[image]'))
    .join('\n');
}

export function piMessagesToWire(
  messages: AgentMessage[],
  sessionId: string,
  idOf: (m: AgentMessage, index: number) => string,
  promptIdOf: (m: AgentMessage, index: number) => string | undefined,
): WireMessage[] {
  const out: WireMessage[] = [];
  messages.forEach((message, index) => {
    const base = {
      id: idOf(message, index),
      session_id: sessionId,
      created_at: new Date(message.timestamp ?? Date.now()).toISOString(),
      prompt_id: promptIdOf(message, index),
    };
    if (message.role === 'user') {
      const content: WireMessageContent[] = [];
      if (typeof message.content === 'string') {
        content.push({ type: 'text', text: message.content });
      } else {
        for (const part of message.content) {
          if (part.type === 'text') content.push({ type: 'text', text: part.text });
          else if (part.type === 'image')
            content.push({
              type: 'image',
              source: { kind: 'base64', media_type: part.mimeType, data: part.data },
            });
        }
      }
      if (content.length === 0) return;
      out.push({ ...base, role: 'user', content });
    } else if (message.role === 'assistant') {
      const content: WireMessageContent[] = [];
      for (const part of message.content) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text });
        else if (part.type === 'thinking')
          content.push({ type: 'thinking', thinking: part.thinking, signature: part.thinkingSignature });
        else if (part.type === 'toolCall')
          content.push({
            type: 'tool_use',
            tool_call_id: part.id,
            tool_name: part.name,
            input: part.arguments,
          });
      }
      if (content.length === 0) return;
      out.push({
        ...base,
        role: 'assistant',
        content,
        metadata: { model: `${message.provider}/${message.model}` },
      });
    } else if (message.role === 'toolResult') {
      out.push({
        ...base,
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            tool_call_id: message.toolCallId,
            output: joinToolOutput(message.content as { type: string; text?: string }[]),
            is_error: message.isError,
          },
        ],
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Event translation (live path)
// ---------------------------------------------------------------------------

/** Per-session mutable state shared between the bridge and the translator. */
export interface TranslationState {
  turnCounter: number;
  currentTurnId: number | undefined;
  currentPromptId: string | undefined;
  /** Usage of the most recent assistant message (feeds turn.step.completed). */
  lastUsage: { input: number; output: number; cacheRead: number; cacheCreate: number };
  runStartedAt: number | undefined;
}

export function createTranslationState(): TranslationState {
  return { turnCounter: 0, currentTurnId: undefined, currentPromptId: undefined, lastUsage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }, runStartedAt: undefined };
}

/** An emitted frame before the bridge stamps seq/session_id/timestamp. */
export interface EmittedEvent {
  type: string;
  payload: Record<string, unknown>;
  /** true for projected protocol events (event.*), false for raw agent-core. */
  protocol?: boolean;
}

function usageOf(message: { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
} {
  const u = message.usage;
  return { input: u?.input ?? 0, output: u?.output ?? 0, cacheRead: u?.cacheRead ?? 0, cacheCreate: u?.cacheWrite ?? 0 };
}

/**
 * Translate one AgentSessionEvent into zero or more wire events.
 * `state` is mutated (turn counters, prompt binding, usage tracking).
 */
export function translatePiEvent(event: AgentSessionEvent, state: TranslationState): EmittedEvent[] {
  const out: EmittedEvent[] = [];
  switch (event.type) {
    case 'agent_start': {
      state.turnCounter += 1;
      state.currentTurnId = state.turnCounter;
      state.runStartedAt = Date.now();
      out.push({ type: 'turn.started', payload: { turnId: state.currentTurnId } });
      out.push({
        type: 'event.session.work_changed',
        protocol: true,
        payload: { busy: true, main_turn_active: true, pending_interaction: 'none' },
      });
      break;
    }
    case 'turn_start': {
      out.push({ type: 'turn.step.started', payload: { turnId: state.currentTurnId } });
      break;
    }
    case 'message_update': {
      const delta = event.assistantMessageEvent;
      if (delta.type === 'text_delta') {
        out.push({ type: 'assistant.delta', payload: { turnId: state.currentTurnId, delta: delta.delta } });
      } else if (delta.type === 'thinking_delta') {
        out.push({ type: 'thinking.delta', payload: { turnId: state.currentTurnId, delta: delta.delta } });
      }
      break;
    }
    case 'message_end': {
      if (event.message.role === 'assistant') {
        state.lastUsage = usageOf(event.message);
        if (event.message.stopReason === 'error') {
          out.push({
            type: 'error',
            payload: {
              message: event.message.errorMessage ?? 'Model request failed',
              name: 'ProviderError',
              retryable: true,
            },
          });
        }
      }
      break;
    }
    case 'tool_execution_start': {
      out.push({
        type: 'tool.call.started',
        payload: {
          turnId: state.currentTurnId,
          toolCallId: event.toolCallId,
          name: event.toolName,
          args: event.args,
        },
      });
      break;
    }
    case 'tool_execution_update': {
      const partial = event.partialResult as { text?: string; stream?: string; output?: string } | undefined;
      const text = partial?.text ?? partial?.output;
      if (typeof text === 'string' && text.length > 0) {
        out.push({
          type: 'tool.progress',
          payload: {
            toolCallId: event.toolCallId,
            update: { text, stream: partial?.stream === 'stderr' ? 'stderr' : 'stdout' },
          },
        });
      }
      break;
    }
    case 'tool_execution_end': {
      const content = (event.result?.content ?? []) as { type: string; text?: string }[];
      out.push({
        type: 'tool.result',
        payload: {
          turnId: state.currentTurnId,
          toolCallId: event.toolCallId,
          output: joinToolOutput(content),
          isError: event.isError,
        },
      });
      break;
    }
    case 'turn_end': {
      out.push({
        type: 'turn.step.completed',
        payload: { turnId: state.currentTurnId, usage: state.lastUsage },
      });
      break;
    }
    case 'agent_end': {
      const last = [...event.messages].reverse().find((m) => m.role === 'assistant');
      const stop = last && last.role === 'assistant' ? last.stopReason : 'stop';
      const reason = stop === 'aborted' ? 'cancelled' : stop === 'error' ? 'failed' : 'completed';
      const durationMs = state.runStartedAt !== undefined ? Date.now() - state.runStartedAt : undefined;
      out.push({
        type: 'turn.ended',
        payload: { reason, ...(durationMs !== undefined ? { durationMs } : {}) },
      });
      if (state.currentPromptId !== undefined) {
        out.push({ type: 'prompt.completed', payload: { promptId: state.currentPromptId, reason } });
        state.currentPromptId = undefined;
      }
      out.push({
        type: 'event.session.work_changed',
        protocol: true,
        payload: {
          busy: false,
          main_turn_active: false,
          pending_interaction: 'none',
          last_turn_reason: reason,
        },
      });
      state.currentTurnId = undefined;
      state.runStartedAt = undefined;
      break;
    }
    case 'compaction_start': {
      out.push({
        type: 'compaction.started',
        payload: { trigger: event.reason === 'manual' ? 'manual' : 'auto' },
      });
      break;
    }
    case 'compaction_end': {
      out.push({
        type: 'compaction.completed',
        payload: { result: event.result ?? {} },
      });
      break;
    }
    case 'session_info_changed': {
      out.push({ type: 'session.meta.updated', payload: { patch: { title: event.name ?? '' } } });
      break;
    }
    default:
      // agent_settled, queue_update, thinking_level_changed, entry_appended,
      // auto_retry_*, bash_execution_update … have no first-class web mapping.
      break;
  }
  return out;
}
