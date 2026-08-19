// PiBridge — the adapter core. Owns a registry of live pi AgentSessions and
// exposes them to the REST/WS layers in kimi-web's wire vocabulary.

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, basename, dirname, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  AgentSession,
  createAgentSession,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  VERSION,
} from '@earendil-works/pi-coding-agent';
import type { AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { newId } from './envelope.ts';
import { serverHomeDir } from './token.ts';
import {
  createTranslationState,
  piMessagesToWire,
  translatePiEvent,
  type TranslationState,
} from './translate.ts';

import { installApprovalGate, type ApprovalPolicy, type ApprovalRecord } from './approvals.ts';
import type { EventFrame, WireApprovalRequest, WireMessage, WireSession, WireSessionUsage } from './wire.ts';

const RING_SIZE = 512;

interface RunningTool {
  toolCallId: string;
  name: string;
  args: unknown;
}

export interface BridgeSession {
  id: string;
  file?: string;
  cwd: string;
  session: AgentSession;
  translation: TranslationState;
  ring: EventFrame[];
  seq: number;
  runningTools: Map<string, RunningTool>;
  approvals: Map<string, ApprovalRecord>;
  openedAt: number;
  createdAt: number;
  updatedAt: number;
  title?: string;
  lastPrompt?: string;
  parentSessionId?: string;
  childSessionKind?: 'fork' | 'side_chat';
  archived: boolean;
}

export interface SessionListItem {
  id: string;
  file: string;
  cwd: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  messageCount: number;
  firstMessage: string;
  parentSessionId?: string;
  childSessionKind?: 'fork' | 'side_chat';
  archived: boolean;
  busy: boolean;
}

type FrameListener = (sessionId: string, frame: EventFrame) => void;

interface SessionMeta {
  archived?: boolean;
  title?: string;
  childSessionKind?: 'fork' | 'side_chat';
}

export class SessionBusyError extends Error {
  constructor(sessionId: string) {
    super(`Session is busy and cannot be forked: ${sessionId}`);
  }
}

export class SessionNotPersistedError extends Error {
  constructor(sessionId: string) {
    super(`Session is not persisted and cannot be forked: ${sessionId}`);
  }
}

export class SessionForkPointError extends Error {
  constructor(entryId: string) {
    super(`Fork point must be a persisted user or assistant message: ${entryId}`);
  }
}

export class SessionNotArchivedError extends Error {
  constructor(sessionId: string) {
    super(`Session must be archived before it can be deleted: ${sessionId}`);
  }
}

export class SessionNothingToUndoError extends Error {
  constructor(sessionId: string) {
    super(`Session has no user turn left to undo: ${sessionId}`);
  }
}

const DEFAULT_SESSION_TITLES = new Set(['session', 'new session', '新会话']);

function isDefaultSessionTitle(title: string | undefined): boolean {
  return !title || DEFAULT_SESSION_TITLES.has(title.trim().toLocaleLowerCase());
}

function titleFromPrompt(prompt: string): string | undefined {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, 60) : undefined;
}

export interface BridgeOptions {
  workspaceRoot: string;
  approvalPolicy: ApprovalPolicy;
}

export class PiBridge {
  readonly epoch = newId('ep_');
  readonly serverId = newId('srv_');
  readonly startedAt = new Date().toISOString();
  readonly version: string;

  private readonly sessions = new Map<string, BridgeSession>();
  private readonly listeners = new Set<FrameListener>();
  private modelRuntime!: ModelRuntime;
  private meta: Record<string, SessionMeta> = {};
  private readonly metaFile: string;
  private workspaceNames: Record<string, string> = {};
  private readonly workspaceNamesFile: string;
  private readonly options: BridgeOptions;

