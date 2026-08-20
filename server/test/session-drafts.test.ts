import { access, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { compressDraftHistory, excerptOf } from '../src/session-drafts/extension.ts';
import { DraftConflictError, DraftPublishError, SessionDraftStore } from '../src/session-drafts/store.ts';

describe('session draft store', () => {
  it('creates immutable revisions and rejects stale updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-drafts-'));
    const store = new SessionDraftStore(root);
    const created = await store.create('session-a', 'Plan', 'first body');
    const updated = await store.update('session-a', created.draftId, 1, 'second body');
    await expect(store.update('session-a', created.draftId, 1, 'stale body')).rejects.toBeInstanceOf(DraftConflictError);
    expect((await store.read('session-a', created.draftId, 1)).content).toBe('first body');
    expect(updated.revision).toBe(2);
    expect(await readFile(join(root, 'session-a', 'drafts', created.draftId, 'r000002.md'), 'utf8')).toBe('second body');
    expect(await store.list('session-b')).toEqual([]);
  });

  it('uses grapheme-safe excerpts', () => {
    expect(excerptOf('👨‍👩‍👧‍👦'.repeat(121))).toBe(`${'👨‍👩‍👧‍👦'.repeat(120)}…`);
  });

  it('publishes a fixed revision, copies forks, and trashes deleted sessions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-code-drafts-'));
    const workspace = await mkdtemp(join(tmpdir(), 'pi-code-workspace-'));
    const trash = await mkdtemp(join(tmpdir(), 'pi-code-trash-'));
    const store = new SessionDraftStore(root);
    const created = await store.create('source', 'Plan', 'revision one');
    const excluded = await store.create('source', 'Later', 'not visible at fork point');
    await store.update('source', created.draftId, 1, 'revision two');
    const published = await store.publish({
      sessionId: 'source', draftId: created.draftId, revision: 1,
      targetPath: 'docs/plan.md', cwd: workspace, overwrite: false,
    });
    expect(await readFile(join(workspace, 'docs', 'plan.md'), 'utf8')).toBe('revision one');
    expect(published.draft.published?.revision).toBe(1);

    await store.copySession('source', 'fork', new Set([created.draftId]));
    expect((await store.read('fork', created.draftId, 2)).content).toBe('revision two');
    expect((await store.list('fork'))[0]?.sessionId).toBe('fork');
    await expect(store.read('fork', excluded.draftId)).rejects.toThrow();
    await expect(store.publish({
      sessionId: 'fork', draftId: created.draftId, revision: 1,
      targetPath: '../outside.md', cwd: workspace, overwrite: false,
    })).rejects.toBeInstanceOf(DraftPublishError);

    await store.trashSession('source', trash);
    await expect(access(join(root, 'source'))).rejects.toThrow();
  });
});

describe('session draft context', () => {
  it('removes full content from settled turns but keeps the active turn', () => {
    const messages = [
      user('old'), assistantCall('call-old', 'secret old body'), toolResult('call-old', '{"status":"read","content":"secret old body"}'),
      user('current'), assistantCall('call-current', 'current body'), toolResult('call-current', '{"status":"read","content":"current body"}'),
    ];
    const compressed = compressDraftHistory(messages);
    expect(JSON.stringify(compressed)).not.toContain('secret old body');
    expect(JSON.stringify(compressed)).toContain('current body');
  });
});

const user = (content: string) => ({ role: 'user', content, timestamp: Date.now() }) as AgentMessage;
const assistantCall = (id: string, content: string) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'session_draft', arguments: { action: 'create', content } }], api: 'x', provider: 'x', model: 'x', usage: {}, stopReason: 'toolUse', timestamp: Date.now() }) as unknown as AgentMessage;
const toolResult = (id: string, text: string) => ({ role: 'toolResult', toolCallId: id, toolName: 'session_draft', content: [{ type: 'text', text }], isError: false, timestamp: Date.now() }) as AgentMessage;
