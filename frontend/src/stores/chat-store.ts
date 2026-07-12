import { create } from 'zustand'

import { AgentRunEvent } from '../api/agent-runs'

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  runId?: string
  sources?: Array<{
    paper_title: string
    page: number
    chunk_text: string
    relevance_score?: number
  }>
  traceSummary?: {
    event_count?: number
    tool_calls?: number
    llm_calls?: number
    tool_failures?: number
    duration_ms?: number
    token_usage?: {
      total_tokens?: number
    }
  }
  events?: AgentRunEvent[]
  timestamp: number
}

interface ChatState {
  messages: Message[]
  isStreaming: boolean
  addMessage: (msg: Message) => void
  appendToLast: (content: string) => void
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
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  clearMessages: () => set({ messages: [] }),
}))
