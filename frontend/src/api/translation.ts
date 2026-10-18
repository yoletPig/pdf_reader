/**
 * 翻译 API — 已取消快速/严谨双模式（统一单一翻译）。
 * mode 参数仅为兼容旧数据保留，前端不再传递。
 */
import apiClient from './client'

export interface TranslateRequest {
  paper_id: string
  block_id: string
  text: string
  /** 上下文（如所在段落前后文、页码说明），帮助模型理解语境 */
  context?: string
  previous_summary?: string
  reference_pages?: string
  /** 重新翻译：跳过缓存强制生成 */
  force?: boolean
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

export interface TranslatePageRequest {
  paper_id: string
  page_number: number
  /** 重新翻译当前页 */
  force?: boolean
  pdfjs_text?: string
}

export interface UpdateTranslatedPageRequest {
  paper_id: string
  page_number: number
  translated_markdown: string
  user_notes?: string
}

export interface TranslatePageResponse {
  paper_id: string
  page_number: number
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
  /** 翻译片段（选中文字 / 段落） */
  translate: (data: TranslateRequest) =>
    apiClient.post<TranslateResponse>('/translate', data),
  /** 读取某页已有译文 */
  getTranslatedPage: (paperId: string, pageNumber: number) =>
    apiClient.get<TranslatePageResponse>('/translate/page', {
      params: { paper_id: paperId, page_number: pageNumber },
    }),
  /** 翻译某页（force=true 时重新翻译） */
  translatePage: (data: TranslatePageRequest) =>
    apiClient.post<TranslatePageResponse>('/translate/page', data),
  /** 保存用户修订的译文 */
  updateTranslatedPage: (data: UpdateTranslatedPageRequest) =>
    apiClient.put<TranslatePageResponse>('/translate/page', data),
}