  constructor(options: BridgeOptions) {
    this.options = options;
    // VERSION reads the pi package's package.json at runtime, which Bun-compiled
    // binaries can't resolve — fall back to our own version.
    this.version = VERSION && VERSION !== '0.0.0' ? `pi-code (pi ${VERSION})` : 'pi-code 0.1.0';
    this.metaFile = join(serverHomeDir(), 'meta.json');
    this.workspaceNamesFile = join(serverHomeDir(), 'workspace-names.json');
    try {
      if (existsSync(this.metaFile)) this.meta = JSON.parse(readFileSync(this.metaFile, 'utf8'));
    } catch {
      this.meta = {};
    }
    try {
      if (existsSync(this.workspaceNamesFile)) {
        this.workspaceNames = JSON.parse(readFileSync(this.workspaceNamesFile, 'utf8'));
      }
    } catch {
      this.workspaceNames = {};
    }
  }

  async init(): Promise<void> {
    this.modelRuntime = await ModelRuntime.create({});
  }

  /** Shared canonical runtime used by sessions and model configuration. */
  getModelRuntime(): ModelRuntime {
    return this.modelRuntime;
  }

  getWorkspaceName(root: string): string {
    return this.workspaceNames[root] ?? workspaceName(root);
  }

  setWorkspaceName(root: string, name: string): void {
    this.workspaceNames[root] = name;
    mkdirSync(dirname(this.workspaceNamesFile), { recursive: true });
    writeFileSync(this.workspaceNamesFile, JSON.stringify(this.workspaceNames, null, 2));
  }

