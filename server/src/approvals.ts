// Approval bridge: pi has no built-in permission system, so mutative tool
// calls (bash / write / edit) are gated here. The gate wraps the Agent's
// beforeToolCall chain (keeping the extension hook intact), parks a pending
// approval, and resolves when the web user approves or rejects via REST.

import type { Agent, BeforeToolCallContext, BeforeToolCallResult } from '@earendil-works/pi-agent-core';
import { newId } from './envelope.ts';
import type { WireApprovalRequest } from './wire.ts';

export interface ApprovalRecord {
  wire: WireApprovalRequest;
  resolve: (decision: { approved: boolean; feedback?: string }) => void;
  settled: boolean;
  decision?: 'approved' | 'rejected' | 'cancelled';
}

export type ApprovalPolicy = 'all' | 'dangerous' | 'none';

/** Tool calls that mutate state and therefore may need approval. */
const MUTATIVE_TOOLS = new Set(['bash', 'write', 'edit', 'session_draft']);

const DANGEROUS_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\brm\s+(-[a-z]*\s+)*-/i, label: 'rm' },
  { pattern: /\b(git\s+push|git\s+reset\s+--hard|git\s+clean)/i, label: 'git rewrite' },
  { pattern: /\b(sudo|chmod\s+777|chown)\b/i, label: 'privilege change' },
  { pattern: /\b(mkfs|dd\s+of=|>\s*\/dev\/sd)/i, label: 'disk write' },
  { pattern: /\b(npm\s+publish|pip\s+upload|cargo\s+publish)\b/i, label: 'publish' },
  { pattern: /\bcurl\b[^\n|]*\|\s*(ba)?sh/i, label: 'curl | sh' },
  { pattern: /\bkill(all)?\s+-9/i, label: 'kill -9' },
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(({ pattern }) => pattern.test(command));
}

/** Does this tool call need an approval round-trip under the given policy? */
export function needsApproval(policy: ApprovalPolicy, toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'session_draft') return args['action'] === 'request_publish';
  if (policy === 'none') return false;
  if (!MUTATIVE_TOOLS.has(toolName)) return false;
  if (policy === 'all') return true;
  // 'dangerous': ask only for destructive bash commands and writes outside cwd.
  if (toolName === 'bash') {
    const command = typeof args['command'] === 'string' ? (args['command'] as string) : '';
    return isDangerousCommand(command);
  }
  return false;
}

/** Install the approval gate onto an Agent, chaining any existing hook. */
export function installApprovalGate(agent: Agent, options: {
  sessionId: string;
  policy: ApprovalPolicy;
  turnId: () => number | undefined;
  onApproval: (record: ApprovalRecord) => void;
  onSettled: (approvalId: string, decision: 'approved' | 'rejected' | 'cancelled', feedback?: string) => void;
  toolInputDisplay?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
}): void {
  const existing = agent.beforeToolCall?.bind(agent);
  agent.beforeToolCall = async (context: BeforeToolCallContext, signal?: AbortSignal): Promise<BeforeToolCallResult | undefined> => {
    const extResult = await existing?.(context, signal);
    if (extResult?.block) return extResult;

    const toolName = context.toolCall.name;
    const args = (context.args ?? {}) as Record<string, unknown>;
    if (!needsApproval(options.policy, toolName, args)) return extResult;

    const approvalId = newId('apr_');
    const toolInputDisplay = options.toolInputDisplay
      ? await options.toolInputDisplay(toolName, args)
      : buildToolInputDisplay(toolName, args);
    const record = await new Promise<ApprovalRecord>((resolveOuter) => {
      const record: ApprovalRecord = {
        wire: {
          approval_id: approvalId,
          session_id: options.sessionId,
          turn_id: options.turnId(),
          tool_call_id: context.toolCall.id,
          tool_name: toolName,
          action: describeAction(toolName, args),
          tool_input_display: toolInputDisplay,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
        settled: false,
        resolve: (decision) => {
          if (record.settled) return;
          record.settled = true;
          record.decision = decision.approved ? 'approved' : 'rejected';
          resolveOuter(record);
        },
      };
      options.onApproval(record);
    });

    if (!record.decision) {
      // Settled without a decision (safety net) — treat as rejected.
      record.decision = 'rejected';
    }
    options.onSettled(approvalId, record.decision === 'approved' ? 'approved' : 'rejected');

    if (record.decision !== 'approved') {
      return { block: true, reason: 'User rejected this tool call via the web approval dialog.' };
    }
    return extResult;
  };
}

function describeAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === 'bash') {
    const command = typeof args['command'] === 'string' ? (args['command'] as string) : '';
    return command.length > 120 ? `${command.slice(0, 117)}…` : command || 'run command';
  }
  if (toolName === 'write' || toolName === 'edit') {
    const path = typeof args['path'] === 'string' ? (args['path'] as string) : 'file';
    return `${toolName} ${path}`;
  }
  if (toolName === 'session_draft' && args['action'] === 'request_publish') {
    return `publish draft to ${String(args['targetPath'] ?? 'file')}`;
  }
  return toolName;
}

/**
 * ToolInputDisplay kinds the web dialog understands. `terminal_command` gets
 * the dedicated terminal-style preview; everything else falls back to the
 * generic key/value display.
 */
function buildToolInputDisplay(toolName: string, args: Record<string, unknown>): unknown {
  if (toolName === 'bash' && typeof args['command'] === 'string') {
    return { kind: 'terminal_command', command: args['command'] };
  }
  if ((toolName === 'write' || toolName === 'edit') && typeof args['path'] === 'string') {
    return {
      kind: toolName === 'write' ? 'file_write' : 'file_edit',
      path: args['path'],
      content: typeof args['content'] === 'string' ? (args['content'] as string) : undefined,
      old_string: typeof args['old_string'] === 'string' ? (args['old_string'] as string) : undefined,
      new_string: typeof args['new_string'] === 'string' ? (args['new_string'] as string) : undefined,
    };
  }
  if (toolName === 'session_draft' && args['action'] === 'request_publish') {
    return { kind: 'file_write', path: args['targetPath'] };
  }
  return undefined;
}
