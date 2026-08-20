import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
      const content = await readFile(this.revisionPath(sessionId, draftId, target), 'utf8');
      return { ...this.makeRevision(draftId, target, content, draft.updatedAt), draft };
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
