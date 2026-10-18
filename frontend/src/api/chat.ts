/**
 * 对话会话 API - pi agent 对话历史管理
 */
import apiClient from './client'

export interface ChatSessionItem {
  id: string
  title: string
  paper_id: string
  created_at: string
  updated_at: string
  last_message: string
  message_count: number
}

export interface ChatMessageItem {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources: Array<{
    paper_id?: string
    paper_title?: string
    page?: number
    chunk_text?: string
  }>
  meta: {
    tool_calls?: number
    tools_used?: string[]
    llm_calls?: number
    token_usage?: { input?: number; output?: number; total_tokens?: number }
    error?: boolean
    [key: string]: any
  }
  created_at: string
}

export const chatApi = {
  listSessions: () => apiClient.get<{ sessions: ChatSessionItem[] }>('/chat/sessions'),
  createSession: (data: { title?: string; paper_id?: string }) =>
    apiClient.post<ChatSessionItem>('/chat/sessions', data),
  updateSession: (id: string, data: { title?: string; paper_id?: string }) =>
    apiClient.patch<ChatSessionItem>(`/chat/sessions/${id}`, data),
  deleteSession: (id: string) => apiClient.delete(`/chat/sessions/${id}`),
  listMessages: (id: string) =>
    apiClient.get<{ session_id: string; messages: ChatMessageItem[] }>(`/chat/sessions/${id}/messages`),
  /** 非流式问答（返回最终结果） */
  send: (id: string, data: { question: string; paper_id?: string; selected_text?: string; current_page?: number }) =>
    apiClient.post<any>(`/chat/sessions/${id}/messages`, data),
}

/**
 * 流式发送（SSE）：返回 controller 便于取消。
 * onEvent: (type, data) => void
 */
export async function streamChatMessage(
  sessionId: string,
  body: {
    question: string
    paper_id?: string
    selected_text?: string
    current_page?: number
  },
  onEvent: (type: string, data: any) => void,
  signal?: AbortSignal,
) {
  const response = await fetch(`/api/chat/sessions/${sessionId}/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok || !response.body) {
    throw new Error((await response.text()) || '无法建立对话流')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatch = (frame: string) => {
    let type = 'message'
    const dataLines: string[] = []
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) type = line.slice(6).trim()
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) return
    try {
      onEvent(type, JSON.parse(dataLines.join('\n')))
    } catch {
      /* 忽略无法解析的帧 */
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() || ''
    for (const frame of frames) dispatch(frame)
    if (done) break
  }
  if (buffer.trim()) dispatch(buffer)
}
