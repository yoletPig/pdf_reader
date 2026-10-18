import { create } from 'zustand'

import { ThoughtStep } from '../api/agent-runs'

interface Message {
  id: string
  role: 'user' | 'assistant'
  kind?: 'thinking' | 'answer'
  execution?: {
    mode: 'direct' | 'retrieval' | 'agent'
    trace_visibility: 'hidden' | 'compact' | 'expanded'
    reason: string
  }
  content: string
  runId?: string
  sources?: Array<{
    paper_id?: string
    paper_title: string
    page: number
    chunk_text?: string
    relevance_score?: number
  }>
  traceSummary?: {
    event_count?: number
    tool_calls?: number
    llm_calls?: number
    tools_used?: string[]
    tool_failures?: number
    duration_ms?: number
    token_usage?: {
      input?: number
      output?: number
      total_tokens?: number
    }
  }
  events?: ThoughtStep[]
  timestamp: number
}

interface ChatState {
  messages: Message[]
  isStreaming: boolean
  addMessage: (msg: Message) => void
  appendToLast: (content: string) => void
  updateMessage: (id: string, update: Partial<Message>) => void
  setStreaming: (streaming: boolean) => void
  clearMessages: () => void
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  isStreaming: false,
  addMessage: (msg) => set((state) => ({ messages: [...state.messages, msg] })),
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
  updateMessage: (id, update) => set((state) => ({
    messages: state.messages.map((message) => (
      message.id === id ? { ...message, ...update } : message
    )),
  })),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  clearMessages: () => set({ messages: [] }),
}))
