import { createHash, randomUUID } from 'node:crypto';
import { access, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const MAX_DRAFT_BYTES = 256 * 1024;
export const MAX_DRAFTS = 32;
export const MAX_REVISIONS = 100;

export interface SessionDraft {
  version: 1;
  id: string;
  sessionId: string;
  title: string;
  currentRevision: number;
  createdAt: string;
  updatedAt: string;
  published?: { revision: number; path: string; publishedAt: string };
}

export interface DraftRevision {
  draftId: string;
  revision: number;
  content: string;
  digest: string;
  createdAt: string;
}

interface DraftIndex { version: 1; drafts: SessionDraft[] }

export class DraftNotFoundError extends Error {}
export class DraftConflictError extends Error {}
export class DraftLimitError extends Error {}
export class DraftPublishError extends Error {}

export class SessionDraftStore {
  constructor(private readonly root: string) {}

  async list(sessionId: string): Promise<SessionDraft[]> {
    return (await this.readIndex(sessionId)).drafts;
  }

  async create(sessionId: string, title: string, content: string): Promise<DraftRevision & { draft: SessionDraft }> {
    this.validateContent(content);
    const index = await this.readIndex(sessionId);
    if (index.drafts.length >= MAX_DRAFTS) throw new DraftLimitError(`A session can contain at most ${MAX_DRAFTS} drafts`);
    const now = new Date().toISOString();
    const draft: SessionDraft = {
      version: 1,
      id: randomUUID(),
      sessionId,
      title: this.validateTitle(title),
      currentRevision: 1,
      createdAt: now,
      updatedAt: now,
    };
    const revision = this.makeRevision(draft.id, 1, content, now);
    await this.writeRevision(sessionId, revision);
    index.drafts.push(draft);
    await this.writeIndex(sessionId, index);
    return { ...revision, draft };
  }

  async read(sessionId: string, draftId: string, revision?: number): Promise<DraftRevision & { draft: SessionDraft }> {
    const draft = (await this.readIndex(sessionId)).drafts.find((item) => item.id === draftId);
    if (!draft) throw new DraftNotFoundError('Draft not found in this session');
    const target = revision ?? draft.currentRevision;
    try {
      const path = this.revisionPath(sessionId, draftId, target);
      const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      return { ...this.makeRevision(draftId, target, content, info.birthtime.toISOString()), draft };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new DraftNotFoundError('Draft revision not found');
      throw error;
    }
  }

  async update(sessionId: string, draftId: string, expectedRevision: number, content: string, title?: string): Promise<DraftRevision & { draft: SessionDraft }> {
    this.validateContent(content);
    const index = await this.readIndex(sessionId);
    const draft = index.drafts.find((item) => item.id === draftId);
    if (!draft) throw new DraftNotFoundError('Draft not found in this session');
    if (draft.currentRevision !== expectedRevision) {
      throw new DraftConflictError(`Draft is at revision ${draft.currentRevision}, expected ${expectedRevision}`);
    }
    if (draft.currentRevision >= MAX_REVISIONS) throw new DraftLimitError(`A draft can contain at most ${MAX_REVISIONS} revisions`);
    const now = new Date().toISOString();
    const revision = this.makeRevision(draftId, draft.currentRevision + 1, content, now);
    await this.writeRevision(sessionId, revision);
    draft.currentRevision = revision.revision;
    draft.updatedAt = now;
    if (title !== undefined) draft.title = this.validateTitle(title);
    await this.writeIndex(sessionId, index);
    return { ...revision, draft };
  }

  async listRevisions(sessionId: string, draftId: string): Promise<Array<Omit<DraftRevision, 'content'>>> {
    const draft = (await this.readIndex(sessionId)).drafts.find((item) => item.id === draftId);
    if (!draft) throw new DraftNotFoundError('Draft not found in this session');
    const revisions = [];
    for (let revision = 1; revision <= draft.currentRevision; revision++) {
      const value = await this.read(sessionId, draftId, revision);
      revisions.push({ draftId, revision, digest: value.digest, createdAt: value.createdAt });
    }
    return revisions.reverse();
  }

  async publish(input: { sessionId: string; draftId: string; revision: number; targetPath: string; cwd: string; overwrite: boolean }) {
    const target = isAbsolute(input.targetPath) ? resolve(input.targetPath) : resolve(input.cwd, input.targetPath);
    const within = relative(resolve(input.cwd), target);
    if (within.startsWith('..') || isAbsolute(within) || within === '') {
      throw new DraftPublishError('Draft target must be a file inside the session workspace');
    }
    const value = await this.read(input.sessionId, input.draftId, input.revision);
    const exists = await access(target).then(() => true, () => false);
    if (exists && !input.overwrite) throw new DraftPublishError('Target file already exists; retry with overwrite after user approval');
    await mkdir(dirname(target), { recursive: true });
    const temporary = join(dirname(target), `.${randomUUID()}.pi-code-draft.tmp`);
    await writeFile(temporary, value.content, { mode: 0o600 });
    try { await rename(temporary, target); }
    catch (error) { await rm(temporary, { force: true }); throw error; }
    const index = await this.readIndex(input.sessionId);
    const draft = index.drafts.find((item) => item.id === input.draftId)!;
    draft.published = { revision: input.revision, path: target, publishedAt: new Date().toISOString() };
    await this.writeIndex(input.sessionId, index);
    return { ...value, draft, path: target, overwritten: exists };
  }

  async copySession(sourceSessionId: string, targetSessionId: string, includedDraftIds?: Set<string>): Promise<void> {
    const source = this.sessionDir(sourceSessionId);
    if (!await access(source).then(() => true, () => false)) return;
    const target = this.sessionDir(targetSessionId);
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true, errorOnExist: true });
    const index = await this.readIndex(targetSessionId);
    if (includedDraftIds) {
      const excluded = index.drafts.filter((draft) => !includedDraftIds.has(draft.id));
      await Promise.all(excluded.map((draft) => rm(join(target, 'drafts', draft.id), { recursive: true, force: true })));
      index.drafts = index.drafts.filter((draft) => includedDraftIds.has(draft.id));
    }
    for (const draft of index.drafts) draft.sessionId = targetSessionId;
    await this.writeIndex(targetSessionId, index);
  }

  async trashSession(sessionId: string, trashRoot: string): Promise<void> {
    const source = this.sessionDir(sessionId);
    if (!await access(source).then(() => true, () => false)) return;
    await mkdir(trashRoot, { recursive: true });
    await rename(source, join(trashRoot, `${encodeURIComponent(sessionId)}-${Date.now()}`));
  }

  async cleanupTrash(trashRoot: string, maxAgeMs: number): Promise<void> {
    const entries = await readdir(trashRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const cutoff = Date.now() - maxAgeMs;
    await Promise.all(entries.map(async (name) => {
      const path = join(trashRoot, name);
      const info = await stat(path);
      if (info.mtimeMs < cutoff) await rm(path, { recursive: true, force: true });
    }));
  }

  private sessionDir(sessionId: string): string { return join(this.root, encodeURIComponent(sessionId)); }
  private indexPath(sessionId: string): string { return join(this.sessionDir(sessionId), 'index.json'); }
  private revisionPath(sessionId: string, draftId: string, revision: number): string {
    return join(this.sessionDir(sessionId), 'drafts', draftId, `r${String(revision).padStart(6, '0')}.md`);
  }
  private async readIndex(sessionId: string): Promise<DraftIndex> {
    try { return JSON.parse(await readFile(this.indexPath(sessionId), 'utf8')) as DraftIndex; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, drafts: [] };
      throw error;
    }
  }
  private async writeIndex(sessionId: string, index: DraftIndex): Promise<void> {
    const path = this.indexPath(sessionId);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  }
  private async writeRevision(sessionId: string, revision: DraftRevision): Promise<void> {
    const path = this.revisionPath(sessionId, revision.draftId, revision.revision);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, revision.content, { flag: 'wx', mode: 0o600 });
  }
  private makeRevision(draftId: string, revision: number, content: string, createdAt: string): DraftRevision {
    return { draftId, revision, content, digest: createHash('sha256').update(content).digest('hex'), createdAt };
  }
  private validateContent(content: string): void {
    if (!content.trim()) throw new DraftLimitError('Draft content cannot be empty');
    if (Buffer.byteLength(content) > MAX_DRAFT_BYTES) throw new DraftLimitError(`Draft content exceeds ${MAX_DRAFT_BYTES} bytes`);
  }
  private validateTitle(title: string): string {
    const value = title.replace(/\s+/g, ' ').trim();
    if (!value) throw new DraftLimitError('Draft title cannot be empty');
    return value.slice(0, 120);
  }
}
