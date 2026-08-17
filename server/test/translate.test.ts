import { describe, expect, it } from 'vitest';
import { createTranslationState, piMessagesToWire, translatePiEvent } from '../src/translate.ts';

function assistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: 'hello' }],
    usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, totalTokens: 18, cost: { total: 0.01 } },
    stopReason: 'stop',
    timestamp: 1_700_000_000_000,
    ...overrides,
  } as never;
}

describe('piMessagesToWire', () => {
  it('maps a string user message', () => {
    const wire = piMessagesToWire(
      [{ role: 'user', content: 'hi there', timestamp: 1 }, { role: 'user', content: 'again', timestamp: 2 }],
      'sess',
      (_m, i) => `msg_${i}`,
      () => 'pr_1',
    );
    expect(wire).toHaveLength(2);
    expect(wire[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'hi there' }], prompt_id: 'pr_1' });
  });

  it('maps assistant text/thinking/toolCall parts', () => {
    const message = assistantMessage({
      content: [
        { type: 'thinking', thinking: 'pondering' },
        { type: 'text', text: 'answer' },
        { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } },
      ],
    });
    const wire = piMessagesToWire([message], 'sess', () => 'm0', () => 'p0');
    expect(wire[0]?.content).toEqual([
      { type: 'thinking', thinking: 'pondering', signature: undefined },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', tool_call_id: 'tc1', tool_name: 'bash', input: { command: 'ls' } },
    ]);
  });

  it('maps toolResult into a tool-role message', () => {
    const message = {
      role: 'toolResult',
      toolCallId: 'tc1',
      toolName: 'bash',
      content: [{ type: 'text', text: 'file-a\nfile-b' }],
      isError: false,
      timestamp: 1,
    } as never;
    const wire = piMessagesToWire([message], 'sess', () => 'm0', () => 'p0');
    expect(wire[0]).toMatchObject({ role: 'tool' });
    expect(wire[0]?.content[0]).toEqual({
      type: 'tool_result',
      tool_call_id: 'tc1',
      output: 'file-a\nfile-b',
      is_error: false,
    });
  });

  it('marks error tool results', () => {
    const message = {
      role: 'toolResult',
      toolCallId: 'tc9',
      toolName: 'bash',
      content: [{ type: 'text', text: 'boom' }],
      isError: true,
      timestamp: 1,
    } as never;
    const wire = piMessagesToWire([message], 'sess', () => 'm0', () => 'p0');
    expect(wire[0]?.content[0]).toMatchObject({ is_error: true });
  });
});

describe('translatePiEvent', () => {
  it('emits turn.started + work_changed(busy) on agent_start, incrementing turn ids', () => {
    const state = createTranslationState();
    const first = translatePiEvent({ type: 'agent_start' } as never, state);
    expect(first.map((e) => e.type)).toEqual(['turn.started', 'event.session.work_changed']);
    expect(first[0]?.payload['turnId']).toBe(1);
    expect(first[1]?.payload).toMatchObject({ busy: true, main_turn_active: true });

    const second = translatePiEvent({ type: 'agent_start' } as never, state);
    expect(second[0]?.payload['turnId']).toBe(2);
  });

  it('maps streaming deltas to assistant.delta / thinking.delta', () => {
    const state = createTranslationState();
    translatePiEvent({ type: 'agent_start' } as never, state);
    const text = translatePiEvent(
      { type: 'message_update', message: assistantMessage(), assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'wor', partial: assistantMessage() } } as never,
      state,
    );
    expect(text).toHaveLength(1);
    expect(text[0]).toMatchObject({ type: 'assistant.delta', payload: { delta: 'wor' } });

    const think = translatePiEvent(
      { type: 'message_update', message: assistantMessage(), assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hm', partial: assistantMessage() } } as never,
      state,
    );
    expect(think[0]).toMatchObject({ type: 'thinking.delta', payload: { delta: 'hm' } });
  });

  it('maps tool execution lifecycle', () => {
    const state = createTranslationState();
    translatePiEvent({ type: 'agent_start' } as never, state);
    const started = translatePiEvent(
      { type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'bash', args: { command: 'ls' } } as never,
      state,
    );
    expect(started[0]).toMatchObject({
      type: 'tool.call.started',
      payload: { toolCallId: 'tc1', name: 'bash', args: { command: 'ls' } },
    });

    const progress = translatePiEvent(
      { type: 'tool_execution_update', toolCallId: 'tc1', toolName: 'bash', args: {}, partialResult: { text: 'out', stream: 'stdout' } } as never,
      state,
    );
    expect(progress[0]?.payload).toMatchObject({ toolCallId: 'tc1', update: { text: 'out', stream: 'stdout' } });

    const done = translatePiEvent(
      { type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'bash', result: { content: [{ type: 'text', text: 'done' }] }, isError: false } as never,
      state,
    );
    expect(done[0]?.payload).toMatchObject({ toolCallId: 'tc1', output: 'done', isError: false });
  });

  it('emits turn teardown with prompt binding on agent_end', () => {
    const state = createTranslationState();
    state.currentPromptId = 'pr_9';
    translatePiEvent({ type: 'agent_start' } as never, state);
    const events = translatePiEvent(
      { type: 'agent_end', messages: [assistantMessage()], willRetry: false } as never,
      state,
    );
    expect(events.map((e) => e.type)).toEqual([
      'turn.ended',
      'prompt.completed',
      'event.session.work_changed',
    ]);
    expect(events[0]?.payload['reason']).toBe('completed');
    expect(events[1]?.payload).toMatchObject({ promptId: 'pr_9', reason: 'completed' });
    expect(events[2]?.payload).toMatchObject({ busy: false, last_turn_reason: 'completed' });
    expect(state.currentPromptId).toBeUndefined();
  });

  it('maps aborted and error runs to cancelled / failed', () => {
    const aborted = createTranslationState();
    const abortedEvents = translatePiEvent(
      { type: 'agent_end', messages: [assistantMessage({ stopReason: 'aborted' })], willRetry: false } as never,
      aborted,
    );
    expect(abortedEvents[0]?.payload['reason']).toBe('cancelled');

    const failed = createTranslationState();
    const failedEvents = translatePiEvent(
      { type: 'agent_end', messages: [assistantMessage({ stopReason: 'error', errorMessage: 'boom' })], willRetry: false } as never,
      failed,
    );
    expect(failedEvents[0]?.payload['reason']).toBe('failed');
  });

  it('emits an error frame when an assistant message ends with stopReason error', () => {
    const state = createTranslationState();
    const events = translatePiEvent(
      { type: 'message_end', message: assistantMessage({ stopReason: 'error', errorMessage: 'rate limited' }) } as never,
      state,
    );
    expect(events[0]).toMatchObject({
      type: 'error',
      payload: { message: 'rate limited', name: 'ProviderError', retryable: true },
    });
  });

  it('carries usage into turn.step.completed via message_end tracking', () => {
    const state = createTranslationState();
    translatePiEvent({ type: 'agent_start' } as never, state);
    translatePiEvent(
      { type: 'message_end', message: assistantMessage() } as never,
      state,
    );
    const stepDone = translatePiEvent({ type: 'turn_end' } as never, state);
    expect(stepDone[0]?.payload['usage']).toEqual({ input: 10, output: 5, cacheRead: 2, cacheCreate: 1 });
  });
});
