import apiClient from './client'

export interface Paper {
  id: string
  title: string
  authors: string
  abstract: string
  year: number | null
  source: string
  source_id: string
  file_path: string
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
  get: (id: string) => apiClient.get<Paper>(`/papers/${id}`),
  updateReaderProfile: (id: string, data: Record<string, any>) =>
    apiClient.patch<Paper>(`/papers/${id}/reader-profile`, data),
  refreshReaderProfile: (id: string, data: { mode: 'quick' | 'polish'; profile?: Record<string, any> }) =>
    apiClient.post<Paper>(`/papers/${id}/reader-profile/refresh`, data),
  upload: (formData: FormData) =>
    apiClient.post<UploadResponse>('/papers/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  delete: (id: string) => apiClient.delete(`/papers/${id}`),
  getFileUrl: (id: string) => `/api/papers/${id}/file`,
  getBlocks: (id: string, page?: number) =>
    apiClient.get(`/papers/${id}/blocks`, { params: page != null ? { page } : {} }),
}
