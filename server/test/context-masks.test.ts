import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  CONTEXT_MASK_CUSTOM_TYPE,
  filterMaskedMessages,
  listContextMaskTurns,
} from '../src/context-masks.ts';

describe('context turn masks', () => {
  it('uses last-write-wins state and filters the complete user turn', () => {
    const firstUser = message('u1', user('question one'));
    const firstAssistant = message('a1', assistant('answer one'));
    const secondUser = message('u2', user('question two'));
    const toolAssistant = message('a2-tool', assistantTool('call-1'));
    const toolResult = message('t2', tool('call-1'));
    const secondAssistant = message('a2', assistant('answer two'));
    const branch: SessionEntry[] = [
      firstUser,
      firstAssistant,
      secondUser,
      toolAssistant,
      toolResult,
      secondAssistant,
      custom('m1', { version: 1, userEntryId: 'u2', endEntryId: 'a2', masked: true }),
    ];

    expect(listContextMaskTurns(branch)).toEqual([
      expect.objectContaining({ user_entry_id: 'u1', assistant_entry_id: 'a1', masked: false }),
      expect.objectContaining({
        user_entry_id: 'u2',
        assistant_entry_id: 'a2-tool',
        end_entry_id: 'a2',
        masked: true,
        has_tools: true,
      }),
    ]);
    expect(filterMaskedMessages(
      [firstUser.message, firstAssistant.message, secondUser.message, toolAssistant.message, toolResult.message, secondAssistant.message],
      branch,
    )).toEqual([firstUser.message, firstAssistant.message]);
    expect(filterMaskedMessages(
      structuredClone([secondUser.message, toolAssistant.message, toolResult.message, secondAssistant.message]),
      branch,
    )).toEqual([]);

    branch.push(custom('m2', { version: 1, userEntryId: 'u2', endEntryId: 'a2', masked: false }));
    expect(filterMaskedMessages([secondUser.message, secondAssistant.message], branch)).toHaveLength(2);
  });

  it('refuses first-time masking before an existing compaction', () => {
    const branch: SessionEntry[] = [
      message('u1', user('old question')),
      message('a1', assistant('old answer')),
      { type: 'compaction', id: 'c1', parentId: 'a1', timestamp: now, summary: 'summary', firstKeptEntryId: 'u2', tokensBefore: 10 },
      message('u2', user('new question')),
      message('a2', assistant('new answer')),
    ];

    expect(listContextMaskTurns(branch)).toEqual([
      expect.objectContaining({ assistant_entry_id: 'a1', can_toggle: false, unavailable_reason: 'compacted' }),
      expect.objectContaining({ assistant_entry_id: 'a2', can_toggle: true }),
    ]);
  });
});

const now = '2026-08-20T00:00:00.000Z';
const user = (text: string) => ({ role: 'user', content: text, timestamp: Date.now() }) as AgentMessage;
const assistant = (text: string) => ({
  role: 'assistant', content: [{ type: 'text', text }], api: 'x', provider: 'x', model: 'x', usage: {}, stopReason: 'stop', timestamp: Date.now(),
}) as AgentMessage;
const assistantTool = (id: string) => ({
  role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: {} }], api: 'x', provider: 'x', model: 'x', usage: {}, stopReason: 'toolUse', timestamp: Date.now(),
}) as AgentMessage;
const tool = (id: string) => ({ role: 'toolResult', toolCallId: id, toolName: 'read', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: Date.now() }) as AgentMessage;
const message = (id: string, value: AgentMessage) => ({ type: 'message', id, parentId: null, timestamp: now, message: value }) as SessionEntry & { type: 'message' };
const custom = (id: string, data: unknown) => ({ type: 'custom', id, parentId: null, timestamp: now, customType: CONTEXT_MASK_CUSTOM_TYPE, data }) as SessionEntry;
