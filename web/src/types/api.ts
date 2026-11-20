export interface SessionAttention {
  pending_approval?: boolean;
  pending_clarify?: boolean;
  unread?: boolean;
  [key: string]: unknown;
}

export interface SessionSummary {
  session_id: string;
  title?: string;
  display_title?: string;
  source?: string;
  profile?: string;
  workspace_dir?: string;
  updated_at?: number | string;
  created_at?: number | string;
  pinned?: boolean;
  archived?: boolean;
  is_running?: boolean;
  model?: string;
  attention?: SessionAttention;
  [key: string]: unknown;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
  cli_count?: number;
  archived_count?: number;
  webui_session_count?: number;
  cli_session_count?: number;
  active_profile?: string | null;
  server_time?: number;
}

export interface ToolCallRecord {
  id?: string;
  type?: string;
  function?: {
    name?: string;
    arguments?: string | Record<string, unknown>;
  };
  name?: string;
  arguments?: string | Record<string, unknown>;
}

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string | null | Array<Record<string, unknown>>;
  reasoning?: string | null;
  tool_calls?: ToolCallRecord[];
  tool_call_id?: string;
  name?: string;
  timestamp?: number | string;
  interim?: boolean;
  [key: string]: unknown;
}

export interface SessionDetail extends SessionSummary {
  messages: ChatMessage[];
  reasoning_effort?: string;
  yolo?: boolean;
}

export interface SessionDetailResponse {
  session: SessionDetail;
}

export interface ChatStartResponse {
  stream_id?: string;
  status?: string;
  reason?: string;
  error?: string;
}

export interface ApprovalRequestPayload {
  approval_id?: string;
  run_id?: string;
  mirror_token?: string;
  session_id: string;
  command?: string;
  tool?: string;
  reason?: string;
  risk_level?: string;
  cwd?: string;
  [key: string]: unknown;
}

export type ApprovalChoice = "once" | "session" | "always" | "deny";

export interface ClarifyRequestPayload {
  clarify_id: string;
  session_id: string;
  question: string;
  choices?: string[];
  allow_custom?: boolean;
  timeout_seconds?: number;
  [key: string]: unknown;
}

export interface ModelOption {
  id: string;
  name?: string;
  provider?: string;
  [key: string]: unknown;
}

export interface UploadedAttachment {
  id?: string;
  filename: string;
  path?: string;
  url?: string;
  mime_type?: string;
  size?: number;
}
