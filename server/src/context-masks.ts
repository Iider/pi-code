import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';

export const CONTEXT_MASK_CUSTOM_TYPE = 'pi-code.context-mask';

export interface ContextMaskData {
  version: 1;
  userEntryId: string;
  endEntryId: string;
  masked: boolean;
}

export interface ContextMaskTurn {
  user_entry_id: string;
  assistant_entry_id: string;
  end_entry_id: string;
  masked: boolean;
  has_tools: boolean;
  can_toggle: boolean;
  unavailable_reason?: 'compacted';
}

export class ContextMaskTargetError extends Error {}
export class ContextMaskCompactedError extends Error {}

function isMaskData(value: unknown): value is ContextMaskData {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<ContextMaskData>;
  return data.version === 1
    && typeof data.userEntryId === 'string'
    && typeof data.endEntryId === 'string'
    && typeof data.masked === 'boolean';
}

export function activeMaskData(branch: readonly SessionEntry[]): Map<string, ContextMaskData> {
  const masks = new Map<string, ContextMaskData>();
  for (const entry of branch) {
    if (entry.type === 'custom' && entry.customType === CONTEXT_MASK_CUSTOM_TYPE && isMaskData(entry.data)) {
      masks.set(entry.data.userEntryId, entry.data);
    }
  }
  return masks;
}

export function listContextMaskTurns(branch: readonly SessionEntry[]): ContextMaskTurn[] {
  const masks = activeMaskData(branch);
  const latestCompactionIndex = branch.findLastIndex((entry) => entry.type === 'compaction');
  const turns: ContextMaskTurn[] = [];

  for (let index = 0; index < branch.length; index += 1) {
    const user = branch[index];
    if (user?.type !== 'message' || user.message.role !== 'user') continue;

    let endIndex = index;
    let assistantEntryId: string | undefined;
    let hasTools = false;
    for (let cursor = index + 1; cursor < branch.length; cursor += 1) {
      const candidate = branch[cursor];
      if (candidate?.type === 'message' && candidate.message.role === 'user') break;
      if (candidate?.type !== 'message') continue;
      endIndex = cursor;
      if (candidate.message.role === 'assistant' && !assistantEntryId) assistantEntryId = candidate.id;
      if (candidate.message.role === 'toolResult') hasTools = true;
      if (candidate.message.role === 'assistant' && candidate.message.content.some((part) => part.type === 'toolCall')) {
        hasTools = true;
      }
    }
    if (!assistantEntryId) continue;

    const existing = masks.get(user.id);
    const isHistoricalCompactedTurn = latestCompactionIndex >= 0 && index < latestCompactionIndex;
    const canToggle = !isHistoricalCompactedTurn;
    turns.push({
      user_entry_id: user.id,
      assistant_entry_id: assistantEntryId,
      end_entry_id: branch[endIndex]?.id ?? assistantEntryId,
      masked: existing?.masked ?? false,
      has_tools: hasTools,
      can_toggle: canToggle,
      ...(canToggle ? {} : { unavailable_reason: 'compacted' as const }),
    });
  }
  return turns;
}

export function findContextMaskTurn(branch: readonly SessionEntry[], assistantEntryId: string): ContextMaskTurn {
  const turn = listContextMaskTurns(branch).find((candidate) => candidate.assistant_entry_id === assistantEntryId);
  if (!turn) throw new ContextMaskTargetError(`Entry is not the assistant anchor of a completed turn: ${assistantEntryId}`);
  return turn;
}

export function maskedMessageSet(branch: readonly SessionEntry[]): Set<AgentMessage> {
  const maskedUsers = new Set(
    [...activeMaskData(branch).values()].filter((mask) => mask.masked).map((mask) => mask.userEntryId),
  );
  const hidden = new Set<AgentMessage>();
  let maskCurrentTurn = false;
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    if (entry.message.role === 'user') maskCurrentTurn = maskedUsers.has(entry.id);
    if (maskCurrentTurn) hidden.add(entry.message);
  }
  return hidden;
}

export function filterMaskedMessages(messages: readonly AgentMessage[], branch: readonly SessionEntry[]): AgentMessage[] {
  const hidden = maskedMessageSet(branch);
  const hiddenSignatures = new Map<string, number>();
  for (const message of hidden) {
    const signature = messageSignature(message);
    hiddenSignatures.set(signature, (hiddenSignatures.get(signature) ?? 0) + 1);
  }
  return messages.filter((message) => {
    if (hidden.has(message)) return false;
    const signature = messageSignature(message);
    const remaining = hiddenSignatures.get(signature) ?? 0;
    if (remaining === 0) return true;
    hiddenSignatures.set(signature, remaining - 1);
    return false;
  });
}

function messageSignature(message: AgentMessage): string {
  return JSON.stringify(message);
}

export function installContextMaskTransform(session: {
  agent: { transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> };
  sessionManager: SessionManager;
}): void {
  const upstream = session.agent.transformContext;
  session.agent.transformContext = async (messages, signal) => {
    const filtered = filterMaskedMessages(messages, session.sessionManager.getBranch());
    return upstream ? upstream(filtered, signal) : filtered;
  };
}
