import apiClient from './client'

export interface Paper {
  id: string
  title: string
  authors: string
  abstract: string
  year: number | null
  source: string
  source_id: string
  source_url?: string
  document_type?: string
  file_path: string
  markdown_path?: string
  tags: string
  added_at: string
  last_read_at: string | null
  read_progress: number
  is_indexed: boolean
  page_count?: number
  pdf_metadata?: Record<string, string>
  ai_summary_md?: string
  reader_profile?: Record<string, any>
}

export interface PaperListResponse {
  papers: Paper[]
  total: number
  page: number
  page_size: number
}

export interface UploadResponse {
  message: string
  paper: Paper
}

export interface ReindexPaperResponse {
  paper: Paper
  ingestion: {
    paper_id: string
    blocks: number
    chunks: number
    is_indexed: boolean
  }
}

export interface PaperChunkRecord {
  id: string
  paper_id: string
  paper_title: string
  chunk_id: string
  page: number
  block_id: string
  text: string
  metadata: Record<string, any>
  created_at: string | null
}

export interface PaperChunksResponse {
  paper_id?: string
  page?: number
  total: number
  limit: number
  offset: number
  chunks: PaperChunkRecord[]
}

export interface PaperPageSourceResponse {
  paper_id: string
  page_number: number
  document_type: string
  block_count: number
  text: string
  markdown: string
}

export interface PaperListParams {
  page?: number
  page_size?: number
  query?: string
  tag?: string
  source?: string
  indexed?: boolean
  year?: number
  sort?: 'recent' | 'title' | 'year' | 'progress'
}

export const papersApi = {
  list: (params?: PaperListParams) => apiClient.get<PaperListResponse>('/papers', { params }),
  listChunks: (params?: { paper_id?: string; page?: number; limit?: number; offset?: number }) =>
    apiClient.get<PaperChunksResponse>('/papers/chunks', { params }),
  get: (id: string) => apiClient.get<Paper>(`/papers/${id}`),
  updateReaderProfile: (id: string, data: Record<string, any>) =>
    apiClient.patch<Paper>(`/papers/${id}/reader-profile`, data),
  refreshReaderProfile: (id: string, data: { mode: 'quick' | 'polish'; profile?: Record<string, any> }) =>
    apiClient.post<Paper>(`/papers/${id}/reader-profile/refresh`, data),
  upload: (formData: FormData) =>
    apiClient.post<UploadResponse>('/papers/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  reindex: (id: string) => apiClient.post<ReindexPaperResponse>(`/papers/${id}/reindex`),
  delete: (id: string) => apiClient.delete(`/papers/${id}`),
  getFileUrl: (id: string) => `/api/papers/${id}/file`,
  getBlocks: (id: string, page?: number) =>
    apiClient.get(`/papers/${id}/blocks`, { params: page != null ? { page } : {} }),
  getPageSource: (id: string, page: number) =>
    apiClient.get<PaperPageSourceResponse>(`/papers/${id}/page-source`, { params: { page } }),
  getMarkdown: (id: string) =>
    apiClient.get<{ paper_id: string; document_type: string; markdown_path: string; content: string }>(`/papers/${id}/markdown`),
}
