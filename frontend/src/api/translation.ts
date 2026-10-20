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
  /** 翻译某页（force=true 时重新翻译）；阻塞式，流式版见 streamTranslatePage */
  translatePage: (data: TranslatePageRequest) =>
    apiClient.post<TranslatePageResponse>('/translate/page', data),
  /** 保存用户修订的译文 */
  updateTranslatedPage: (data: UpdateTranslatedPageRequest) =>
    apiClient.put<TranslatePageResponse>('/translate/page', data),
}

/** 页翻译流式事件（SSE 帧） */
export interface TranslatePageStreamEvent {
  /** thinking: 模型思考增量；delta: 译文增量；result: 最终结果；error: 失败 */
  type: 'thinking' | 'delta' | 'result' | 'error'
  data: {
    attempt?: number
    text?: string
    message?: string
    [key: string]: any
  }
}

/**
 * 流式页翻译（SSE）：边生成边返回增量，避免长页面翻译被超时中断。
 * 返回 controller 便于取消；onEvent(type, data) 逐帧回调。
 */
export async function streamTranslatePage(
  data: TranslatePageRequest,
  onEvent: (type: string, data: any) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch('/api/translate/page/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  })
  if (!response.ok || !response.body) {
    throw new Error((await response.text()) || '无法建立翻译流')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const dispatch = (frame: string) => {
    let type = 'message'
    const dataLines: string[] = []
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith('event:')) type = line.slice(6).trim()
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
    }
    if (!dataLines.length) return
    try {
      onEvent(type, JSON.parse(dataLines.join('\n')))
    } catch {
      /* 忽略无法解析的帧 */
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
    const frames = buffer.split(/\r?\n\r?\n/)
    buffer = frames.pop() || ''
    for (const frame of frames) dispatch(frame)
    if (done) break
  }
  if (buffer.trim()) dispatch(buffer)
}
