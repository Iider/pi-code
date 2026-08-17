// Local wire DTO shapes this server emits — a focused subset of kimi-web's
// src/api/daemon/wire.ts. Field names stay snake_case on the wire.

export interface WireSessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_cost_usd: number;
  context_tokens: number;
  context_limit: number;
  turn_count: number;
}

export interface WireSession {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  busy: boolean;
  main_turn_active?: boolean;
  pending_interaction?: 'none' | 'approval' | 'question';
  last_turn_reason?: 'completed' | 'cancelled' | 'failed';
  archived: boolean;
  current_prompt_id?: string;
  last_prompt?: string;
  workspace_id?: string;
  metadata: { cwd: string; [key: string]: unknown };
  agent_config: {
    model: string;
    system_prompt?: string;
    tools?: string[];
    mcp_servers?: string[];
    thinking?: string;
    permission_mode?: string;
    plan_mode?: boolean;
    swarm_mode?: boolean;
    goal_objective?: string;
    goal_control?: 'pause' | 'resume' | 'cancel';
  };
  usage: WireSessionUsage;
  permission_rules: unknown[];
  message_count: number;
  last_seq: number;
}

export type WireMessageContent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; tool_call_id: string; tool_name: string; input: unknown }
  | { type: 'tool_result'; tool_call_id: string; output: unknown; is_error?: boolean }
  | { type: 'image'; source: { kind: 'base64'; media_type: string; data: string } }
  | { type: 'thinking'; thinking: string; signature?: string };

export interface WireMessage {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: WireMessageContent[];
  created_at: string;
  prompt_id?: string;
  parent_message_id?: string;
  metadata?: Record<string, unknown>;
}

export interface WireApprovalRequest {
  approval_id: string;
  session_id: string;
  turn_id?: number;
  tool_call_id: string;
  tool_name: string;
  action: string;
  tool_input_display?: unknown;
  expires_at: string;
  created_at: string;
}

export interface WireModel {
  provider: string;
  model: string;
  display_name?: string;
  max_context_size: number;
  capabilities?: string[];
}

export interface WireWorkspace {
  id: string;
  root: string;
  name: string;
  last_opened_at?: string;
  session_count: number;
}

/** A server→client WS frame. Event frames carry seq/session_id/timestamp. */
export interface EventFrame {
  type: string;
  seq: number;
  session_id: string;
  timestamp: string;
  epoch?: string;
  payload: unknown;
}
