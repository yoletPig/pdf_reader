import { create } from 'zustand'
import type { SearchResult } from '../api/search'

interface SearchState {
  query: string
  results: SearchResult[]
  isSearching: boolean
  setQuery: (q: string) => void
  setResults: (results: SearchResult[]) => void
  setSearching: (s: boolean) => void
}

export const useSearchStore = create<SearchState>((set) => ({
  query: '',
  results: [],
  isSearching: false,
  setQuery: (query) => set({ query }),
  setResults: (results) => set({ results }),
  setSearching: (isSearching) => set({ isSearching }),
}))
