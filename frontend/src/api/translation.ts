import apiClient from './client'

export interface TranslateRequest {
  paper_id: string
  block_id: string
  text: string
  mode: 'quick' | 'polish'
  context?: string
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
}

export interface TranslatePageBlock {
  block_id: string
  original_text: string
  translated_text: string
  from_cache: boolean
}

export interface TranslatePageResponse {
  paper_id: string
  page_number: number
  blocks: TranslatePageBlock[]
  total_blocks: number
  cached_blocks: number
  model_used?: string
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
  translatePage: (data: TranslatePageRequest) =>
    apiClient.post<TranslatePageResponse>('/translate/page', data),
}
