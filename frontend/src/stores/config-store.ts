import { create } from 'zustand'
import type { AppModelConfig } from '../api/config'
import type { PromptTemplate } from '../api/prompts'

interface ConfigState {
  modelConfig: AppModelConfig | null
  prompts: PromptTemplate[]
  theme: 'light' | 'dark'
  setModelConfig: (modelConfig: AppModelConfig | null) => void
  setPrompts: (prompts: PromptTemplate[]) => void
  setTheme: (theme: 'light' | 'dark') => void
}

export const useConfigStore = create<ConfigState>((set) => ({
  modelConfig: null,
  prompts: [],
  theme: 'light',
  setModelConfig: (modelConfig) => set({ modelConfig }),
  setPrompts: (prompts) => set({ prompts }),
  setTheme: (theme) => set({ theme }),
}))
