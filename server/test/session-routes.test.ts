import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/routes.ts';
import { workspaceIdFor } from '../src/bridge.ts';

describe('session collection routes', () => {
  const token = 'session-route-token';
  const workspaceRoot = 'C:\\workspaces\\alpha';
  const otherWorkspaceRoot = 'C:\\workspaces\\beta';
  const sessions = [
    session('session-5', workspaceRoot),
    session('session-4', otherWorkspaceRoot),
    session('session-3', workspaceRoot),
    session('session-2', workspaceRoot),
    session('session-1', workspaceRoot),
  ];
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    const bridge = {
      epoch: 'test-epoch',
      listSessions: vi.fn().mockResolvedValue(sessions),
      getEntry: vi.fn(),
    };
    app = buildApp({
      bridge: bridge as never,
      token,
      bypassAuth: false,
      // Historical session directories are exposed as workspaces even when
      // they were not explicitly registered in this process.
      workspaceRoots: new Set<string>(),
      modelConfiguration: {} as never,
    });
  });

  afterEach(async () => app.close());

  const request = (url: string) => app.inject({
    method: 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
  });

  it('returns the page after before_id within the selected workspace', async () => {
    const workspaceId = workspaceIdFor(workspaceRoot);
    const first = await request(`/api/v1/sessions?workspace_id=${workspaceId}&page_size=2`);
    expect(first.json().data).toMatchObject({
      items: [{ id: 'session-5' }, { id: 'session-3' }],
      has_more: true,
    });

    const second = await request(
      `/api/v1/sessions?workspace_id=${workspaceId}&page_size=2&before_id=session-3`,
    );
    expect(second.json().data).toMatchObject({
      items: [{ id: 'session-2' }, { id: 'session-1' }],
      has_more: false,
    });
  });

  it('does not replay the first page when before_id is unknown', async () => {
    const response = await request('/api/v1/sessions?page_size=2&before_id=missing');
    expect(response.json().data).toEqual({ items: [], has_more: false });
  });
});

function session(id: string, cwd: string) {
  return {
    id,
    cwd,
    title: id,
    createdAt: new Date('2026-08-19T00:00:00.000Z'),
    updatedAt: new Date('2026-08-19T00:00:00.000Z'),
    messageCount: 1,
    archived: false,
    busy: false,
  };
}
