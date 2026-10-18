import { create } from 'zustand'

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
  sources?: ChatSource[]
  meta?: {
    tool_calls?: number
    tools_used?: string[]
    llm_calls?: number
    token_usage?: { input?: number; output?: number; total_tokens?: number }
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
  updateMessage: (id, update) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === id ? { ...message, ...update } : message,
      ),
    })),
  setStreaming: (streaming) => set({ isStreaming: streaming }),
  clear: () => set({ messages: [], activeSessionId: null }),
}))
