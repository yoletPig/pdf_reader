/**
 * pi agent 问答 API - 通过后端代理访问 agent-gateway。
 *
 * SSE 协议保持与旧 agent-runs 兼容：
 *   run_created / event / answer_delta / result / error
 */
import apiClient from './client'

export interface ThoughtStep {
  id: string
  kind: string
  status: 'running' | 'completed' | 'failed'
  title: string
  content: string
  created_at?: string
}

export interface ExecutionMetadata {
  mode: 'direct' | 'retrieval' | 'agent'
  trace_visibility: 'hidden' | 'compact' | 'expanded'
  reason: string
}

export interface CreatePaperQARunRequest {
  input: {
    question: string
    paper_id?: string
  }
  context?: {
    paper_id?: string
    session_id?: string
    current_page?: number
    selected_text?: string
  }
}

export interface TraceSummary {
  event_count?: number
  tool_calls?: number
  llm_calls?: number
  tools_used?: string[]
  stop_reason?: string
  error_message?: string
  token_usage?: { input?: number; output?: number; total_tokens?: number }
  /** 模型思考过程（reasoning/thinking 块全文，可能截断） */
  thinking?: string
  /** 工具调用轨迹 */
  tool_trace?: ThoughtStep[]
  /** 本次问答耗时（毫秒） */
  duration_ms?: number
  /** 结束时的上下文用量 */
  context?: {
    tokens?: number
    estimated_tokens?: number
    window?: number
    percent?: number
    messages?: number
  }
}

/** SSE 状态帧：agent 状态 / 上下文用量实时更新 */
export interface AgentStatusFrame {
  run_id: string
  phase: string
  state: 'idle' | 'thinking' | 'tool_calling' | 'streaming'
  context: {
    tokens: number
    estimated_tokens: number
    window: number
    percent: number
    messages: number
  }
  usage: { input: number; output: number; total: number }
  tool_calls: number
  llm_calls: number
  elapsed_ms: number
}

export interface McpServerStatus {
  name: string
  transport: 'stdio' | 'http'
  status: 'connected' | 'connecting' | 'error' | 'disabled'
  tools: string[]
  error?: string
}

export interface AgentSessionStatus {
  session_id: string
  exists: boolean
  state: string
  is_streaming: boolean
  message_count: number
  context_chars: number
  estimated_tokens: number
  context_tokens: number
  context_window: number
  context_percent: number
  usage: { input: number; output: number; total: number }
  pending_tool_calls: string[]
  tool_count: number
  model: string
  max_turns: number
  last_error?: string
}

export interface AgentOverview {
  status: string
  model: string
  active_sessions: number
  skills: string[]
  mcp: McpServerStatus[]
  sessions: AgentSessionStatus[]
}

export interface StreamAgentRunResult {
  run_id: string
  agent: string
  status: string
  answer: {
    content: string
    sources: Array<{
      paper_id: string
      paper_title: string
      page: number
      chunk_text?: string
    }>
    trace_summary: TraceSummary
  }
  execution: ExecutionMetadata
}

export type AgentRunStreamItem =
  | { type: 'run_created'; data: { run_id: string; agent: string; status: string; execution: ExecutionMetadata; thought?: ThoughtStep | null; agent_info?: { model: string; max_turns: number; skills: Array<{ name: string; description: string }>; mcp: McpServerStatus[]; tools: string[] } } }
  | { type: 'event'; data: ThoughtStep }
  | { type: 'thinking_delta'; data: { content: string } }
  | { type: 'status'; data: AgentStatusFrame }
  | { type: 'answer_delta'; data: { content: string } }
  | { type: 'result'; data: StreamAgentRunResult }
  | { type: 'error'; data: { run_id: string; detail: string; error_type?: string } }

function parseSseFrame(frame: string): AgentRunStreamItem | null {
  let type = 'message'
  const data: string[] = []
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) type = line.slice(6).trim()
    if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
  }
  if (!data.length) return null
  return { type, data: JSON.parse(data.join('\n')) } as AgentRunStreamItem
}

export async function streamPaperQA(
  request: CreatePaperQARunRequest,
  onItem: (item: AgentRunStreamItem) => void,
) {
  const response = await fetch('/api/agent-runs/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { question: request.input.question, paper_id: request.input.paper_id },
      context: request.context ?? {},
    }),
  })
  if (!response.ok || !response.body) {
    throw new Error((await response.text()) || '无法建立问答流式连接')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() || ''
    for (const frame of frames) {
      const item = parseSseFrame(frame)
      if (item) onItem(item)
    }
    if (done) break
  }
  if (buffer.trim()) {
    const item = parseSseFrame(buffer)
    if (item) onItem(item)
  }
}

export const agentRunsApi = {
  /** 同步问答（ReaderPage 内嵌 QA 用） */
  createPaperQA: (data: CreatePaperQARunRequest) =>
    apiClient.post<StreamAgentRunResult>('/agent-runs', {
      input: data.input,
      context: data.context ?? {},
    }),
  /** 重置会话上下文 */
  resetSession: (sessionId: string) =>
    apiClient.post('/agent-runs/reset', { session_id: sessionId }),
  /** agent-gateway 健康状态 */
  health: () => apiClient.get('/agent-runs/health'),
  /** agent 状态/上下文用量（session_id 可选） */
  getStatus: (sessionId?: string) =>
    apiClient.get<AgentSessionStatus | AgentOverview>('/agent-runs/status', {
      params: sessionId ? { session_id: sessionId } : undefined,
    }),
  /** 活跃会话状态列表 */
  listSessions: () => apiClient.get<{ sessions: AgentSessionStatus[] }>('/agent-runs/sessions'),
  /** 测试 MCP 服务器连接 */
  testMcpServer: (server: Record<string, any>) =>
    apiClient.post<McpServerStatus>('/agent-runs/mcp-test', { server }),
}
