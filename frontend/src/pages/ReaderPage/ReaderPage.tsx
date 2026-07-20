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
import { preprocessMarkdown } from '../../utils/markdown'
import styles from './ReaderPage.module.css'

import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'katex/dist/katex.min.css'

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

type ReaderMode = 'quick' | 'polish'
type ReaderTab = 'profile' | 'selection' | 'qa' | 'full'
type ReadStatus = 'idle' | 'reading' | 'ready' | 'empty' | 'error'
type ColumnWidths = [number, number, number]

type PageDocument = {
  markdown: string
  sourceText: string
  modelUsed?: string
  editedByUser?: boolean
  editedAt?: string | null
  userNotes?: string
}

type PageSource = {
  text: string
  markdown: string
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

const DEFAULT_COLUMN_WIDTHS: ColumnWidths = [40, 40, 20]
const MIN_COLUMN_WIDTHS: ColumnWidths = [26, 26, 16]
const STACKED_LAYOUT_BREAKPOINT = 1200
const TOOL_PANE_COLLAPSED_WIDTH = 76

const LIGATURE_MAP: Record<string, string> = {
  'ﬀ': 'ff',
  'ﬁ': 'fi',
  'ﬂ': 'fl',
  'ﬃ': 'ffi',
  'ﬄ': 'ffl',
}

const TAB_LABELS: Record<ReaderTab, string> = {
  profile: '论文画像',
  full: '全文翻译',
  selection: '选词翻译',
  qa: 'Paper QA',
}
const TAB_ORDER: ReaderTab[] = ['profile', 'full', 'selection', 'qa']

function createQaSessionId(scope: string) {
  return `qa:${scope}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

function getQaSessionKey(scope: string) {
  return `pdf-reader:${scope}:qa-session`
}

function replaceLigatures(text: string) {
  return text.replace(/[ﬀﬁﬂﬃﬄ]/g, (char) => LIGATURE_MAP[char] || char)
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function normalizeAbstractText(text: string | undefined) {
  const value = (text || '').trim()
  if (!value) return '暂无摘要'
  if (/^文件大小:\s*\d+\s*bytes$/i.test(value)) return '暂无摘要'
  if (/^PDF 解析失败:/i.test(value)) return '暂无摘要'
  return value
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

type MarkdownImageToken = {
  token: string
  markdown: string
}

function extractMarkdownImages(markdown: string) {
  const images: MarkdownImageToken[] = []
  let index = 0
  const sanitized = markdown.replace(/!\[[^\]]*]\([^)]+\)/g, (match) => {
    const token = `[[DOC_IMAGE_${index}]]`
    images.push({ token, markdown: match })
    index += 1
    return token
  })
  return { sanitized, images }
}

function restoreMarkdownImages(markdown: string, images: MarkdownImageToken[]) {
  let restored = markdown
  const missing: string[] = []
  for (const image of images) {
    if (restored.includes(image.token)) {
      restored = restored.split(image.token).join(image.markdown)
    } else {
      missing.push(image.markdown)
    }
  }
  if (missing.length) {
    const suffix = missing.join('\n\n')
    restored = `${restored.trim()}\n\n${suffix}`.trim()
  }
  return restored
}

function formatSelectionForQa(text: string, page: number) {
  const quoted = text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')

  return `【第 ${page} 页选中文本】\n${quoted}\n\n`
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
  const workspaceRef = useRef<HTMLDivElement | null>(null)
  const pdfViewportRef = useRef<HTMLDivElement | null>(null)
  const qaInputRef = useRef<HTMLTextAreaElement | null>(null)
  const pageTextsRef = useRef<Record<number, string>>({})
  const pdfJsPageTextsRef = useRef<Record<number, string>>({})
  const pageMarkdownsRef = useRef<Record<number, string>>({})
  const pageDocumentsRef = useRef<Record<string, PageDocument>>({})
  const paperRef = useRef<Paper | null>(null)
  const pendingSelectionRef = useRef<{ page: number; text: string } | null>(null)
  const expandedToolPaneWidthRef = useRef(DEFAULT_COLUMN_WIDTHS[2])
  const pendingTextLoadsRef = useRef(new Map<number, Promise<PageSource>>())
  const autoTranslateRunRef = useRef(0)
  const [paper, setPaper] = useState<Paper | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [scale, setScale] = useState(1.15)
  const [activeTab, setActiveTab] = useState<ReaderTab>('profile')
  const [isDebugOpen, setIsDebugOpen] = useState(false)
  const [isQaLoading, setIsQaLoading] = useState(false)
  const [isPageTranslating, setIsPageTranslating] = useState(false)
  const [isSavingPageTranslation, setIsSavingPageTranslation] = useState(false)
  const [isSelectionTranslating, setIsSelectionTranslating] = useState(false)
  const [isEditingPageTranslation, setIsEditingPageTranslation] = useState(false)
  const [pageTranslationDraft, setPageTranslationDraft] = useState('')
  const [pageNotesDraft, setPageNotesDraft] = useState('')
  const [pageEditMessage, setPageEditMessage] = useState('')
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
  const [qaSessionId, setQaSessionId] = useState('')
  const [columnWidths, setColumnWidths] = useState<ColumnWidths>(DEFAULT_COLUMN_WIDTHS)
  const [isToolPaneCollapsed, setIsToolPaneCollapsed] = useState(false)

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
    setPageDocuments({})
    setPageTexts({})
    setPageReadStatus({})
    setPageReadMessages({})
    setQaMessages([])
    setQaInput('')
    setQaSessionId('')
    setActiveTab('profile')
    setIsAutoFullTranslateEnabled(false)
    setIsAutoTranslating(false)
    setIsRefreshingSummary(false)
    setIsEditingPageTranslation(false)
    setIsSavingPageTranslation(false)
    setPageTranslationDraft('')
    setPageNotesDraft('')
    setPageEditMessage('')
    setIsToolPaneCollapsed(false)
    setAutoTranslateProgress({ completed: 0, total: 0, failedPages: [] })
    autoTranslateRunRef.current += 1
    pendingTextLoadsRef.current.clear()
    pendingTranslationTasksRef.current.clear()
    pendingSelectionRef.current = null
    pageMarkdownsRef.current = {}
    setLoading(true)

    papersApi
      .get(id)
      .then((res) => {
        const loadedPaper = res.data
        const profile = (loadedPaper.reader_profile || {}) as ReaderProfile
        const sessionKey = getQaSessionKey(`paper:${id}`)
        const storedSessionId = window.sessionStorage.getItem(sessionKey) || createQaSessionId(`paper:${id}`)
        window.sessionStorage.setItem(sessionKey, storedSessionId)
        setPaper(loadedPaper)
        setQaSessionId(storedSessionId)
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
    const pendingSelection = pendingSelectionRef.current
    if (pendingSelection?.page === currentPage) {
      setSelection(pendingSelection.text, null)
      pendingSelectionRef.current = null
      return
    }
    clearSelection()
  }, [currentPage, clearSelection, setSelection])

  useEffect(() => {
    pageTextsRef.current = pageTexts
  }, [pageTexts])

  useEffect(() => {
    if (!paper) return
    const isPdf =
      (paper.document_type || '').toLowerCase() === 'pdf' ||
      (paper.file_path || '').toLowerCase().endsWith('.pdf')
    if (!isPdf) {
      const total = paper.page_count || Number((paper.reader_profile || {}).total_pages || 0) || 0
      setNumPages(total)
      setTotalPages(total)
      setLoading(false)
    }
  }, [paper, setTotalPages])

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
  const hasPdfPreview = Boolean(
    paper && (
      (paper.document_type || '').toLowerCase() === 'pdf' ||
      (paper.file_path || '').toLowerCase().endsWith('.pdf')
    ),
  )
  const pdfUrl = id && hasPdfPreview ? papersApi.getFileUrl(id) : ''
  const readerProfile = (paper?.reader_profile || {}) as ReaderProfile
  const displayAbstract = normalizeAbstractText(paper?.abstract)
  const autoTranslateTotal = numPages || paper?.page_count || readerProfile.total_pages || 0
  const hasCompletedCurrentProfile =
    Boolean(paper?.ai_summary_md) &&
    readerProfile.summary_translation_mode === currentMode &&
    readerProfile.auto_full_translation_status === 'completed' &&
    (readerProfile.translated_pages || 0) >= autoTranslateTotal
  const canGoPrevPage = currentPage > 1
  const canGoNextPage = numPages > 0 && currentPage < numPages
  const qaPlaceholder = selectedText
    ? `基于第 ${currentPage} 页当前高亮片段提问...`
    : `输入问题，默认结合第 ${currentPage} 页与整篇论文作答...`
  const effectiveMainPaneWidths = useMemo(() => {
    if (!isToolPaneCollapsed) {
      return {
        pdf: columnWidths[0],
        translation: columnWidths[1],
      }
    }

    const total = columnWidths[0] + columnWidths[1]
    if (total <= 0) {
      return {
        pdf: DEFAULT_COLUMN_WIDTHS[0] + DEFAULT_COLUMN_WIDTHS[2] / 2,
        translation: DEFAULT_COLUMN_WIDTHS[1] + DEFAULT_COLUMN_WIDTHS[2] / 2,
      }
    }

    return {
      pdf: Number(((columnWidths[0] / total) * 100).toFixed(2)),
      translation: Number(((columnWidths[1] / total) * 100).toFixed(2)),
    }
  }, [columnWidths, isToolPaneCollapsed])

  useEffect(() => {
    setIsEditingPageTranslation(false)
    setPageTranslationDraft(currentPageDocument?.markdown || '')
    setPageNotesDraft(currentPageDocument?.userNotes || '')
    setPageEditMessage('')
  }, [pageDocKey, currentPageDocument?.markdown, currentPageDocument?.userNotes])

  useEffect(() => {
    setShowFullSource(!currentPageDocument?.markdown)
  }, [currentPageDocument?.markdown, currentPage, currentMode])

  const goToPage = (pageNumber: number) => {
    if (!numPages) return
    setPage(clamp(pageNumber, 1, numPages))
  }

  const goToPreviousPage = () => {
    if (!canGoPrevPage) return
    goToPage(currentPage - 1)
  }

  const goToNextPage = () => {
    if (!canGoNextPage) return
    goToPage(currentPage + 1)
  }

  const toggleToolPane = () => {
    if (!isToolPaneCollapsed) {
      expandedToolPaneWidthRef.current = columnWidths[2]
      setIsToolPaneCollapsed(true)
      return
    }

    setColumnWidths((prev) => [prev[0], prev[1], expandedToolPaneWidthRef.current])
    setIsToolPaneCollapsed(false)
  }

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
    setNumPages(pdf.numPages)
    setTotalPages(pdf.numPages)
    setAutoTranslateProgress((prev) => ({ ...prev, total: prev.total || pdf.numPages }))
    setLoading(false)
  }

  const onDocumentLoadError = (err: Error) => {
    setError('PDF 加载失败: ' + err.message)
    setLoading(false)
  }

  const handlePdfPageLoadSuccess = async (page: any) => {
    try {
      const textContent = await page.getTextContent()
      let lastY = -1
      const textItems: string[] = []

      for (const item of textContent.items || []) {
        const value = String(item.str || '')
        if (!value) continue
        if (lastY !== -1 && Math.abs(item.transform?.[5] - lastY) > 5) {
          textItems.push('\n')
        }
        textItems.push(value)
        lastY = item.transform?.[5] ?? lastY
      }

      const normalized = normalizePageText(textItems.join(' '))
      if (normalized.trim()) {
        pdfJsPageTextsRef.current[currentPage] = normalized
      }
    } catch (pageTextError) {
      console.error(`PDF.js 提取第 ${currentPage} 页文本失败:`, pageTextError)
    }
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

  const ensurePageText = async (pageNumber: number) => {
    const cachedText = pageTextsRef.current[pageNumber]
    const cachedMarkdown = pageMarkdownsRef.current[pageNumber]
    if (cachedText?.trim() || cachedMarkdown?.trim()) {
      return {
        text: cachedText || '',
        markdown: cachedMarkdown || '',
      }
    }

    const inflight = pendingTextLoadsRef.current.get(pageNumber)
    if (inflight) {
      return inflight
    }

    const task = (async () => {
      if (!id) {
        return { text: '', markdown: '' }
      }

      setPageReadStatus((prev) => ({ ...prev, [pageNumber]: 'reading' }))
      setPageReadMessages((prev) => ({ ...prev, [pageNumber]: '正在读取后端提取结果...' }))

      try {
        const res = await papersApi.getPageSource(id, pageNumber)
        const text = normalizePageText(res.data.text || '')
        const markdown = (res.data.markdown || '').trim()

        setPageTexts((prev) => ({ ...prev, [pageNumber]: text }))
        pageMarkdownsRef.current[pageNumber] = markdown
        if (text) {
          setPageReadStatus((prev) => ({ ...prev, [pageNumber]: 'ready' }))
          setPageReadMessages((prev) => ({ ...prev, [pageNumber]: '' }))
        } else {
          setPageReadStatus((prev) => ({ ...prev, [pageNumber]: 'empty' }))
          setPageReadMessages((prev) => ({
            ...prev,
            [pageNumber]: '当前页没有可用提取文本。',
          }))
        }
        return { text, markdown }
      } catch (readError: any) {
        console.error('读取当前页文本失败:', readError)
        setPageTexts((prev) => ({ ...prev, [pageNumber]: '' }))
        pageMarkdownsRef.current[pageNumber] = ''
        setPageReadStatus((prev) => ({ ...prev, [pageNumber]: 'error' }))
        setPageReadMessages((prev) => ({
          ...prev,
          [pageNumber]: `当前页提取失败：${readError?.message || '未知错误'}`,
        }))
        return { text: '', markdown: '' }
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
    if (!id) return
    void ensurePageText(currentPage)
  }, [id, currentPage])

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
      const res = await translationApi.getTranslatedPage(id, pageNumber, mode)
      if (!res.data.exists || !res.data.translated_markdown?.trim()) {
        return undefined
      }

      const restoredDocument = {
        markdown: res.data.translated_markdown,
        sourceText: res.data.source_text || pageTextsRef.current[pageNumber] || '',
        modelUsed: res.data.model_used,
        editedByUser: Boolean(res.data.edited_by_user),
        editedAt: res.data.edited_at,
        userNotes: res.data.user_notes || '',
      }
      setPageDocuments((prev) => ({
        ...prev,
        [key]: restoredDocument,
      }))
      if (res.data.source_text?.trim()) {
        setPageTexts((prev) => (prev[pageNumber] ? prev : { ...prev, [pageNumber]: res.data.source_text }))
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
      pendingPageKeysRef.current.add(key)
      try {
        const res = await translationApi.translatePage({
          paper_id: id,
          page_number: pageNumber,
          mode,
          force,
          pdfjs_text: pdfJsPageTextsRef.current[pageNumber] || '',
        })

        if (!res.data.exists || !res.data.translated_markdown?.trim()) {
          return undefined
        }

        const nextDocument = {
          markdown: res.data.translated_markdown,
          sourceText: res.data.source_text || '',
          modelUsed: res.data.model_used,
          editedByUser: Boolean(res.data.edited_by_user),
          editedAt: res.data.edited_at,
          userNotes: res.data.user_notes || '',
        }
        setPageDocuments((prev) => ({
          ...prev,
          [key]: nextDocument,
        }))
        if (res.data.source_text?.trim()) {
          setPageTexts((prev) => ({ ...prev, [pageNumber]: res.data.source_text }))
        }
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

  const handleSavePageTranslation = async () => {
    if (!id || !pageDocKey || !pageTranslationDraft.trim()) return

    setIsSavingPageTranslation(true)
    setPageEditMessage('')
    try {
      const res = await translationApi.updateTranslatedPage({
        paper_id: id,
        page_number: currentPage,
        mode: currentMode,
        translated_markdown: pageTranslationDraft,
        user_notes: pageNotesDraft,
      })
      const nextDocument = {
        markdown: res.data.translated_markdown,
        sourceText: res.data.source_text || currentPageDocument?.sourceText || currentPageText || '',
        modelUsed: res.data.model_used || currentPageDocument?.modelUsed,
        editedByUser: Boolean(res.data.edited_by_user),
        editedAt: res.data.edited_at,
        userNotes: res.data.user_notes || '',
      }
      setPageDocuments((prev) => ({
        ...prev,
        [pageDocKey]: nextDocument,
      }))
      setPageTranslationDraft(nextDocument.markdown)
      setPageNotesDraft(nextDocument.userNotes || '')
      setIsEditingPageTranslation(false)
      setPageEditMessage('人工修订已保存。')
    } catch (saveError: any) {
      console.error('保存人工修订译文失败:', saveError)
      setPageEditMessage(saveError?.response?.data?.detail || '保存失败，请稍后重试。')
    } finally {
      setIsSavingPageTranslation(false)
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
    if (!id) return

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
    if (!isAutoFullTranslateEnabled || !id || autoTranslateTotal <= 0 || hasCompletedCurrentProfile) {
      return
    }

    const runId = autoTranslateRunRef.current + 1
    autoTranslateRunRef.current = runId
    let cancelled = false

    setIsAutoTranslating(true)
    setAutoTranslateProgress((prev) => ({
      completed: prev.completed,
      total: autoTranslateTotal,
      failedPages: prev.failedPages,
    }))

    void (async () => {
      const failedPages = new Set<number>()
      let completed = 0

      for (let pageNumber = 1; pageNumber <= autoTranslateTotal; pageNumber += 1) {
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
          total: autoTranslateTotal,
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
        total_pages: autoTranslateTotal,
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
  }, [isAutoFullTranslateEnabled, id, autoTranslateTotal, currentMode, hasCompletedCurrentProfile])

  useEffect(() => {
    if (!id || !currentPage || currentPageDocument?.markdown) {
      return
    }
    void loadPersistedPageDocument(currentPage, currentMode)
  }, [id, currentPage, currentMode, currentPageDocument?.markdown])

  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (numPages <= 0 || isTypingTarget(event.target)) {
        return
      }

      if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
        if (!canGoPrevPage) return
        event.preventDefault()
        goToPreviousPage()
      }

      if (event.key === 'ArrowRight' || event.key === 'PageDown') {
        if (!canGoNextPage) return
        event.preventDefault()
        goToNextPage()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [canGoNextPage, canGoPrevPage, currentPage, numPages])

  const submitQa = async (question: string, displayText?: string) => {
    if (!id || !question.trim() || isQaLoading || !qaSessionId) return

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
          session_id: qaSessionId,
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

  const handleAskSelection = () => {
    if (!selectedText) return
    const draft = formatSelectionForQa(selectedText, currentPage)
    setQaInput((prev) => {
      const trimmed = prev.trim()
      if (!trimmed) return draft
      if (prev.includes(draft.trim())) return prev
      return `${trimmed}\n\n${draft}`
    })
    setActiveTab('qa')
    window.requestAnimationFrame(() => {
      const input = qaInputRef.current
      if (!input) return
      input.focus()
      const length = input.value.length
      input.setSelectionRange(length, length)
    })
  }

  const focusSourceText = (text: string, page?: number) => {
    if (!text.trim()) return
    if (page && page !== currentPage) {
      pendingSelectionRef.current = { page, text }
      setPage(page)
    } else {
      setSelection(text, null)
    }
    setActiveTab('selection')
  }

  const handleResizeStart = (handleIndex: 0 | 1) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= STACKED_LAYOUT_BREAKPOINT) return

    const container = workspaceRef.current
    if (!container) return

    event.preventDefault()
    const startX = event.clientX
    const startWidths = [...columnWidths] as ColumnWidths
    const containerWidth = container.getBoundingClientRect().width

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (moveEvent: PointerEvent) => {
      const deltaPercent = ((moveEvent.clientX - startX) / containerWidth) * 100

      if (handleIndex === 0) {
        const nextLeft = clamp(
          startWidths[0] + deltaPercent,
          MIN_COLUMN_WIDTHS[0],
          100 - startWidths[2] - MIN_COLUMN_WIDTHS[1],
        )
        const actualDelta = nextLeft - startWidths[0]
        setColumnWidths([
          Number(nextLeft.toFixed(2)),
          Number((startWidths[1] - actualDelta).toFixed(2)),
          startWidths[2],
        ])
        return
      }

      const nextMiddle = clamp(
        startWidths[1] + deltaPercent,
        MIN_COLUMN_WIDTHS[1],
        100 - startWidths[0] - MIN_COLUMN_WIDTHS[2],
      )
      const actualDelta = nextMiddle - startWidths[1]
      expandedToolPaneWidthRef.current = Number((startWidths[2] - actualDelta).toFixed(2))
      setColumnWidths([
        startWidths[0],
        Number(nextMiddle.toFixed(2)),
        expandedToolPaneWidthRef.current,
      ])
    }

    const onUp = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const renderMainPaneContent = () => {
    return (
      <>
        {currentReadMessage ? <div className={styles.notice}>{currentReadMessage}</div> : null}

        <div className={styles.card}>
          <div className={styles.cardTitleRow}>
            <div className={styles.cardTitle}>翻译结果</div>
            <div className={styles.metaRow}>
              <span>第 {currentPage} 页</span>
              <span>{currentMode === 'quick' ? '快速模式' : '严谨模式'}</span>
              {currentPageDocument?.modelUsed ? <span>{currentPageDocument.modelUsed}</span> : null}
              {currentPageDocument?.editedByUser ? <span className={styles.editedBadge}>人工修订</span> : null}
            </div>
          </div>
          {isPageTranslating ? (
            <div className={styles.inlineLoading}>
              <div className={styles.spinner} />
              <p>正在生成 Markdown 翻译...</p>
            </div>
          ) : currentPageDocument?.markdown ? (
            <>
              <div className={styles.inlineActions}>
                {isEditingPageTranslation ? (
                  <>
                    <button
                      className={styles.primaryAction}
                      onClick={() => void handleSavePageTranslation()}
                      disabled={isSavingPageTranslation || !pageTranslationDraft.trim()}
                    >
                      {isSavingPageTranslation ? '保存中...' : '保存修订'}
                    </button>
                    <button
                      className={styles.secondaryAction}
                      onClick={() => {
                        setIsEditingPageTranslation(false)
                        setPageTranslationDraft(currentPageDocument.markdown)
                        setPageNotesDraft(currentPageDocument.userNotes || '')
                        setPageEditMessage('')
                      }}
                      disabled={isSavingPageTranslation}
                    >
                      取消
                    </button>
                  </>
                ) : (
                  <button
                    className={styles.secondaryAction}
                    onClick={() => {
                      setPageTranslationDraft(currentPageDocument.markdown)
                      setPageNotesDraft(currentPageDocument.userNotes || '')
                      setIsEditingPageTranslation(true)
                      setPageEditMessage('')
                    }}
                  >
                    编辑译文
                  </button>
                )}
              </div>
              {pageEditMessage ? <div className={styles.saveMessage}>{pageEditMessage}</div> : null}
              {isEditingPageTranslation ? (
                <div className={styles.editStack}>
                  <textarea
                    className={styles.translationEditor}
                    value={pageTranslationDraft}
                    onChange={(event) => setPageTranslationDraft(event.target.value)}
                    spellCheck={false}
                  />
                  <label className={styles.editorLabel}>
                    页级备注
                    <textarea
                      className={styles.notesEditor}
                      value={pageNotesDraft}
                      onChange={(event) => setPageNotesDraft(event.target.value)}
                      placeholder="可记录公式修正、图片文字删除原因、阅读批注等；不会触发重新翻译。"
                    />
                  </label>
                </div>
              ) : (
                <>
                  <div className={styles.markdownWrap}>
                    <MarkdownBlock content={currentPageDocument.markdown} />
                  </div>
                  {currentPageDocument.userNotes?.trim() ? (
                    <div className={styles.noteBox}>
                      <strong>页级备注</strong>
                      <p>{currentPageDocument.userNotes}</p>
                    </div>
                  ) : null}
                </>
              )}
            </>
          ) : (
            <div className={styles.emptyState}>
              <p>当前页还没有译文。先在右侧工具栏执行“翻译当前页”。</p>
            </div>
          )}
        </div>
      </>
    )
  }

  const renderToolPaneContent = () => {
    if (activeTab === 'full') {
      return (
        <div className={styles.toolPanel}>
          <div className={styles.panelHeader}>
            <div>
              <strong>全文翻译</strong>
            </div>
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

          {isAutoFullTranslateEnabled ? (
            <div className={styles.card}>
              <div className={styles.cardTitle}>后台全文翻译进度</div>
              <div className={styles.metaRow}>
                <span>{isAutoTranslating ? '运行中' : hasCompletedCurrentProfile ? '已完成' : '已停止'}</span>
                <span>
                  {autoTranslateProgress.completed}/{autoTranslateProgress.total || autoTranslateTotal || 0} 页
                </span>
                <span>模式 {currentMode}</span>
              </div>
              {autoTranslateProgress.failedPages.length ? (
                <p className={styles.placeholderText}>失败页: {autoTranslateProgress.failedPages.join(', ')}</p>
              ) : (
                <p className={styles.placeholderText}>当前没有失败页。</p>
              )}
            </div>
          ) : null}

          {(showFullSource || !currentPageDocument?.markdown) ? (
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
        </div>
      )
    }

    if (activeTab === 'selection') {
      return (
        <div className={styles.toolPanel}>
          <div className={styles.panelHeader}>
            <div>
              <strong>选词翻译</strong>
            </div>
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
        </div>
      )
    }

    if (activeTab === 'qa') {
      return (
        <div className={`${styles.toolPanel} ${styles.qaToolPanel}`}>
          <div className={styles.panelHeader}>
            <div>
              <strong>Paper QA</strong>
            </div>
            <div className={styles.panelActions}>
              <button
                className={styles.secondaryAction}
                onClick={() => {
                  if (!id) return
                  const nextSessionId = createQaSessionId(`paper:${id}`)
                  window.sessionStorage.setItem(getQaSessionKey(`paper:${id}`), nextSessionId)
                  setQaSessionId(nextSessionId)
                  setQaMessages([])
                }}
              >
                重置对话
              </button>
            </div>
          </div>

          <div className={`${styles.qaMessages} ${styles.toolQaMessages}`}>
            {qaMessages.length === 0 ? (
              <div className={styles.emptyState}>
                <p>围绕当前页、选中片段或整篇论文发起追问。</p>
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
            {isQaLoading ? (
              <div className={`${styles.qaMessage} ${styles.assistant}`}>
                <div className={styles.qaBubble}>
                  <div className={styles.inlineLoading}>
                    <div className={styles.spinner} />
                    <p>正在分析问题...</p>
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <div className={styles.qaComposer}>
            <textarea
              ref={qaInputRef}
              value={qaInput}
              onChange={(event) => setQaInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
                  return
                }
                event.preventDefault()
                void submitQa(qaInput)
              }}
              placeholder={qaPlaceholder}
              className={styles.qaInput}
              rows={3}
            />
            <div className={styles.inlineActions}>
              <button className={styles.primaryAction} onClick={() => void submitQa(qaInput)} disabled={isQaLoading}>
                {isQaLoading ? '发送中...' : '发送问题'}
              </button>
            </div>
          </div>
        </div>
      )
    }

    if (activeTab === 'profile') {
      return (
        <div className={styles.toolPanel}>
          <div className={styles.panelHeader}>
            <div>
              <strong>论文画像</strong>
            </div>
            <div className={styles.panelActions}>
              <button
                className={styles.secondaryAction}
                onClick={() => {
                  if (!id) return
                  void refreshReaderProfile(currentMode, {
                    auto_full_translation_enabled: isAutoFullTranslateEnabled,
                    auto_full_translation_mode: currentMode,
                    auto_full_translation_status: isAutoTranslating ? 'running' : readerProfile.auto_full_translation_status || 'idle',
                    translated_pages: autoTranslateProgress.completed,
                    total_pages: autoTranslateTotal,
                    failed_pages: autoTranslateProgress.failedPages,
                  })
                }}
                disabled={isRefreshingSummary || autoTranslateProgress.completed === 0}
              >
                {isRefreshingSummary ? '刷新中...' : '刷新论文画像'}
              </button>
              {/* <button className={styles.secondaryAction} onClick={() => setIsDebugOpen((value) => !value)}>
                {isDebugOpen ? '隐藏调试' : '显示调试'}
              </button> */}
            </div>
          </div>

          <div className={styles.metaRow}>
            <span>{paper?.title || '未命名论文'}</span>
            <span>{autoTranslateTotal} 页</span>
            <span>{readerProfile.summary_translation_mode || currentMode}</span>
          </div>

          <div className={styles.card}>
            {/* <div className={styles.cardTitle}>AI 论文画像</div> */}
            {isRefreshingSummary ? (
              <div className={styles.inlineLoading}>
                <div className={styles.spinner} />
                <p>正在刷新论文画像...</p>
              </div>
            ) : paper?.ai_summary_md ? (
              <div className={`${styles.markdownWrap} ${styles.compactMarkdown}`}>
                <MarkdownBlock content={paper.ai_summary_md} />
              </div>
            ) : (
              <p className={styles.placeholderText}>开启并完成后台全文翻译后，这里会生成整篇论文的画像与摘要。</p>
            )}
          </div>

          <div className={styles.card}>
            <div className={styles.cardTitle}>基础元数据</div>
            <div className={styles.markdownWrap}>
              <p><strong>标题</strong>: {paper?.title || '暂无'}</p>
              <p><strong>摘要</strong>: {displayAbstract}</p>
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
      )
    }

    return (
      <div className={styles.toolPanel}>
        <div className={styles.emptyState}>
          <p>请选择右侧工具栏功能。</p>
        </div>
      </div>
    )
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
      <div ref={workspaceRef} className={styles.workspace}>
        <section className={styles.pdfPane} style={{ flexBasis: `${effectiveMainPaneWidths.pdf}%` }}>
          <div className={styles.floatingChrome}>
            <Link to="/" className={styles.backLink}>
              返回
            </Link>
            <div className={styles.titleBadge}>{paper?.title || '阅读工作台'}</div>
            <div className={styles.controlCluster}>
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

            {pdfUrl ? (
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
                  onLoadSuccess={handlePdfPageLoadSuccess}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  devicePixelRatio={Math.min(3, window.devicePixelRatio || 1)}
                  className={styles.pdfPage}
                />
              </Document>
            ) : !loading ? (
              <div className={styles.emptyState}>
                <p>当前文档没有 PDF 预览，右侧仍可查看提取原文、翻译和 QA。</p>
              </div>
            ) : null}
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

        <div
          className={styles.resizeHandle}
          onPointerDown={handleResizeStart(0)}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整原文列和译文列宽度"
        />

        <section className={styles.translationPane} style={{ flexBasis: `${effectiveMainPaneWidths.translation}%` }}>
          <div className={styles.translationContent}>
            <div className={styles.tabPanel}>{renderMainPaneContent()}</div>
          </div>

          <div className={styles.translationFooter}>
            <div className={styles.pageNavigator}>
              <button className={styles.pageNavBtn} onClick={goToPreviousPage} disabled={!canGoPrevPage}>
                上一页
              </button>
              <div className={styles.pageIndicator}>
                <strong>{currentPage}</strong>
                <span>/ {numPages || '?'}</span>
                {/* <small>ArrowLeft / ArrowRight</small> */}
              </div>
              <button className={styles.pageNavBtn} onClick={goToNextPage} disabled={!canGoNextPage}>
                下一页
              </button>
            </div>
          </div>
        </section>

        {!isToolPaneCollapsed ? (
          <div
            className={styles.resizeHandle}
            onPointerDown={handleResizeStart(1)}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整译文列和工具列宽度"
          />
        ) : null}

        <aside
          className={`${styles.toolPane} ${isToolPaneCollapsed ? styles.toolPaneCollapsed : ''}`}
          style={{ flexBasis: isToolPaneCollapsed ? `${TOOL_PANE_COLLAPSED_WIDTH}px` : `${columnWidths[2]}%` }}
        >
          {isToolPaneCollapsed ? (
            <div className={styles.collapsedRail}>
              <button className={styles.collapseToggle} onClick={toggleToolPane}>
                展开
              </button>
              <span className={styles.collapsedLabel}>{TAB_LABELS[activeTab]}</span>
            </div>
          ) : (
            <>
              <div className={styles.tabBar}>
                {TAB_ORDER.map((tab) => (
                  <button
                    key={tab}
                    className={`${styles.tabBtn} ${activeTab === tab ? styles.tabBtnActive : ''}`}
                    onClick={() => setActiveTab(tab)}
                  >
                    {TAB_LABELS[tab]}
                  </button>
                ))}
                <div className={styles.tabBarActions}>
                  {isAutoFullTranslateEnabled ? (
                    <div className={styles.statusCluster}>
                      <span className={styles.statusChip}>
                        全文 {autoTranslateProgress.completed}/{autoTranslateProgress.total || numPages || '?'}
                      </span>
                    </div>
                  ) : null}
                  <button className={styles.collapseToggle} onClick={toggleToolPane}>
                    收起
                  </button>
                </div>
              </div>

              <div className={styles.toolPaneContent}>
                <div className={styles.tabPanel}>{renderToolPaneContent()}</div>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}
