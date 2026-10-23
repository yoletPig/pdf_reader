/**
 * 每日论文 API - HuggingFace / ModelScope
 */
import apiClient from './client'

export type DailyPaperSource = 'huggingface' | 'modelscope'

export interface DailyPaper {
  source: DailyPaperSource
  id: string
  title: string
  authors: string[]
  abstract: string
  url: string
  pdf_url: string
  published_at: string
  upvotes: number
  comments: number
  code_url: string
  thumbnail: string
  keywords: string[]
  rating: number
}

export interface DailyPapersResponse {
  date: string
  papers: DailyPaper[]
  sources: Partial<Record<DailyPaperSource, number>>
}

export const dailyPapersApi = {
  list: (params?: { source?: string; date?: string; refresh?: boolean; limit?: number }) =>
    apiClient.get<DailyPapersResponse>('/daily-papers', { params }),
}
