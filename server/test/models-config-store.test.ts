import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ModelsConfigStore } from '../src/models/models-config-store.ts';

describe('ModelsConfigStore', () => {
  it('creates private files and preserves unknown fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-code-models-'));
    const store = new ModelsConfigStore(directory);
    const document = { providers: { custom: { baseUrl: 'https://example.test', models: [], futureField: { enabled: true } } }, futureRoot: 1 };
    const result = await store.write(document);
    expect(result.revision).toHaveLength(64);
    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual(document);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
  });

  it('rejects stale revisions without changing the file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-code-models-'));
    const store = new ModelsConfigStore(directory);
    await store.write({ providers: {} });
    const before = await store.readUnsafe();
    await writeFile(store.path, '{"providers":{"external":{"models":[]}}}\n');
    await expect(store.write({ providers: {} }, before.revision)).rejects.toMatchObject({ status: 409, code: 40910 });
    expect(await readFile(store.path, 'utf8')).toContain('external');
  });

  it('redacts secret-shaped fields from reads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-code-models-'));
    const store = new ModelsConfigStore(directory);
    await store.write({ providers: { custom: { apiKey: 'sk-sensitive', headers: { Authorization: 'Bearer sensitive' }, models: [] } } });
    expect(JSON.stringify((await store.read()).document)).not.toContain('sensitive');
  });

  it('preserves redacted secrets when the safe document is saved again', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-code-models-'));
    const store = new ModelsConfigStore(directory);
    const original = {
      providers: {
        custom: {
          apiKey: 'sk-sensitive-value',
          headers: { Authorization: 'Bearer sensitive-value' },
          models: [],
        },
      },
    };
    await store.write(original);
    const safe = await store.read();
    await store.write(safe.document, safe.revision);
    expect((await store.readUnsafe()).document).toEqual(original);
  });

  it('accepts the comments, trailing commas, and provider ids accepted by pi', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-code-models-'));
    const store = new ModelsConfigStore(directory);
    await writeFile(store.path, `{
      // pi accepts JSON comments and trailing commas.
      "providers": {
        "provider.with.dots": { "models": [], },
      },
    }\n`);

    expect((await store.readUnsafe()).document).toEqual({
      providers: { 'provider.with.dots': { models: [] } },
    });
  });

  it('rejects invalid pi schemas without replacing the original file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-code-models-'));
    const store = new ModelsConfigStore(directory);
    const original = {
      providers: {
        custom: {
          api: 'openai-completions',
          baseUrl: 'https://example.test/v1',
          models: [{ id: 'working-model' }],
        },
      },
    };
    await store.write(original);

    await expect(store.write({ providers: { broken: { models: [{}] } } }))
      .rejects.toMatchObject({ status: 400, code: 40001 });
    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual(original);
  });
});
