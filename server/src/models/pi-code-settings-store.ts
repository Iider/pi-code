import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { ErrorCodes } from '../envelope.ts';
import { ConfigurationError } from './errors.ts';

export type DefaultPermissionMode = 'manual' | 'auto' | 'yolo';

interface PiCodeSettingsDocument {
  defaultPermissionMode?: DefaultPermissionMode;
}

export class PiCodeSettingsStore {
  private queue = Promise.resolve();
  readonly path: string;

  constructor(agentDir = getAgentDir()) {
    this.path = join(agentDir, 'pi-code-settings.json');
  }

  async defaultPermissionMode(): Promise<DefaultPermissionMode> {
    return (await this.read()).defaultPermissionMode ?? 'manual';
  }

  updateDefaultPermissionMode(mode: DefaultPermissionMode): Promise<void> {
    const operation = this.queue.then(async () => {
      await this.write({ ...(await this.read()), defaultPermissionMode: mode });
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async read(): Promise<PiCodeSettingsDocument> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    try {
      return validate(JSON.parse(raw));
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'pi-code-settings.json is not valid JSON');
    }
  }

  private async write(settings: PiCodeSettingsDocument): Promise<void> {
    const raw = `${JSON.stringify(settings, null, 2)}\n`;
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporary = join(directory, `.pi-code-settings.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(raw, 'utf8');
      await handle.sync();
      await handle.close();
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

function validate(value: unknown): PiCodeSettingsDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'pi-code settings must be an object');
  }
  const mode = (value as Record<string, unknown>).defaultPermissionMode;
  if (mode !== undefined && mode !== 'manual' && mode !== 'auto' && mode !== 'yolo') {
    throw new ConfigurationError(400, ErrorCodes.VALIDATION, 'defaultPermissionMode must be manual, auto, or yolo');
  }
  return { defaultPermissionMode: mode as DefaultPermissionMode | undefined };
}
