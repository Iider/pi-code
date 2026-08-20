import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/routes.ts';

describe('uploaded file routes', () => {
  const token = 'file-route-token';
  let app: ReturnType<typeof buildApp>;
  let submitPrompt: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    submitPrompt = vi.fn().mockResolvedValue({
      prompt_id: 'prompt-1',
      user_message_id: 'message-1',
      status: 'running',
    });
    app = buildApp({
      bridge: { submitPrompt } as never,
      token,
      bypassAuth: false,
      workspaceRoots: new Set(),
      modelConfiguration: {} as never,
    });
  });

  afterEach(async () => app.close());

  it('uploads, serves, and resolves a file attachment to a local agent-readable path', async () => {
    const boundary = 'pi-code-test-boundary';
    const data = Buffer.from('{"question":"answer"}');
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.json"\r\nContent-Type: application/json\r\n\r\n`),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const uploaded = await app.inject({
      method: 'POST',
      url: '/api/v1/files',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });

    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.json().data).toMatchObject({
      name: 'sample.json',
      media_type: 'application/json',
      size: data.byteLength,
    });
    const fileId = uploaded.json().data.id as string;

    const downloaded = await app.inject({
      method: 'GET',
      url: `/api/v1/files/${fileId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload).toEqual(data);

    const prompted = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions/session-1/prompts',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        content: [
          { type: 'text', text: 'Inspect this file.' },
          { type: 'file', file_id: fileId, name: 'sample.json', media_type: 'application/json', size: data.byteLength },
        ],
      },
    });
    expect(prompted.statusCode).toBe(200);
    expect(submitPrompt).toHaveBeenCalledWith(
      'session-1',
      expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: expect.stringContaining('Local path:') }),
      ]),
      { model: undefined },
    );
  });
});
