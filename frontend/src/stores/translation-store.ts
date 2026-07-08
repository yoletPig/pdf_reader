import { create } from 'zustand'

type TranslationCacheValue = {
  quick?: string
  polish?: string
}

interface TranslationCache {
  [blockId: string]: TranslationCacheValue
}

interface TranslationState {
  cache: TranslationCache
  isLoading: boolean
  currentMode: 'quick' | 'polish'
  pageTranslations: Record<number, TranslationCache>
  setMode: (mode: 'quick' | 'polish') => void
  setCache: (blockId: string, mode: string, text: string) => void
  setPageCache: (pageNumber: number, blockId: string, mode: string, text: string) => void
  setLoading: (loading: boolean) => void
  clearPageTranslations: (pageNumber: number) => void
}

export const useTranslationStore = create<TranslationState>((set) => ({
  cache: {},
  isLoading: false,
  currentMode: 'quick',
  pageTranslations: {},
  setMode: (mode) => set({ currentMode: mode }),
  setCache: (blockId, mode, text) =>
    set((state) => ({
      cache: {
        ...state.cache,
        [blockId]: {
          ...state.cache[blockId],
          [mode]: text,
        },
      },
    })),
  setPageCache: (pageNumber, blockId, mode, text) =>
    set((state) => ({
      pageTranslations: {
        ...state.pageTranslations,
        [pageNumber]: {
          ...(state.pageTranslations[pageNumber] || {}),
          [blockId]: {
            ...(state.pageTranslations[pageNumber]?.[blockId] || {}),
            [mode]: text,
          },
        },
      },
    })),
  setLoading: (loading) => set({ isLoading: loading }),
  clearPageTranslations: (pageNumber) =>
    set((state) => {
      const rest = { ...state.pageTranslations }
      delete rest[pageNumber]
      return { pageTranslations: rest }
    }),
}))
