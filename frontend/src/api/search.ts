import apiClient from './client'

export interface SearchParams {
  query: string
  source?: string
  year_from?: number
  year_to?: number
  max_results?: number
}

export interface SearchResult {
  title: string
  authors: string[]
  year: number
  source: string
  source_id: string
  abstract: string
  citation_count?: number
}

export interface SearchResponse {
  query: string
  results: SearchResult[]
  total: number
}

export const searchApi = {
  search: (params: SearchParams) => apiClient.get<SearchResponse>('/search', { params }),
  import: (data: { source: string; source_id: string }) => apiClient.post('/search/import', data),
}
