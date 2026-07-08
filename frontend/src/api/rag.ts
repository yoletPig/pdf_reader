import apiClient from './client'

export interface RAGQuery {
  question: string
  paper_ids?: string[]
  top_k?: number
  mode?: 'hybrid' | 'vector' | 'keyword' | 'graph'
}

export const ragApi = {
  query: (data: RAGQuery) => apiClient.post('/rag/query', data),
}
