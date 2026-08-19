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
  let workspaceNames: Map<string, string>;
  let deleteArchivedSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    workspaceNames = new Map();
    deleteArchivedSession = vi.fn().mockResolvedValue(undefined);
    const bridge = {
      epoch: 'test-epoch',
      listSessions: vi.fn().mockResolvedValue(sessions),
      getEntry: vi.fn(),
      getWorkspaceName: vi.fn((root: string) => workspaceNames.get(root) ?? root.split('\\').at(-1)!),
      setWorkspaceName: vi.fn((root: string, name: string) => workspaceNames.set(root, name)),
      deleteArchivedSession,
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

  const request = async (url: string, options?: { method?: 'GET' | 'PATCH' | 'DELETE'; payload?: unknown }) => app.inject({
    method: options?.method ?? 'GET',
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: options?.payload,
  } as never);

  it('uses the directory name by default and returns a saved rename', async () => {
    const workspaceId = workspaceIdFor(workspaceRoot);
    const before = await request('/api/v1/workspaces');
    expect(before.json().data.items).toContainEqual(expect.objectContaining({
      id: workspaceId,
      name: 'alpha',
    }));

    const renamed = await request(`/api/v1/workspaces/${workspaceId}`, {
      method: 'PATCH',
      payload: { name: 'My project' },
    });
    expect(renamed.json().data).toMatchObject({ id: workspaceId, name: 'My project' });

    const after = await request('/api/v1/workspaces');
    expect(after.json().data.items).toContainEqual(expect.objectContaining({
      id: workspaceId,
      name: 'My project',
    }));
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

  it('deletes an archived session through the bridge', async () => {
    const response = await request('/api/v1/sessions/session-3', { method: 'DELETE' });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({ deleted: true });
    expect(deleteArchivedSession).toHaveBeenCalledWith('session-3');
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
