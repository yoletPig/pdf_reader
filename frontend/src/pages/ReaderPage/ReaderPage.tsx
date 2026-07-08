import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Document, Page, pdfjs } from 'react-pdf'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

import { agentRunsApi } from '../../api/agent-runs'
import { papersApi, Paper } from '../../api/papers'
import { translationApi } from '../../api/translation'
import { usePDFStore } from '../../stores/pdf-store'
import { useTranslationStore } from '../../stores/translation-store'
import styles from './ReaderPage.module.css'

import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'katex/dist/katex.min.css'

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

type ReaderMode = 'quick' | 'polish'
type ReaderTab = 'profile' | 'selection' | 'qa' | 'full'
type ReadStatus = 'idle' | 'reading' | 'ready' | 'empty' | 'error'

type PageDocument = {
  markdown: string
  sourceText: string
  modelUsed?: string
}

type QaMessage = {
  id: string
  role: 'user' | 'assistant'
  content: string
  sources?: Array<{
    paper_title: string
    page: number
    chunk_text: string
  }>
  traceSummary?: {
    event_count?: number
    tool_calls?: number
    llm_calls?: number
  }
}

type ReaderProfile = {
  auto_full_translation_enabled?: boolean
  auto_full_translation_mode?: ReaderMode
  auto_full_translation_status?: 'idle' | 'running' | 'completed' | 'failed'
  translated_pages?: number
  total_pages?: number
  failed_pages?: number[]
  summary_translation_mode?: ReaderMode
  last_summary_refresh_at?: string | null
}

const PDF_HIGHLIGHT_CLASS = 'pdf-text-highlight'

const LIGATURE_MAP: Record<string, string> = {
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
}

const TAB_LABELS: Record<ReaderTab, string> = {
  full: '全文翻译',
  selection: '选词翻译',
  qa: 'Paper QA',
  profile: '论文画像',
}

function replaceLigatures(text: string) {
  return text.replace(/[ﬀﬁﬂﬃﬄ]/g, (char) => LIGATURE_MAP[char] || char)
}

function looksLikeFormulaLine(line: string) {
  const formulaSignals = line.match(/[=+\-*/^_≤≥≈∑∏√λμστωαβγδΔ(){}\[\]]/g) || []
  const asciiWords = line.match(/[A-Za-z]{3,}/g) || []
  return formulaSignals.length >= 3 || (formulaSignals.length >= 1 && asciiWords.length === 0)
}

function shouldDropLine(line: string) {
  const normalized = line.trim()
  if (!normalized) return true
  if (/^\d+$/.test(normalized)) return true
  if (/^page\s+\d+(\s+of\s+\d+)?$/i.test(normalized)) return true
  if (/^(arxiv|doi)\s*:/i.test(normalized) && normalized.length < 40) return true
  return false
}

function normalizePageText(text: string) {
  const cleaned = replaceLigatures(text)
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\u00ad/g, '')
    .replace(/[ \t]+/g, ' ')

  const rawLines = cleaned
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => !shouldDropLine(line))

  const merged: string[] = []

  for (const line of rawLines) {
    if (!merged.length) {
      merged.push(line)
      continue
    }

    const prev = merged[merged.length - 1]
    const prevFormula = looksLikeFormulaLine(prev)
    const currFormula = looksLikeFormulaLine(line)

    if (/-$/.test(prev) && /^[a-z]/.test(line)) {
      merged[merged.length - 1] = `${prev.slice(0, -1)}${line}`
      continue
    }

    const shouldJoin =
      !prevFormula &&
      !currFormula &&
      !/[。！？.!?:;)\]）]$/.test(prev) &&
      !/^(Figure|Table|Algorithm|Lemma|Theorem|Proof)\b/i.test(line)

    if (shouldJoin) {
      merged[merged.length - 1] = `${prev} ${line}`
    } else {
      merged.push(line)
    }
  }

  return merged.join('\n\n')
}

function preprocessMarkdown(text: string) {
  return text
    .replace(/\\\[((?:.|\n)*?)\\\]/g, '\n$$\n$1\n$$\n')
    .replace(
      /\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}(?:\s*\\tag\{[^}]+\})?/g,
      (match, _env, offset: number, source: string) => {
        const before = source.slice(Math.max(0, offset - 3), offset)
        const after = source.slice(offset + match.length, offset + match.length + 3)
        if (before.includes('$$') || after.includes('$$')) {
          return match
        }
        return `\n$$\n${String(match).trim()}\n$$\n`
      },
    )
    .replace(/\\\((.+?)\\\)/g, (_, expr) => `$${String(expr).trim()}$`)
}

function MarkdownBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore' }]]}
    >
      {preprocessMarkdown(content)}
    </ReactMarkdown>
  )
}

