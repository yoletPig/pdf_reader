import { create } from 'zustand'
import type { ThoughtStep } from '../api/agent-runs'

export interface ChatSource {
  paper_id?: string
  paper_title?: string
  page?: number
  chunk_text?: string
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  /** 模型思考过程（流式累积 / 历史消息 meta.thinking） */
  thinking?: string
  /** 工具调用轨迹（流式累积 / 历史消息 meta.tool_trace） */
  trace?: ThoughtStep[]
  sources?: ChatSource[]
  meta?: {
    tool_calls?: number
    tools_used?: string[]
    llm_calls?: number
    token_usage?: { input?: number; output?: number; total_tokens?: number }
    thinking?: string
    tool_trace?: ThoughtStep[]
    duration_ms?: number
    context?: {
      tokens?: number
      estimated_tokens?: number
      window?: number
      percent?: number
      messages?: number
    }
    error?: boolean
    [key: string]: any
  }
  streaming?: boolean
  createdAt: number
}

interface ChatState {
  messages: ChatMessage[]
  isStreaming: boolean
  activeSessionId: string | null
  setActiveSession: (id: string | null) => void
  setMessages: (messages: ChatMessage[]) => void
  addMessage: (message: ChatMessage) => void
  appendToLast: (content: string) => void
  /** 追加思考过程增量 */
  appendThinking: (id: string, content: string) => void
  /** 新增/更新工具轨迹条目 */
  upsertTrace: (id: string, step: ThoughtStep) => void
  updateMessage: (id: string, update: Partial<ChatMessage>) => void
  setStreaming: (streaming: boolean) => void
  clear: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isStreaming: false,
  activeSessionId: null,
  setActiveSession: (id) => set({ activeSessionId: id }),
  setMessages: (messages) => set({ messages }),
  addMessage: (message) => set((state) => ({ messages: [...state.messages, message] })),
  appendToLast: (content) =>
    set((state) => {
      const msgs = [...state.messages]
      if (msgs.length > 0) {
        msgs[msgs.length - 1] = {
          ...msgs[msgs.length - 1],
          content: msgs[msgs.length - 1].content + content,
        }
      }
      return { messages: msgs }
    }),
  appendThinking: (id, content) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id
          ? { ...message, thinking: (message.thinking || '') + content }
          : message,
      ),
    })),
  upsertTrace: (id, step) =>
    set((state) => ({
      messages: state.messages.map((message) => {
        if (message.id !== id) return message
        const trace = [...(message.trace || [])]
        const index = trace.findIndex((t) => t.id === step.id)
        if (index >= 0) trace[index] = { ...trace[index], ...step }
        else trace.push(step)
        return { ...message, trace }
      }),
    })),
  updateMessage: (id, update) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, ...update } : message,
      ),
    })),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  clear: () => set({ messages: [], activeSessionId: null }),
}))
