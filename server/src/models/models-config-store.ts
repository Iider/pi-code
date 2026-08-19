import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { ErrorCodes } from '../envelope.ts';
import { ConfigurationError, redactConfig, restoreConfiguredSecrets } from './errors.ts';

export interface ModelsConfigDocument {
  providers: Record<string, unknown>;
  [key: string]: unknown;
}

export class ModelsConfigStore {
  private queue = Promise.resolve();
  readonly path: string;

  constructor(agentDir = getAgentDir()) {
    this.path = join(agentDir, 'models.json');
  }

  async read(): Promise<{ document: ModelsConfigDocument; revision: string }> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') raw = '{"providers":{}}';
      else throw error;
    }
    const document = parseDocument(raw);
    return { document: redactConfig(document) as ModelsConfigDocument, revision: revision(raw) };
  }

  async readUnsafe(): Promise<{ document: ModelsConfigDocument; revision: string }> {
    let raw = '{"providers":{}}';
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return { document: parseDocument(raw), revision: revision(raw) };
  }

  write(document: unknown, expectedRevision?: string): Promise<{ revision: string }> {
    const operation = this.queue.then(() => this.writeNow(document, expectedRevision));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async writeNow(value: unknown, expectedRevision?: string): Promise<{ revision: string }> {
    const current = await this.readUnsafe();
    if (expectedRevision && current.revision !== expectedRevision) {
      throw new ConfigurationError(409, ErrorCodes.CONFIG_CHANGED, 'models.json changed outside Pi Code; reload before saving');
    }
    const document = validateDocument(restoreConfiguredSecrets(value, current.document));
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const nonce = `${process.pid}.${randomBytes(6).toString('hex')}`;
    const temporary = join(directory, `.models.json.${nonce}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(raw, 'utf8');
      await handle.sync();
      await handle.close();
      await validateWithPiRuntime(temporary, directory, nonce);
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
      await syncDirectory(directory);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
    return { revision: revision(raw) };
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    // Windows does not support flushing a directory handle. The temporary
    // file itself was already flushed before the atomic rename, so only this
    // unsupported durability enhancement is skipped.
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
  } finally {
    await handle.close();
  }
}

function parseDocument(raw: string): ModelsConfigDocument {
  try {
    return validateDocument(JSON.parse(stripJsonComments(raw)));
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'models.json is not valid JSON');
  }
}

function validateDocument(value: unknown): ModelsConfigDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'models config must be an object');
  }
  const document = value as Record<string, unknown>;
  if (!document.providers || typeof document.providers !== 'object' || Array.isArray(document.providers)) {
    throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'models config requires a providers object');
  }
  for (const [id, provider] of Object.entries(document.providers as Record<string, unknown>)) {
    if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, `Provider ${id} must be an object`);
    }
    const models = (provider as Record<string, unknown>).models;
    if (models !== undefined && !Array.isArray(models)) {
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, `Provider ${id}.models must be an array`);
    }
  }
  return document as ModelsConfigDocument;
}

function revision(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function validateWithPiRuntime(modelsPath: string, directory: string, nonce: string): Promise<void> {
  const authPath = join(directory, `.models-validation-auth.${nonce}.json`);
  const storePath = join(directory, `.models-validation-store.${nonce}.json`);
  try {
    const runtime = await ModelRuntime.create({
      authPath,
      modelsPath,
      modelsStorePath: storePath,
      allowModelNetwork: false,
      refreshOnCreate: false,
    });
    const error = runtime.getError();
    if (!error) return;
    const detail = error.split('\n\nFile:')[0]?.trim() || 'models.json failed pi agent validation';
    throw new ConfigurationError(400, ErrorCodes.VALIDATION, detail);
  } finally {
    await Promise.all([unlink(authPath).catch(() => undefined), unlink(storePath).catch(() => undefined)]);
  }
}

// Match pi's models.json parser: allow // comments and trailing commas without
// altering quoted strings.
function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => match[0] === '"' ? match : '')
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ''));
}
