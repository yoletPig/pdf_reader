import { create } from 'zustand'

interface PDFState {
  currentPaperId: string | null
  currentPage: number
  totalPages: number
  selectedText: string
  selectedBlockId: string | null
  setPaper: (id: string) => void
  setPage: (page: number) => void
  setTotalPages: (total: number) => void
  setSelection: (text: string, blockId: string | null) => void
  clearSelection: () => void
}

export const usePDFStore = create<PDFState>((set) => ({
  currentPaperId: null,
  currentPage: 1,
  totalPages: 0,
  selectedText: '',
  selectedBlockId: null,
  setPaper: (id) => set({ currentPaperId: id }),
  setPage: (page) => set({ currentPage: page }),
  setTotalPages: (total) => set({ totalPages: total }),
  setSelection: (text, blockId) => set({ selectedText: text, selectedBlockId: blockId }),
  clearSelection: () => set({ selectedText: '', selectedBlockId: null }),
}))