  // -------------------------------------------------------------------------
  // Frames: seq allocation, ring buffer, fan-out
  // -------------------------------------------------------------------------

  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(
    entry: BridgeSession,
    type: string,
    payload: Record<string, unknown>,
    protocol = false,
    touchSession = true,
  ): EventFrame {
    entry.seq += 1;
    if (touchSession) entry.updatedAt = Date.now();
    const frame: EventFrame = {
      type,
      seq: entry.seq,
      session_id: entry.id,
      timestamp: new Date().toISOString(),
      epoch: this.epoch,
      payload,
    };
    entry.ring.push(frame);
    if (entry.ring.length > RING_SIZE) entry.ring.splice(0, entry.ring.length - RING_SIZE);
    for (const listener of this.listeners) listener(entry.id, frame);
    return frame;
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  private agentDir(): string {
    return getAgentDir();
  }

  private sessionDirFor(cwd: string): string {
    return SessionManager.create(cwd).getSessionDir();
  }

  /** Create a brand-new pi session rooted at cwd. */
  async createSession(input: { cwd?: string; title?: string; model?: string }): Promise<BridgeSession> {
    const cwd = input.cwd && isAbsolute(input.cwd) && existsSync(input.cwd) ? input.cwd : this.options.workspaceRoot;
    const sessionManager = SessionManager.create(cwd, this.sessionDirFor(cwd));
    sessionManager.newSession();
    const model = input.model ? this.resolveModel(input.model) : undefined;
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.agentDir(),
      modelRuntime: this.modelRuntime,
      sessionManager,
      ...(model ? { model: model as never } : {}),
    });
    const entry = this.registerSession(session, sessionManager.getSessionFile(), cwd);
    if (!isDefaultSessionTitle(input.title)) {
      entry.title = input.title?.trim();
      this.setMeta(entry.id, { title: entry.title });
    }
    return entry;
  }

  /** Open (or return the already-open) pi session for a session file. */
  async openSession(sessionId: string): Promise<BridgeSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const info = await this.findDiskSession(sessionId);
    if (!info) throw new SessionNotFoundError(sessionId);
    const sessionManager = SessionManager.open(info.file, this.sessionDirFor(info.cwd || this.options.workspaceRoot));
    const cwd = info.cwd || this.options.workspaceRoot;
    const { session } = await createAgentSession({
      cwd,
      agentDir: this.agentDir(),
      modelRuntime: this.modelRuntime,
      sessionManager,
    });
    const entry = this.registerSession(session, info.file, cwd, {
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      lastPrompt: info.firstMessage || undefined,
      parentSessionId: info.parentSessionId,
      childSessionKind: info.childSessionKind,
    });
    if (isDefaultSessionTitle(entry.title)) entry.title = undefined;
    return entry;
  }

  /** Clone the source session's active path into a new native pi session. */
  async forkSession(
    sessionId: string,
    title?: string,
    childSessionKind: 'fork' | 'side_chat' = 'fork',
  ): Promise<BridgeSession> {
    const source = await this.openSession(sessionId);
    if (source.session.isStreaming || source.runningTools.size > 0) {
      throw new SessionBusyError(sessionId);
    }
    if (!source.file || !existsSync(source.file)) {
      throw new SessionNotPersistedError(sessionId);
    }

    const sessionManager = SessionManager.forkFrom(
      source.file,
      source.cwd,
      dirname(source.file),
    );
    return this.registerForkedSession(source, sessionManager, title, childSessionKind);
  }

  /**
   * Fork from a persisted message.
   *
   * User message: branch right before it, so the question can be re-asked with
   * its preceding context intact. Assistant message: branch right after it, so
   * the completed reply becomes the new conversation's latest state.
   */
  async forkSessionFromEntry(sessionId: string, entryId: string, title?: string): Promise<BridgeSession> {
    const source = await this.openSession(sessionId);
    if (source.session.isStreaming || source.runningTools.size > 0) {
      throw new SessionBusyError(sessionId);
    }
    if (!source.file || !existsSync(source.file)) {
      throw new SessionNotPersistedError(sessionId);
    }
    const forkPoint = source.session.sessionManager.getEntry(entryId);
    if (
      forkPoint?.type !== 'message'
      || (forkPoint.message.role !== 'user' && forkPoint.message.role !== 'assistant')
    ) {
      throw new SessionForkPointError(entryId);
    }

    // Branching at the entry itself keeps it; branching at its parent drops it.
    const branchAt = forkPoint.message.role === 'assistant' ? forkPoint.id : forkPoint.parentId;
    let sessionManager: SessionManager;
    if (branchAt === null) {
      sessionManager = SessionManager.create(source.cwd, dirname(source.file));
      sessionManager.newSession({ parentSession: source.file });
    } else {
      const sourceManager = SessionManager.open(source.file, dirname(source.file));
      const forkedFile = sourceManager.createBranchedSession(branchAt);
      if (!forkedFile) throw new SessionNotPersistedError(sessionId);
      sessionManager = SessionManager.open(forkedFile, dirname(source.file));
    }
    return this.registerForkedSession(source, sessionManager, title, 'fork');
  }

  private async registerForkedSession(
    source: BridgeSession,
    sessionManager: SessionManager,
    title: string | undefined,
    childSessionKind: 'fork' | 'side_chat',
  ): Promise<BridgeSession> {
    const { session } = await createAgentSession({
      cwd: source.cwd,
      agentDir: this.agentDir(),
      modelRuntime: this.modelRuntime,
      sessionManager,
    });
    const now = new Date();
    const entry = this.registerSession(session, sessionManager.getSessionFile(), source.cwd, {
      createdAt: now,
      updatedAt: now,
      lastPrompt: source.lastPrompt,
      parentSessionId: source.id,
      childSessionKind,
    });
    const requestedTitle = title?.trim();
    entry.title = requestedTitle || this.toWireSession(source).title;
    entry.session.setSessionName(entry.title);
    this.setMeta(entry.id, { title: entry.title, childSessionKind });
    this.emit(entry, 'session.meta.updated', {
      patch: { title: entry.title, parentSessionId: source.id, childSessionKind },
    });
    return entry;
  }

  /** Adopt an externally constructed AgentSession (used by tests). */
  adoptSession(session: AgentSession, file: string | undefined, cwd: string): BridgeSession {
    return this.registerSession(session, file, cwd);
  }

  private registerSession(
    session: AgentSession,
    file: string | undefined,
    cwd: string,
    restored?: {
      createdAt: Date;
      updatedAt: Date;
      lastPrompt?: string;
      parentSessionId?: string;
      childSessionKind?: 'fork' | 'side_chat';
    },
  ): BridgeSession {
    const id = session.sessionId;
    const existing = this.sessions.get(id);
    if (existing) return existing;
    const meta = this.meta[id] ?? {};
    const entry: BridgeSession = {
      id,
      file,
      cwd,
      session,
      translation: createTranslationState(),
      ring: [],
      seq: 0,
      runningTools: new Map(),
      approvals: new Map(),
      openedAt: Date.now(),
      createdAt: restored?.createdAt.getTime() ?? Date.now(),
      updatedAt: restored?.updatedAt.getTime() ?? Date.now(),
      title: meta.title,
      lastPrompt: restored?.lastPrompt,
      parentSessionId: restored?.parentSessionId,
      childSessionKind: restored?.childSessionKind,
      archived: meta.archived ?? false,
    };
    this.sessions.set(id, entry);

    const originalUnsubscribe = session.subscribe((event) => this.handlePiEvent(entry, event));
    void originalUnsubscribe;

    installApprovalGate(session.agent, {
      sessionId: id,
      policy: this.options.approvalPolicy,
      turnId: () => entry.translation.currentTurnId,
      onApproval: (record) => {
        entry.approvals.set(record.wire.approval_id, record);
        this.emit(entry, 'event.approval.requested', record.wire as unknown as Record<string, unknown>, true);
        this.emit(
          entry,
          'event.session.work_changed',
          { busy: true, main_turn_active: true, pending_interaction: 'approval' },
          true,
        );
      },
      onSettled: (approvalId, decision) => {
        const record = entry.approvals.get(approvalId);
        entry.approvals.delete(approvalId);
        this.emit(
          entry,
          'event.approval.resolved',
          {
            approval_id: approvalId,
            decision,
            resolved_by: 'user',
            resolved_at: new Date().toISOString(),
          },
          true,
        );
        if (entry.approvals.size === 0 && !session.isStreaming) {
          this.emit(
            entry,
            'event.session.work_changed',
            { busy: false, main_turn_active: false, pending_interaction: 'none' },
            true,
          );
        }
      },
    });

    this.emit(entry, 'event.session.created', this.toWireSession(entry) as unknown as Record<string, unknown>, true, false);
    return entry;
  }

  private handlePiEvent(entry: BridgeSession, event: AgentSessionEvent): void {
    if (event.type === 'tool_execution_start') {
      entry.runningTools.set(event.toolCallId, { toolCallId: event.toolCallId, name: event.toolName, args: event.args });
    }
    if (event.type === 'tool_execution_end') {
      entry.runningTools.delete(event.toolCallId);
    }
    if (event.type === 'session_info_changed') {
      entry.title = event.name;
      this.setMeta(entry.id, { title: event.name ?? undefined });
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const stats = this.safeStats(entry);
      if (stats) this.emit(entry, 'agent.status.updated', {
        model: entry.session.model ? `${entry.session.model.provider}/${entry.session.model.id}` : undefined,
        contextTokens: stats.contextUsage?.tokens ?? undefined,
        maxContextTokens: stats.contextUsage?.contextWindow ?? undefined,
        thinkingEffort: entry.session.thinkingLevel,
      });
    }
    for (const emitted of translatePiEvent(event, entry.translation)) {
      this.emit(entry, emitted.type, emitted.payload, emitted.protocol ?? false);
    }
  }

  // -------------------------------------------------------------------------
  // Session queries
  // -------------------------------------------------------------------------

  private async findDiskSession(sessionId: string): Promise<{
    file: string;
    cwd: string;
    firstMessage: string;
    parentSessionId?: string;
    childSessionKind?: 'fork' | 'side_chat';
    createdAt: Date;
    updatedAt: Date;
  } | null> {
    const all = await this.listSessions();
    const hit = all.find((s) => s.id === sessionId);
    return hit
      ? {
          file: hit.file,
          cwd: hit.cwd,
          firstMessage: hit.firstMessage,
          parentSessionId: hit.parentSessionId,
          childSessionKind: hit.childSessionKind,
          createdAt: hit.createdAt,
          updatedAt: hit.updatedAt,
        }
      : null;
  }

  /** Live + on-disk pi sessions, newest first. */
  async listSessions(): Promise<SessionListItem[]> {
    const disk = await SessionManager.listAll().catch(() => []);
    const items: SessionListItem[] = [];
    const seen = new Set<string>();
    const sessionIdByPath = new Map(disk.map((info) => [resolve(info.path), info.id]));
    for (const info of disk) {
      seen.add(info.id);
      const meta = this.meta[info.id] ?? {};
      const live = this.sessions.get(info.id);
      items.push({
        id: info.id,
        file: info.path,
        cwd: info.cwd || this.options.workspaceRoot,
        title: !isDefaultSessionTitle(meta.title)
          ? meta.title!
          : !isDefaultSessionTitle(info.name)
            ? info.name!
            : titleFromPrompt(info.firstMessage) ?? 'Session',
        createdAt: info.created,
        updatedAt: info.modified,
        messageCount: info.messageCount,
        firstMessage: info.firstMessage,
        parentSessionId: info.parentSessionPath
          ? sessionIdByPath.get(resolve(info.parentSessionPath))
          : undefined,
        childSessionKind: info.parentSessionPath
          ? meta.childSessionKind ?? 'fork'
          : undefined,
        archived: meta.archived ?? false,
        busy: live?.session.isStreaming ?? false,
      });
    }
    for (const entry of this.sessions.values()) {
      if (seen.has(entry.id)) continue;
      items.push({
        id: entry.id,
        file: entry.file ?? '',
        cwd: entry.cwd,
        title: !isDefaultSessionTitle(entry.title)
          ? entry.title!
          : titleFromPrompt(entry.lastPrompt ?? '') ?? 'Session',
        createdAt: new Date(entry.createdAt),
        updatedAt: new Date(entry.updatedAt),
        messageCount: entry.session.messages.length,
        firstMessage: entry.lastPrompt ?? '',
        parentSessionId: entry.parentSessionId,
        childSessionKind: entry.childSessionKind,
        archived: entry.archived,
        busy: entry.session.isStreaming,
      });
    }
    items.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return items;
  }

  async listChildSessions(sessionId: string): Promise<SessionListItem[]> {
    await this.openSession(sessionId);
    return (await this.listSessions()).filter((session) => session.parentSessionId === sessionId);
  }

  getEntry(sessionId: string): BridgeSession | undefined {
    return this.sessions.get(sessionId);
  }

  private safeStats(entry: BridgeSession): ReturnType<AgentSession['getSessionStats']> | undefined {
    try {
      return entry.session.getSessionStats();
    } catch {
      return undefined;
    }
  }

  toWireSession(entry: BridgeSession): WireSession {
    const stats = this.safeStats(entry);
    const model = entry.session.model;
    const pendingApproval = entry.approvals.size > 0;
    const usage: WireSessionUsage = {
      input_tokens: stats?.tokens.input ?? 0,
      output_tokens: stats?.tokens.output ?? 0,
      cache_read_tokens: stats?.tokens.cacheRead ?? 0,
      cache_creation_tokens: stats?.tokens.cacheWrite ?? 0,
      total_cost_usd: stats?.cost ?? 0,
      context_tokens: stats?.contextUsage?.tokens ?? 0,
      context_limit: stats?.contextUsage?.contextWindow ?? (model?.contextWindow ?? 0),
      turn_count: Math.floor((stats?.assistantMessages ?? 0)),
    };
    return {
      id: entry.id,
      title: !isDefaultSessionTitle(entry.title)
        ? entry.title!
        : titleFromPrompt(entry.lastPrompt ?? '') ?? 'Session',
      created_at: new Date(entry.createdAt).toISOString(),
      updated_at: new Date(entry.updatedAt).toISOString(),
      busy: entry.session.isStreaming || pendingApproval,
      main_turn_active: entry.session.isStreaming,
      pending_interaction: pendingApproval ? 'approval' : 'none',
      archived: entry.archived,
      current_prompt_id: entry.translation.currentPromptId,
      last_prompt: entry.lastPrompt,
      metadata: {
        cwd: entry.cwd,
        ...(entry.parentSessionId && entry.childSessionKind === 'side_chat'
          ? { parent_session_id: entry.parentSessionId }
          : {}),
        ...(entry.parentSessionId && entry.childSessionKind === 'fork'
          ? { forked_from_session_id: entry.parentSessionId }
          : {}),
        ...(entry.childSessionKind ? { child_session_kind: entry.childSessionKind } : {}),
      },
      agent_config: {
        model: model ? `${model.provider}/${model.id}` : '',
        thinking: entry.session.thinkingLevel,
      },
      usage,
      permission_rules: [],
      message_count: entry.session.messages.length,
      last_seq: entry.seq,
    };
  }

  /** Full snapshot for GET /sessions/{id}/snapshot. */
  buildSnapshot(entry: BridgeSession): {
    as_of_seq: number;
    epoch: string;
    session: WireSession;
    messages: { items: WireMessage[]; has_more: boolean };
    in_flight_turn: null | {
      turn_id: number;
      assistant_text: string;
      thinking_text: string;
      running_tools: { tool_call_id: string; name: string; args?: unknown }[];
      current_prompt_id?: string;
    };
    pending_approvals: WireApprovalRequest[];
    pending_questions: unknown[];
  } {
    let promptCounter = 0;
    const entryIdByMessage = new Map<AgentMessage, string>();
    for (const sessionEntry of entry.session.sessionManager.buildContextEntries()) {
      if (sessionEntry.type === 'message') {
        entryIdByMessage.set(sessionEntry.message, sessionEntry.id);
      }
    }
    const idOf = (message: AgentMessage, index: number) =>
      entryIdByMessage.get(message) ?? `msg_${entry.id.slice(0, 8)}_${index}`;
    const promptIdOf = (m: AgentMessage) => {
      if (m.role === 'user') promptCounter += 1;
      return `pr_snap_${promptCounter}`;
    };
    const messages = piMessagesToWire(entry.session.messages, entry.id, idOf, promptIdOf);

    let inFlight: null | {
      turn_id: number;
      assistant_text: string;
      thinking_text: string;
      running_tools: { tool_call_id: string; name: string; args?: unknown }[];
      current_prompt_id?: string;
    } = null;
    if (entry.session.isStreaming) {
      const streaming = entry.session.agent.state.streamingMessage;
      let assistantText = '';
      let thinkingText = '';
      if (streaming && streaming.role === 'assistant') {
        for (const part of streaming.content) {
          if (part.type === 'text') assistantText += part.text;
          else if (part.type === 'thinking') thinkingText += part.thinking;
        }
      }
      inFlight = {
        turn_id: entry.translation.turnCounter,
        assistant_text: assistantText,
        thinking_text: thinkingText,
        running_tools: [...entry.runningTools.values()].map((t) => ({
          tool_call_id: t.toolCallId,
          name: t.name,
          args: t.args,
        })),
        current_prompt_id: entry.translation.currentPromptId,
      };
    }

    return {
      as_of_seq: entry.seq,
      epoch: this.epoch,
      session: this.toWireSession(entry),
      messages: { items: messages, has_more: false },
      in_flight_turn: inFlight,
      pending_approvals: [...entry.approvals.values()].map((r) => r.wire),
      pending_questions: [],
    };
  }

  // -------------------------------------------------------------------------
  // Prompt / control
  // -------------------------------------------------------------------------

  async submitPrompt(
    sessionId: string,
    content: { type: string; text?: string; source?: { kind: string; media_type?: string; data?: string } }[],
    overrides?: { model?: string },
  ): Promise<{ prompt_id: string; user_message_id: string; status: 'running' | 'queued' }> {
    const entry = await this.openSession(sessionId);
    const text = content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
    if (text.length === 0) throw new Error('Prompt has no text content');
    const images: ImageContent[] = [];
    for (const part of content) {
      if (part.type === 'image' && part.source?.kind === 'base64' && part.source.data) {
        images.push({ type: 'image', data: part.source.data, mimeType: part.source.media_type ?? 'image/png' });
      }
    }

    if (overrides?.model) {
      const model = this.resolveModel(overrides.model);
      if (model) await entry.session.setModel(model as never);
    }

    const promptId = newId('pr_');
    const userMessageId = newId('msg_');
    entry.translation.currentPromptId = promptId;
    entry.lastPrompt = text;
    if (isDefaultSessionTitle(entry.title)) {
      entry.title = titleFromPrompt(text)!;
      entry.session.setSessionName(entry.title);
      this.setMeta(entry.id, { title: entry.title });
      this.emit(entry, 'session.meta.updated', { patch: { title: entry.title, lastPrompt: text } });
    }
    this.emit(entry, 'prompt.submitted', {
      promptId,
      userMessageId,
      content,
      createdAt: new Date().toISOString(),
    });

    if (entry.session.isStreaming) {
      await entry.session.steer(text, images.length > 0 ? images : undefined);
      return { prompt_id: promptId, user_message_id: userMessageId, status: 'queued' };
    }
    void entry.session
      .prompt(text, images.length > 0 ? { images } : undefined)
      .catch((error: unknown) => {
        // pi's prompt() can fail before the agent loop emits anything (e.g. no
        // API key configured) — the UI is already showing the prompt as
        // in-flight, so replay the full turn teardown sequence here.
        this.emit(entry, 'error', {
          message: error instanceof Error ? error.message : String(error),
          name: 'PromptError',
          retryable: false,
        });
        this.emit(entry, 'turn.ended', { reason: 'failed' });
        this.emit(entry, 'prompt.completed', { promptId, reason: 'failed' });
        if (entry.translation.currentPromptId === promptId) {
          entry.translation.currentPromptId = undefined;
        }
        this.emit(
          entry,
          'event.session.work_changed',
          { busy: false, main_turn_active: false, pending_interaction: 'none', last_turn_reason: 'failed' },
          true,
        );
      });
    return { prompt_id: promptId, user_message_id: userMessageId, status: 'running' };
  }

  async abortSession(sessionId: string): Promise<{ aborted: boolean }> {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { aborted: false };
    const wasActive = entry.session.isStreaming || entry.approvals.size > 0;
    for (const record of [...entry.approvals.values()]) {
      record.resolve({ approved: false, feedback: 'Cancelled by abort' });
    }
    await entry.session.abort();
    return { aborted: wasActive };
  }

  async setModel(sessionId: string, modelSpec: string): Promise<void> {
    const entry = await this.openSession(sessionId);
    const model = this.resolveModel(modelSpec);
    if (!model) throw new Error(`Unknown model: ${modelSpec}`);
    await entry.session.setModel(model as never);
  }

  setThinking(sessionId: string, level: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) throw new Error('Session not open');
    entry.session.setThinkingLevel(level as ThinkingLevel);
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const entry = await this.openSession(sessionId);
    entry.title = title;
    entry.session.setSessionName(title);
    this.setMeta(sessionId, { title });
    this.emit(entry, 'session.meta.updated', { patch: { title } });
  }

  setArchived(sessionId: string, archived: boolean): Promise<void> {
    const entry = this.sessions.get(sessionId);
    if (entry) entry.archived = archived;
    this.setMeta(sessionId, { archived });
    return Promise.resolve();
  }

  async deleteArchivedSession(sessionId: string): Promise<void> {
    const session = (await this.listSessions()).find((item) => item.id === sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    if (!session.archived) throw new SessionNotArchivedError(sessionId);
    if (session.busy) throw new SessionBusyError(sessionId);

    unlinkSync(session.file);
    this.sessions.delete(sessionId);
    delete this.meta[sessionId];
    this.persistMeta();
  }

  /**
   * Undo the last `count` user turns by navigating the session tree back to
   * the Nth-from-last user message; navigateTree parks the leaf at that
   * message's parent, so the turn leaves the active branch. The abandoned
   * tail stays in the append-only session file as an orphaned branch and
   * disappears from history as soon as a new message continues the session.
   */
  async undoSession(sessionId: string, count = 1): Promise<void> {
    const entry = await this.openSession(sessionId);
    if (entry.session.isStreaming || entry.runningTools.size > 0) {
      throw new SessionBusyError(sessionId);
    }

    const branch = entry.session.sessionManager.getBranch();
    let targetId: string | undefined;
    let seen = 0;
    for (let i = branch.length - 1; i >= 0; i--) {
      const item = branch[i];
      if (item?.type === 'message' && item.message.role === 'user' && ++seen === count) {
        targetId = item.id;
        break;
      }
    }
    if (!targetId) throw new SessionNothingToUndoError(sessionId);

    await entry.session.navigateTree(targetId);
  }

  resolveApproval(sessionId: string, approvalId: string, approved: boolean, feedback?: string): { resolved: boolean } {
    const entry = this.sessions.get(sessionId);
    const record = entry?.approvals.get(approvalId);
    if (!entry || !record) return { resolved: false };
    record.resolve({ approved, feedback });
    return { resolved: true };
  }

  // -------------------------------------------------------------------------
  // Models
  // -------------------------------------------------------------------------

  async listModels(): Promise<{ provider: string; model: string; display_name?: string; max_context_size: number; capabilities?: string[] }[]> {
    const models = await this.modelRuntime.getAvailable();
    return models.map((m) => ({
      provider: m.provider as string,
      model: m.id,
      display_name: m.name,
      max_context_size: m.contextWindow ?? 0,
      capabilities: [
        ...(m.reasoning ? ['reasoning'] : []),
        ...(m.input.includes('image') ? ['image'] : []),
      ],
    }));
  }

  findModel(spec: string): { provider: string; id: string } | undefined {
    const snapshot = this.modelRuntime.getAvailableSnapshot();
    const hit = snapshot.find((m) => `${m.provider}/${m.id}` === spec || m.id === spec);
    return hit ? { provider: hit.provider as string, id: hit.id } : undefined;
  }

  /** Resolve a model spec to the pi Model object via the shared runtime. */
  resolveModel(spec: string) {
    const found = this.findModel(spec);
    if (!found) return undefined;
    return this.modelRuntime.getAvailableSnapshot().find((m) => m.provider === found.provider && m.id === found.id);
  }

  async authStatus(): Promise<{ ready: boolean; providers_count: number; default_model: string | null }> {
    // pi has no login session for the UI to wait for — provider credentials
    // live on disk and are read per request. Always report ready so the web UI
    // skips its kimi-account sign-in gate and lands on the conversation list;
    // unauthenticated prompts surface as an actionable error notice instead.
    const models = await this.listModels();
    const providers = new Set(models.map((m) => m.provider));
    return {
      ready: true,
      providers_count: providers.size,
      default_model: models[0] ? `${models[0].provider}/${models[0].model}` : null,
    };
  }

  // -------------------------------------------------------------------------
  // Meta persistence
  // -------------------------------------------------------------------------

  private setMeta(sessionId: string, patch: SessionMeta): void {
    this.meta[sessionId] = { ...(this.meta[sessionId] ?? {}), ...patch };
    this.persistMeta();
  }

  private persistMeta(): void {
    try {
      mkdirSync(serverHomeDir(), { recursive: true });
      writeFileSync(this.metaFile, JSON.stringify(this.meta));
    } catch {
      // Best-effort persistence.
    }
  }
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Session not found: ${sessionId}`);
  }
}

export function workspaceIdFor(root: string): string {
  return `ws_${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
}

export function workspaceName(root: string): string {
  return basename(root) || root;
}