export default function ReaderPage() {
  const { id } = useParams<{ id: string }>()
  const pdfViewportRef = useRef<HTMLDivElement | null>(null)
  const highlightQueryRef = useRef('')
  const pdfDocRef = useRef<any>(null)
  const pageTextsRef = useRef<Record<number, string>>({})
  const pageDocumentsRef = useRef<Record<string, PageDocument>>({})
  const paperRef = useRef<Paper | null>(null)
  const pendingTextLoadsRef = useRef(new Map<number, Promise<string>>())
  const autoTranslateRunRef = useRef(0)
  const [paper, setPaper] = useState<Paper | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scale, setScale] = useState(1.15)
  const [pdfDoc, setPdfDoc] = useState<any>(null)
  const [activeTab, setActiveTab] = useState<ReaderTab>('full')
  const [isDebugOpen, setIsDebugOpen] = useState(false)
  const [isQaLoading, setIsQaLoading] = useState(false)
  const [isPageTranslating, setIsPageTranslating] = useState(false)
  const [isSelectionTranslating, setIsSelectionTranslating] = useState(false)
  const [showFullSource, setShowFullSource] = useState(true)
  const [isAutoFullTranslateEnabled, setIsAutoFullTranslateEnabled] = useState(false)
  const [isAutoTranslating, setIsAutoTranslating] = useState(false)
  const [isRefreshingSummary, setIsRefreshingSummary] = useState(false)
  const [autoTranslateProgress, setAutoTranslateProgress] = useState({ completed: 0, total: 0, failedPages: [] as number[] })
  const [pageDocuments, setPageDocuments] = useState<Record<string, PageDocument>>({})
  const [pageTexts, setPageTexts] = useState<Record<number, string>>({})
  const [pageReadStatus, setPageReadStatus] = useState<Record<number, ReadStatus>>({})
  const [pageReadMessages, setPageReadMessages] = useState<Record<number, string>>({})
  const [qaMessages, setQaMessages] = useState<QaMessage[]>([])
  const [qaInput, setQaInput] = useState('')

  const pendingPageKeysRef = useRef(new Set<string>())
  const pendingTranslationTasksRef = useRef(new Map<string, Promise<PageDocument | undefined>>())

  const {
    currentPage,
    setPage,
    setTotalPages,
    selectedText,
    setSelection,
    clearSelection,
    setPaper: setCurrentPaper,
  } = usePDFStore()
  const currentMode = useTranslationStore((s) => s.currentMode)
  const setMode = useTranslationStore((s) => s.setMode)
  const cache = useTranslationStore((s) => s.cache)
  const setCache = useTranslationStore((s) => s.setCache)

  useEffect(() => {
    if (!id) return

    setError('')
    setCurrentPaper(id)
    setPage(1)
    setTotalPages(0)
    clearSelection()
    setPdfDoc(null)
    setPageDocuments({})
    setPageTexts({})
    setPageReadStatus({})
    setPageReadMessages({})
    setQaMessages([])
    setQaInput('')
    setActiveTab('full')
    setIsAutoFullTranslateEnabled(false)
    setIsAutoTranslating(false)
    setIsRefreshingSummary(false)
    setAutoTranslateProgress({ completed: 0, total: 0, failedPages: [] })
    autoTranslateRunRef.current += 1
    pendingTextLoadsRef.current.clear()
    pendingTranslationTasksRef.current.clear()
    setLoading(true)

    papersApi
      .get(id)
      .then((res) => {
        const loadedPaper = res.data
        const profile = (loadedPaper.reader_profile || {}) as ReaderProfile
        setPaper(loadedPaper)
        setIsAutoFullTranslateEnabled(Boolean(profile.auto_full_translation_enabled))
        setAutoTranslateProgress({
          completed: profile.translated_pages || 0,
          total: profile.total_pages || loadedPaper.page_count || 0,
          failedPages: profile.failed_pages || [],
        })
      })
      .catch((err) => setError('加载论文信息失败: ' + err.message))
  }, [id, clearSelection, setCurrentPaper, setPage, setTotalPages])

  useEffect(() => {
    clearSelection()
  }, [currentPage, clearSelection])

  useEffect(() => {
    pdfDocRef.current = pdfDoc
  }, [pdfDoc])

  useEffect(() => {
    pageTextsRef.current = pageTexts
  }, [pageTexts])

  useEffect(() => {
    pageDocumentsRef.current = pageDocuments
  }, [pageDocuments])

  useEffect(() => {
    paperRef.current = paper
  }, [paper])

  const pageDocKey = id ? `${id}:${currentPage}:${currentMode}` : ''
  const currentPageDocument = pageDocKey ? pageDocuments[pageDocKey] : undefined
  const currentPageText = pageTexts[currentPage] || ''
  const currentReadStatus = pageReadStatus[currentPage] || 'idle'
  const currentReadMessage = pageReadMessages[currentPage] || ''
  const selectionCacheKey = selectedText ? `${currentPage}:${selectedText.slice(0, 80)}` : ''
  const currentSelectionTranslation = selectionCacheKey ? (cache[selectionCacheKey]?.[currentMode] ?? '') : ''
  const pdfUrl = id ? papersApi.getFileUrl(id) : ''
  const readerProfile = (paper?.reader_profile || {}) as ReaderProfile
  const autoTranslateTotal = numPages || paper?.page_count || readerProfile.total_pages || 0
  const hasCompletedCurrentProfile =
    Boolean(paper?.ai_summary_md) &&
    readerProfile.summary_translation_mode === currentMode &&
    readerProfile.auto_full_translation_status === 'completed' &&
    (readerProfile.translated_pages || 0) >= autoTranslateTotal

  useEffect(() => {
    setShowFullSource(!currentPageDocument?.markdown)
  }, [currentPageDocument?.markdown, currentPage, currentMode])

  const statusLabel = useMemo(() => {
    switch (currentReadStatus) {
      case 'reading':
        return '提取中'
      case 'ready':
        return '提取完成'
      case 'empty':
        return '无可提取文本'
      case 'error':
        return '提取失败'
      default:
        return '等待提取'
    }
  }, [currentReadStatus])

  const onDocumentLoadSuccess = (pdf: any) => {
    setPdfDoc(pdf)
    setNumPages(pdf.numPages)
    setTotalPages(pdf.numPages)
    setAutoTranslateProgress((prev) => ({ ...prev, total: prev.total || pdf.numPages }))
    setLoading(false)
  }

  const onDocumentLoadError = (err: Error) => {
    setError('PDF 加载失败: ' + err.message)
    setLoading(false)
  }

  const handlePdfSelection = () => {
    const selection = window.getSelection()
    if (!selection || !selection.toString().trim() || !pdfViewportRef.current) {
      return
    }

    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    const commonAncestor = range?.commonAncestorContainer
    const selectionRoot =
      commonAncestor?.nodeType === Node.TEXT_NODE ? commonAncestor.parentElement : (commonAncestor as Element | null)

    if (!selectionRoot || !pdfViewportRef.current.contains(selectionRoot)) {
      return
    }

    setSelection(selection.toString().trim(), null)
    setActiveTab('selection')
  }

  const applyTextHighlight = (query: string) => {
    const textLayer = pdfViewportRef.current?.querySelector('.react-pdf__Page__textContent')
    if (!textLayer) return

    const spans = Array.from(textLayer.querySelectorAll('span')) as HTMLSpanElement[]
    spans.forEach((span) => span.classList.remove(PDF_HIGHLIGHT_CLASS))

    const normalizedQuery = query.trim().replace(/\s+/g, ' ').toLowerCase()
    if (!normalizedQuery) return

    const keywords = normalizedQuery
      .split(/\s+/)
      .filter((word) => word.length >= 3)
      .slice(0, 8)

    let firstMatch: HTMLSpanElement | null = null
    for (const span of spans) {
      const content = span.textContent?.trim().replace(/\s+/g, ' ').toLowerCase() || ''
      if (!content) continue

      const matched =
        normalizedQuery.includes(content) ||
        content.includes(normalizedQuery) ||
        keywords.some((word) => content.includes(word))

      if (matched) {
        span.classList.add(PDF_HIGHLIGHT_CLASS)
        if (!firstMatch) firstMatch = span
      }
    }

    firstMatch?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' })
  }

  const ensurePageText = async (pageNumber: number) => {
    const cachedText = pageTextsRef.current[pageNumber]
    if (cachedText?.trim()) {
      return cachedText
    }

    const inflight = pendingTextLoadsRef.current.get(pageNumber)
    if (inflight) {
      return inflight
    }

    const task = (async () => {
      if (!pdfDocRef.current) {
        return ''
      }

      setPageReadStatus((prev) => ({ ...prev, [pageNumber]: 'reading' }))
      setPageReadMessages((prev) => ({ ...prev, [pageNumber]: '正在从当前页 PDF 文本层提取内容...' }))

      try {
        const pdfPage = await pdfDocRef.current.getPage(pageNumber)
        const textContent = await pdfPage.getTextContent()
        const text = normalizePageText(
          (textContent?.items || [])
            .map((item: any) => ('str' in item ? item.str : ''))
            .join('\n'),
        )

        setPageTexts((prev) => ({ ...prev, [pageNumber]: text }))
        if (text) {
          setPageReadStatus((prev) => ({ ...prev, [pageNumber]: 'ready' }))
          setPageReadMessages((prev) => ({ ...prev, [pageNumber]: '' }))
        } else {
          setPageReadStatus((prev) => ({ ...prev, [pageNumber]: 'empty' }))
          setPageReadMessages((prev) => ({
            ...prev,
            [pageNumber]: '当前页没有可提取文本，可能是扫描页或图片页。请手动框选内容进行翻译。',
          }))
        }
        return text
      } catch (readError: any) {
        console.error('读取当前页文本失败:', readError)
        setPageTexts((prev) => ({ ...prev, [pageNumber]: '' }))
        setPageReadStatus((prev) => ({ ...prev, [pageNumber]: 'error' }))
        setPageReadMessages((prev) => ({
          ...prev,
          [pageNumber]: `当前页文本读取失败：${readError?.message || '未知错误'}`,
        }))
        return ''
      }
    })()

    pendingTextLoadsRef.current.set(pageNumber, task)
    try {
      return await task
    } finally {
      pendingTextLoadsRef.current.delete(pageNumber)
    }
  }

  useEffect(() => {
    if (!pdfDoc) return
    void ensurePageText(currentPage)
  }, [pdfDoc, currentPage])

  const handleTranslateSelection = async (mode: ReaderMode) => {
    if (!selectedText || !id) return

    const cacheKey = `${currentPage}:${selectedText.slice(0, 80)}`
    if (cache[cacheKey]?.[mode]) {
      setMode(mode)
      setActiveTab('selection')
      return
    }

    setMode(mode)
    setActiveTab('selection')
    setIsSelectionTranslating(true)
    try {
      const res = await translationApi.translate({
        paper_id: id,
        block_id: cacheKey,
        text: selectedText,
        mode,
        context: `${paper?.title || 'PDF'} 第 ${currentPage} 页片段`,
      })
      setCache(cacheKey, mode, res.data.translated_text)
    } catch (translateError) {
      console.error('片段翻译失败:', translateError)
    } finally {
      setIsSelectionTranslating(false)
    }
  }

  const loadPersistedPageDocument = async (pageNumber: number, mode: ReaderMode) => {
    if (!id) return undefined

    const key = `${id}:${pageNumber}:${mode}`
    if (pageDocumentsRef.current[key]) {
      return pageDocumentsRef.current[key]
    }

    try {
      const res = await translationApi.getCacheEntry(id, `page-${pageNumber}-${mode}`, mode)
      const entry = res.data.entry
      if (!entry?.translated_text?.trim()) {
        return undefined
      }

      const restoredDocument = {
        markdown: entry.translated_text,
        sourceText: entry.original_text || pageTextsRef.current[pageNumber] || '',
        modelUsed: entry.model_used,
      }
      setPageDocuments((prev) => ({
        ...prev,
        [key]: restoredDocument,
      }))
      if (entry.original_text?.trim()) {
        setPageTexts((prev) => (prev[pageNumber] ? prev : { ...prev, [pageNumber]: entry.original_text }))
      }
      return restoredDocument
    } catch (cacheError) {
      console.error(`读取第 ${pageNumber} 页持久化译文失败:`, cacheError)
      return undefined
    }
  }

  const translatePageDocument = async (pageNumber: number, mode: ReaderMode, force = false) => {
    if (!id) return undefined

    const key = `${id}:${pageNumber}:${mode}`
    if (!force && pageDocumentsRef.current[key]) {
      return pageDocumentsRef.current[key]
    }

    if (!force) {
      const restored = await loadPersistedPageDocument(pageNumber, mode)
      if (restored) {
        return restored
      }
    }

    const existingTask = pendingTranslationTasksRef.current.get(key)
    if (existingTask) {
      return existingTask
    }

    const task = (async () => {
      const pageText = await ensurePageText(pageNumber)
      if (!pageText.trim()) {
        return undefined
      }

      pendingPageKeysRef.current.add(key)
      try {
        const res = await translationApi.translate({
          paper_id: id,
          block_id: `page-${pageNumber}-${mode}`,
          text: pageText,
          mode,
          context: `${paperRef.current?.title || 'PDF'} 第 ${pageNumber} 页全文`,
        })

        const nextDocument = {
          markdown: res.data.translated_text || '',
          sourceText: pageText,
          modelUsed: res.data.model_used,
        }
        setPageDocuments((prev) => ({
          ...prev,
          [key]: nextDocument,
        }))
        return nextDocument
      } finally {
        pendingPageKeysRef.current.delete(key)
      }
    })()

    pendingTranslationTasksRef.current.set(key, task)
    try {
      return await task
    } finally {
      pendingTranslationTasksRef.current.delete(key)
    }
  }

  const refreshReaderProfile = async (mode: ReaderMode, profile: Record<string, any>) => {
    if (!id) return
    setIsRefreshingSummary(true)
    try {
      const res = await papersApi.refreshReaderProfile(id, { mode, profile })
      setPaper(res.data)
    } catch (profileError) {
      console.error('刷新论文画像失败:', profileError)
    } finally {
      setIsRefreshingSummary(false)
    }
  }

  const handleTranslateFullPage = async (force = false) => {
    if (!id || !currentPageText.trim()) return

    setIsPageTranslating(true)
    try {
      const translated = await translatePageDocument(currentPage, currentMode, force)
      if (translated?.markdown) {
        setShowFullSource(false)
      }
      setActiveTab('full')
    } catch (translateError) {
      console.error('全文翻译失败:', translateError)
    } finally {
      setIsPageTranslating(false)
    }
  }

  const handleAutoFullTranslateToggle = async () => {
    if (!id) return

    const nextEnabled = !isAutoFullTranslateEnabled
    setIsAutoFullTranslateEnabled(nextEnabled)

    if (!nextEnabled) {
      autoTranslateRunRef.current += 1
      setIsAutoTranslating(false)
    }

    try {
      const res = await papersApi.updateReaderProfile(id, {
        auto_full_translation_enabled: nextEnabled,
        auto_full_translation_mode: currentMode,
        auto_full_translation_status: nextEnabled ? 'running' : 'idle',
        translated_pages: nextEnabled ? autoTranslateProgress.completed : 0,
        total_pages: numPages || paper?.page_count || 0,
        failed_pages: nextEnabled ? autoTranslateProgress.failedPages : [],
      })
      setPaper(res.data)
    } catch (profileError) {
      console.error('更新自动翻译状态失败:', profileError)
    }
  }

  useEffect(() => {
    if (!isAutoFullTranslateEnabled || !id || !pdfDoc || numPages <= 0 || hasCompletedCurrentProfile) {
      return
    }

    const runId = autoTranslateRunRef.current + 1
    autoTranslateRunRef.current = runId
    let cancelled = false

    setIsAutoTranslating(true)
    setAutoTranslateProgress((prev) => ({
      completed: prev.completed,
      total: numPages,
      failedPages: prev.failedPages,
    }))

    void (async () => {
      const failedPages = new Set<number>()
      let completed = 0

      for (let pageNumber = 1; pageNumber <= numPages; pageNumber += 1) {
        if (cancelled || autoTranslateRunRef.current !== runId) {
          return
        }

        try {
          const translated = await translatePageDocument(pageNumber, currentMode, false)
          if (translated?.markdown) {
            completed += 1
          } else {
            failedPages.add(pageNumber)
          }
        } catch (autoTranslateError) {
          console.error(`后台翻译第 ${pageNumber} 页失败:`, autoTranslateError)
          failedPages.add(pageNumber)
        }

        setAutoTranslateProgress({
          completed,
          total: numPages,
          failedPages: Array.from(failedPages).sort((a, b) => a - b),
        })
      }

      if (cancelled || autoTranslateRunRef.current !== runId) {
        return
      }

      const finalFailedPages = Array.from(failedPages).sort((a, b) => a - b)
      await refreshReaderProfile(currentMode, {
        auto_full_translation_enabled: true,
        auto_full_translation_mode: currentMode,
        auto_full_translation_status: finalFailedPages.length && completed === 0 ? 'failed' : 'completed',
        translated_pages: completed,
        total_pages: numPages,
        failed_pages: finalFailedPages,
      })
      setIsAutoTranslating(false)
    })()

    return () => {
      cancelled = true
      if (autoTranslateRunRef.current === runId) {
        setIsAutoTranslating(false)
      }
    }
  }, [isAutoFullTranslateEnabled, id, pdfDoc, numPages, currentMode, hasCompletedCurrentProfile])

  useEffect(() => {
    if (!id || !currentPage || currentPageDocument?.markdown) {
      return
    }
    void loadPersistedPageDocument(currentPage, currentMode)
  }, [id, currentPage, currentMode, currentPageDocument?.markdown])

  const submitQa = async (question: string, displayText?: string) => {
    if (!id || !question.trim() || isQaLoading) return

    setActiveTab('qa')
    setQaMessages((prev) => [
      ...prev,
      {
        id: `${Date.now()}-user`,
        role: 'user',
        content: displayText || question,
      },
    ])
    setQaInput('')
    setIsQaLoading(true)

    try {
      const res = await agentRunsApi.createPaperQA({
        input: {
          question,
          paper_id: id,
          top_k: 8,
        },
        context: {
          paper_id: id,
          selected_text: selectedText || undefined,
        },
      })
      const data = res.data as any
      setQaMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-assistant`,
          role: 'assistant',
          content: data.answer?.content || '抱歉，暂时无法回答这个问题。',
          sources: data.answer?.sources || [],
          traceSummary: data.answer?.trace_summary,
        },
      ])
    } catch (qaError) {
      console.error('Paper QA 失败:', qaError)
      setQaMessages((prev) => [
        ...prev,
        {
          id: `${Date.now()}-assistant`,
          role: 'assistant',
          content: '抱歉，当前问答请求失败。请稍后重试。',
        },
      ])
    } finally {
      setIsQaLoading(false)
    }
  }

  const handleAskSelection = async () => {
    if (!selectedText) return
    const prompt = `请结合当前论文语境解释下面这段内容，并用要点形式给出结论和依据：\n\n${selectedText}`
    const display = `### 选中文本提问\n\n> ${selectedText}`
    await submitQa(prompt, display)
  }

  const focusSourceText = (text: string, page?: number) => {
    if (!text.trim()) return
    highlightQueryRef.current = text
    if (page && page !== currentPage) {
      setPage(page)
    } else {
      window.requestAnimationFrame(() => applyTextHighlight(text))
    }
    setSelection(text, null)
    setActiveTab('selection')
  }

  const handlePageTextSuccess = (textContent: any) => {
    const text = normalizePageText(
      (textContent?.items || [])
        .map((item: any) => ('str' in item ? item.str : ''))
        .join('\n'),
    )

    if (!text) return
    setPageTexts((prev) => (prev[currentPage] === text ? prev : { ...prev, [currentPage]: text }))
    setPageReadStatus((prev) => ({ ...prev, [currentPage]: 'ready' }))
    setPageReadMessages((prev) => ({ ...prev, [currentPage]: '' }))
  }

  const handlePageTextError = (textError: Error) => {
    console.error('TextLayer 读取失败:', textError)
    setPageReadStatus((prev) => ({ ...prev, [currentPage]: 'error' }))
    setPageReadMessages((prev) => ({
      ...prev,
      [currentPage]: `TextLayer 读取失败：${textError.message || '未知错误'}`,
    }))
  }

  const handleTextLayerRender = () => {
    if (highlightQueryRef.current) {
      window.requestAnimationFrame(() => applyTextHighlight(highlightQueryRef.current))
    }
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.errorState}>
          <p>❌ {error}</p>
          <Link to="/" className={styles.backLink}>
            返回首页
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <div className={styles.workspace}>
        <section className={styles.pdfPane}>
          <div className={styles.floatingChrome}>
            <Link to="/" className={styles.backLink}>
              返回
            </Link>
            <div className={styles.titleBadge}>{paper?.title || '阅读工作台'}</div>
            <div className={styles.controlCluster}>
              <div className={styles.controlGroup}>
                <button className={styles.controlBtn} onClick={() => setPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1}>
                  ◀
                </button>
                <span className={styles.controlInfo}>
                  {currentPage} / {numPages || '?'}
                </span>
                <button
                  className={styles.controlBtn}
                  onClick={() => setPage(Math.min(numPages, currentPage + 1))}
                  disabled={currentPage >= numPages}
                >
                  ▶
                </button>
              </div>
              <div className={styles.controlGroup}>
                <button className={styles.controlBtn} onClick={() => setScale((value) => Math.max(0.75, value - 0.1))}>
                  −
                </button>
                <span className={styles.controlInfo}>{Math.round(scale * 100)}%</span>
                <button className={styles.controlBtn} onClick={() => setScale((value) => Math.min(2.2, value + 0.1))}>
                  +
                </button>
              </div>
            </div>
          </div>

          <div ref={pdfViewportRef} className={styles.pdfViewport} onMouseUp={handlePdfSelection}>
            {loading && (
              <div className={styles.loadingState}>
                <div className={styles.spinner} />
                <p>加载 PDF 中...</p>
              </div>
            )}

            {pdfUrl && (
              <Document
                file={pdfUrl}
                onLoadSuccess={onDocumentLoadSuccess}
                onLoadError={onDocumentLoadError}
                loading={
                  <div className={styles.loadingState}>
                    <div className={styles.spinner} />
                    <p>加载 PDF 中...</p>
                  </div>
                }
              >
                <Page
                  pageNumber={currentPage}
                  scale={scale}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  onGetTextSuccess={handlePageTextSuccess}
                  onGetTextError={handlePageTextError}
                  onRenderTextLayerSuccess={handleTextLayerRender}
                  devicePixelRatio={Math.min(3, window.devicePixelRatio || 1)}
                  className={styles.pdfPage}
                />
              </Document>
            )}
          </div>

          {selectedText && (
            <div className={styles.selectionDock}>
              <button className={styles.dockBtn} onClick={() => void handleTranslateSelection('quick')}>
                快速翻译
              </button>
              <button className={styles.dockBtn} onClick={() => void handleTranslateSelection('polish')}>
                严谨翻译
              </button>
              <button className={styles.dockBtn} onClick={() => void handleAskSelection()}>
                发起 QA
              </button>
            </div>
          )}
        </section>

        <section className={styles.sidePane}>
          <div className={styles.tabBar}>
            {(Object.keys(TAB_LABELS) as ReaderTab[]).map((tab) => (
              <button
                key={tab}
                className={`${styles.tabBtn} ${activeTab === tab ? styles.tabBtnActive : ''}`}
                onClick={() => setActiveTab(tab)}
              >
                {TAB_LABELS[tab]}
              </button>
            ))}
            <div className={styles.statusCluster}>
              <span className={styles.statusChip}>{statusLabel}</span>
              <span className={styles.statusChip}>{currentPageText.length} chars</span>
              {isAutoFullTranslateEnabled ? (
                <span className={styles.statusChip}>
                  全文 {autoTranslateProgress.completed}/{autoTranslateProgress.total || numPages || '?'}
                </span>
              ) : null}
            </div>
          </div>

          <div className={styles.sideContent}>
            {activeTab === 'full' && (
              <div className={styles.tabPanel}>
                <div className={styles.panelHeader}>
                  <div>
                    <strong>当前页全文翻译</strong>
                    <span className={styles.panelHint}>手动打开后台全文翻译后，会顺序翻译整篇论文并生成论文画像；已完成的画像不会在重新进入页面时重复刷新。</span>
                  </div>
                  <div className={styles.panelActions}>
                    <button
                      className={`${styles.modeChip} ${currentMode === 'quick' ? styles.modeChipActive : ''}`}
                      onClick={() => setMode('quick')}
                    >
                      快速
                    </button>
                    <button
                      className={`${styles.modeChip} ${currentMode === 'polish' ? styles.modeChipActive : ''}`}
                      onClick={() => setMode('polish')}
                    >
                      严谨
                    </button>
                    <button
                      className={styles.primaryAction}
                      onClick={() => void handleTranslateFullPage(true)}
                      disabled={!currentPageText || currentReadStatus === 'reading' || isPageTranslating}
                    >
                      {isPageTranslating ? '翻译中...' : '翻译当前页'}
                    </button>
                    <button className={styles.secondaryAction} onClick={() => void handleAutoFullTranslateToggle()}>
                      {isAutoFullTranslateEnabled ? '关闭后台全文翻译' : '开启后台全文翻译'}
                    </button>
                    {currentPageDocument?.markdown ? (
                      <button className={styles.secondaryAction} onClick={() => setShowFullSource((value) => !value)}>
                        {showFullSource ? '隐藏提取原文' : '查看提取原文'}
                      </button>
                    ) : null}
                  </div>
                </div>

                {currentReadMessage ? <div className={styles.notice}>{currentReadMessage}</div> : null}

                {isAutoFullTranslateEnabled ? (
                  <div className={styles.card}>
                    <div className={styles.cardTitle}>后台全文翻译进度</div>
                    <div className={styles.metaRow}>
                      <span>{isAutoTranslating ? '运行中' : hasCompletedCurrentProfile ? '已完成' : '已停止'}</span>
                      <span>
                        {autoTranslateProgress.completed}/{autoTranslateProgress.total || autoTranslateTotal || 0} 页
                      </span>
                      <span>模式 {currentMode}</span>
                      {readerProfile.last_summary_refresh_at ? <span>画像已刷新</span> : null}
                    </div>
                    {autoTranslateProgress.failedPages.length ? (
                      <p className={styles.placeholderText}>
                        失败页: {autoTranslateProgress.failedPages.join(', ')}
                      </p>
                    ) : (
                      <p className={styles.placeholderText}>当前没有失败页。</p>
                    )}
                  </div>
                ) : null}

                {showFullSource || !currentPageDocument?.markdown ? (
                  <div className={styles.card}>
                    <div className={styles.cardTitle}>提取原文</div>
                    {currentReadStatus === 'reading' ? (
                      <div className={styles.inlineLoading}>
                        <div className={styles.spinner} />
                        <p>正在读取当前页文本...</p>
                      </div>
                    ) : (
                      <pre className={styles.sourceText}>{currentPageText || '[当前页暂无可提取文本]'}</pre>
                    )}
                  </div>
                ) : null}

                <div className={styles.card}>
                  <div className={styles.cardTitle}>翻译结果</div>
                  {isPageTranslating ? (
                    <div className={styles.inlineLoading}>
                      <div className={styles.spinner} />
                      <p>正在生成 Markdown 翻译...</p>
                    </div>
                  ) : currentPageDocument?.markdown ? (
                    <>
                      {currentPageDocument.modelUsed ? (
                        <div className={styles.metaRow}>
                          <span>{currentPageDocument.modelUsed}</span>
                        </div>
                      ) : null}
                      <div className={styles.markdownWrap}>
                        <MarkdownBlock content={currentPageDocument.markdown} />
                      </div>
                    </>
                  ) : (
                    <p className={styles.placeholderText}>先确认左侧当前页原文提取正常，再点击“翻译当前页”。</p>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'selection' && (
              <div className={styles.tabPanel}>
                <div className={styles.panelHeader}>
                  <div>
                    <strong>选词翻译</strong>
                    <span className={styles.panelHint}>仅响应左侧 PDF 文本层内的选区。</span>
                  </div>
                  <div className={styles.panelActions}>
                    <button
                      className={`${styles.modeChip} ${currentMode === 'quick' ? styles.modeChipActive : ''}`}
                      onClick={() => setMode('quick')}
                    >
                      快速
                    </button>
                    <button
                      className={`${styles.modeChip} ${currentMode === 'polish' ? styles.modeChipActive : ''}`}
                      onClick={() => setMode('polish')}
                    >
                      严谨
                    </button>
                  </div>
                </div>

                <div className={styles.card}>
                  <div className={styles.cardTitle}>选中文本</div>
                  <div className={styles.selectionScroll}>{selectedText || '请在左侧 PDF 中框选文本。'}</div>
                  {selectedText ? (
                    <div className={styles.inlineActions}>
                      <button className={styles.primaryAction} onClick={() => void handleTranslateSelection(currentMode)} disabled={isSelectionTranslating}>
                        {isSelectionTranslating ? '翻译中...' : '翻译选中文本'}
                      </button>
                      <button className={styles.secondaryAction} onClick={() => void handleAskSelection()} disabled={isQaLoading}>
                        用这段发起 QA
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className={styles.card}>
                  <div className={styles.cardTitle}>翻译结果</div>
                  {isSelectionTranslating ? (
                    <div className={styles.inlineLoading}>
                      <div className={styles.spinner} />
                      <p>正在翻译选中文本...</p>
                    </div>
                  ) : currentSelectionTranslation ? (
                    <div className={styles.markdownWrap}>
                      <MarkdownBlock content={currentSelectionTranslation} />
                    </div>
                  ) : (
                    <p className={styles.placeholderText}>翻译结果会显示在这里。</p>
                  )}
                </div>
              </div>
            )}

            {activeTab === 'qa' && (
              <div className={styles.tabPanel}>
                <div className={styles.panelHeader}>
                  <div>
                    <strong>Paper QA</strong>
                    <span className={styles.panelHint}>默认结合论文画像、摘要和整篇检索结果回答；选中文本只是附加线索。</span>
                  </div>
                </div>

                <div className={styles.qaMessages}>
                  {qaMessages.length === 0 ? (
                    <div className={styles.emptyState}>
                      <p>可以直接问整篇论文的方法、实验、结论，也可以带着选中文本发起问答。</p>
                    </div>
                  ) : (
                    qaMessages.map((message) => (
                      <div key={message.id} className={`${styles.qaMessage} ${styles[message.role]}`}>
                        <div className={styles.qaBubble}>
                          <MarkdownBlock content={message.content} />
                          {message.sources?.length ? (
                            <details className={styles.qaSources}>
                              <summary>引用来源</summary>
                              {message.sources.map((source, index) => (
                                <button
                                  key={`${message.id}-${index}`}
                                  className={styles.qaSourceItem}
                                  onClick={() => focusSourceText(source.chunk_text, source.page)}
                                >
                                  <strong>{source.paper_title}</strong> · p.{source.page}
                                  <p>{source.chunk_text}</p>
                                </button>
                              ))}
                            </details>
                          ) : null}
                        </div>
                      </div>
                    ))
                  )}
                  {isQaLoading && (
                    <div className={`${styles.qaMessage} ${styles.assistant}`}>
                      <div className={styles.qaBubble}>
                        <div className={styles.inlineLoading}>
                          <div className={styles.spinner} />
                          <p>正在分析问题...</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className={styles.qaComposer}>
                  <textarea
                    value={qaInput}
                    onChange={(event) => setQaInput(event.target.value)}
                    placeholder="输入关于当前论文的问题..."
                    className={styles.qaInput}
                    rows={4}
                  />
                  <div className={styles.inlineActions}>
                    <button className={styles.primaryAction} onClick={() => void submitQa(qaInput)} disabled={isQaLoading}>
                      {isQaLoading ? '发送中...' : '发送问题'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {activeTab === 'profile' && (
              <div className={styles.tabPanel}>
                <div className={styles.panelHeader}>
                  <div>
                    <strong>论文画像</strong>
                    <span className={styles.panelHint}>沉淀标题、摘要、PDF 元数据和基于全文译文生成的论文总结。</span>
                  </div>
                  <div className={styles.panelActions}>
                    <button
                      className={styles.secondaryAction}
                      onClick={() => id && void refreshReaderProfile(currentMode, {
                        auto_full_translation_enabled: isAutoFullTranslateEnabled,
                        auto_full_translation_mode: currentMode,
                        auto_full_translation_status: isAutoTranslating ? 'running' : readerProfile.auto_full_translation_status || 'idle',
                        translated_pages: autoTranslateProgress.completed,
                        total_pages: autoTranslateTotal,
                        failed_pages: autoTranslateProgress.failedPages,
                      })}
                      disabled={isRefreshingSummary || autoTranslateProgress.completed === 0}
                    >
                      {isRefreshingSummary ? '刷新中...' : '刷新论文画像'}
                    </button>
                    <button className={styles.secondaryAction} onClick={() => setIsDebugOpen((value) => !value)}>
                      {isDebugOpen ? '隐藏调试' : '显示调试'}
                    </button>
                  </div>
                </div>

                <div className={styles.metaRow}>
                  <span>{paper?.title || '未命名论文'}</span>
                  <span>{autoTranslateTotal} 页</span>
                  <span>{readerProfile.summary_translation_mode || currentMode}</span>
                </div>

                <div className={styles.card}>
                  <div className={styles.cardTitle}>基础元数据</div>
                  <div className={styles.markdownWrap}>
                    <p><strong>标题</strong>: {paper?.title || '暂无'}</p>
                    <p><strong>摘要</strong>: {paper?.abstract || '暂无'}</p>
                    <p><strong>页数</strong>: {paper?.page_count || autoTranslateTotal || 0}</p>
                  </div>
                </div>

                {paper?.pdf_metadata && Object.keys(paper.pdf_metadata).length ? (
                  <div className={styles.card}>
                    <div className={styles.cardTitle}>PDF 元数据</div>
                    <div className={styles.metaGrid}>
                      {Object.entries(paper.pdf_metadata).map(([key, value]) => (
                        <div key={key} className={styles.metaItem}>
                          <strong>{key}</strong>
                          <span>{String(value)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className={styles.card}>
                  <div className={styles.cardTitle}>AI 论文画像</div>
                  {isRefreshingSummary ? (
                    <div className={styles.inlineLoading}>
                      <div className={styles.spinner} />
                      <p>正在刷新论文画像...</p>
                    </div>
                  ) : paper?.ai_summary_md ? (
                    <div className={styles.markdownWrap}>
                      <MarkdownBlock content={paper.ai_summary_md} />
                    </div>
                  ) : (
                    <p className={styles.placeholderText}>开启并完成后台全文翻译后，这里会生成整篇论文的画像与摘要。</p>
                  )}
                </div>

                {isDebugOpen ? (
                  <div className={styles.card}>
                    <div className={styles.cardTitle}>提取调试</div>
                    <ul className={styles.debugList}>
                      <li>如果全文翻译失败页较多，优先检查 PDF 是否为扫描页或图片页。</li>
                      <li>如果 QA 回答偏窄，先刷新论文画像，再重新提问整篇总结类问题。</li>
                      <li>如果公式乱码明显，问题通常在 PDF 提取文本而不是 Markdown 渲染。</li>
                    </ul>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
