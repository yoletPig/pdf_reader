import apiClient from './client'

export interface TranslateRequest {
  paper_id: string
  block_id: string
  text: string
  mode: 'quick' | 'polish'
  context?: string
  previous_summary?: string
  reference_pages?: string
  auxiliary_text?: string
}

export interface TranslateResponse {
  paper_id: string
  block_id: string
  original_text: string
  translated_text: string
  mode: string
  from_cache: boolean
  model_used?: string
  tokens_used?: number
}

export interface TranslateCacheEntry {
  paper_id: string
  block_id: string
  original_text: string
  translated_text: string
  mode: string
  model_used?: string
  created_at?: string | null
}

export interface TranslatePageRequest {
  paper_id: string
  page_number: number
  mode: 'quick' | 'polish'
  force?: boolean
  pdfjs_text?: string
}

export interface UpdateTranslatedPageRequest {
  paper_id: string
  page_number: number
  mode: 'quick' | 'polish'
  translated_markdown: string
  user_notes?: string
}

export interface TranslatePageResponse {
  paper_id: string
  page_number: number
  mode: 'quick' | 'polish'
  exists: boolean
  source_text: string
  source_markdown: string
  translated_markdown: string
  translated_markdown_path?: string
  previous_summary?: string
  from_cache: boolean
  model_used?: string
  tokens_used?: number
  edited_by_user?: boolean
  edited_at?: string | null
  user_notes?: string
  source_matches_cache?: boolean
}

export const translationApi = {
  translate: (data: TranslateRequest) =>
    apiClient.post<TranslateResponse>('/translate', data),
  getCache: (paperId: string) =>
    apiClient.get(`/translate/cache/${paperId}`),
  getCacheEntry: (paperId: string, blockId: string, mode: 'quick' | 'polish') =>
    apiClient.get<{ paper_id: string; entry: TranslateCacheEntry | null }>(`/translate/cache/${paperId}/entry`, {
      params: { block_id: blockId, mode },
    }),
  getTranslatedPage: (paperId: string, pageNumber: number, mode: 'quick' | 'polish') =>
    apiClient.get<TranslatePageResponse>('/translate/page', {
      params: { paper_id: paperId, page_number: pageNumber, mode },
    }),
  translatePage: (data: TranslatePageRequest) =>
    apiClient.post<TranslatePageResponse>('/translate/page', data),
  updateTranslatedPage: (data: UpdateTranslatedPageRequest) =>
    apiClient.put<TranslatePageResponse>('/translate/page', data),
}
