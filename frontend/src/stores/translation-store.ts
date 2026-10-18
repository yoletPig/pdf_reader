import { create } from 'zustand'

/**
 * 翻译状态 — 已取消快速/严谨双模式，
 * 仅保留选段翻译缓存与加载态。
 */
interface TranslationState {
  /** 选段翻译缓存：blockKey -> 译文 */
  selectionCache: Record<string, string>
  translatingSelection: boolean
  /** 正在翻译的页码集合 */
  translatingPages: number[]
  setSelectionCache: (blockKey: string, translated: string) => void
  setTranslatingSelection: (value: boolean) => void
  setTranslatingPage: (pageNumber: number, value: boolean) => void
  clearCache: () => void
}

export const useTranslationStore = create<TranslationState>((set) => ({
  selectionCache: {},
  translatingSelection: false,
  translatingPages: [],
  setSelectionCache: (blockKey, translated) =>
    set((state) => ({ selectionCache: { ...state.selectionCache, [blockKey]: translated } })),
  setTranslatingSelection: (value) => set({ translatingSelection: value }),
  setTranslatingPage: (pageNumber, value) =>
    set((state) => ({
      translatingPages: value
        ? Array.from(new Set([...state.translatingPages, pageNumber]))
        : state.translatingPages.filter((p) => p !== pageNumber),
    })),
  clearCache: () => set({ selectionCache: {} }),
}))
