import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Document, Page, pdfjs } from 'react-pdf'
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'
import { papersApi, type Paper } from '../../api/papers'
import { translationApi, streamTranslatePage, type TranslatePageResponse } from '../../api/translation'
import { useTranslationStore } from '../../stores/translation-store'
import { Markdown } from '../../components/ui/Markdown'
import { Segmented, ThemeToggle, ConfirmDialog, useToast, type SegmentedOption } from '../../components/ui/kit'
import { AssistantPanel } from '../../components/reader/AssistantPanel'
import styles from './ReaderPage.module.css'

pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

type ViewMode = 'source' | 'translation' | 'dual'

interface SelectionInfo {
  text: string
  rect: { top: number; left: number; bottom: number }
  context: string
  page: number
}

interface TranslationPopupData {
  blockKey: string
  original: string
  translated: string
  rect: { top: number; left: number }
  loading: boolean
  fromCache?: boolean
}

const VIEW_MODES: SegmentedOption<ViewMode>[] = [
  { value: 'source', label: '原文' },
  { value: 'translation', label: '译文' },
  { value: 'dual', label: '对照' },
]

function parseTags(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function parseAuthors(raw: string): string {
  try {
    const parsed = JSON.parse(raw || '[]')
    if (Array.isArray(parsed)) return parsed.join(', ')
    return String(parsed || '')
  } catch {
    return raw || '—'
  }
}

/** 从选区所在段落提取上下文（帮助翻译理解语境） */
function buildSelectionContext(selection: Selection): string {
  const node = selection.anchorNode
  const el = (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node) as HTMLElement | null
  const block = el?.closest('p, div, section, li') as HTMLElement | null
  return (block?.textContent || '').trim().slice(0, 900)
}

export default function ReaderPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const toast = useToast()
  const {
    selectionCache,
    setSelectionCache,
    translatingPages,
    setTranslatingPage,
  } = useTranslationStore()

  /* ---------- 基础状态 ---------- */
  const [paper, setPaper] = useState<Paper | null>(null)
  const [numPages, setNumPages] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(1.1)
  const [viewMode, setViewMode] = useState<ViewMode>('dual')
  const [loading, setLoading] = useState(true)
  const [panelOpen, setPanelOpen] = useState(true)
  const [assistantExpanded, setAssistantExpanded] = useState(true)
  const [infoExpanded, setInfoExpanded] = useState(false)

  /* ---------- 翻译状态 ---------- */
  const [pageDocs, setPageDocs] = useState<Record<number, TranslatePageResponse>>({})
  const [pageLoading, setPageLoading] = useState<Record<number, boolean>>({})
  /** 流式翻译草稿：pageNumber -> { text, attempt, thinking }（attempt 变化时丢弃旧增量） */
  const [pageStreams, setPageStreams] = useState<Record<number, { text: string; attempt: number; thinking: number }>>({})
  const [editingPage, setEditingPage] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')

  /* ---------- 选段交互 ---------- */
  const [selection, setSelection] = useState<SelectionInfo | null>(null)
  const [translationPopup, setTranslationPopup] = useState<TranslationPopupData | null>(null)
  const [aiQuestion, setAiQuestion] = useState<string | null>(null)

  /* ---------- 内容重新提取 ---------- */
  const [extractEngine, setExtractEngine] = useState<'pymupdf' | 'docling'>('pymupdf')
  const [saveAsDefault, setSaveAsDefault] = useState(false)
  const [reextracting, setReextracting] = useState(false)
  const [confirmReextract, setConfirmReextract] = useState(false)

  const scrollRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Map<number, HTMLElement>>(new Map())
  const loadedPagesRef = useRef<Set<number>>(new Set())
  /** 每页流式翻译的 AbortController（重复触发/卸载时取消） */
  const streamControllersRef = useRef<Map<number, AbortController>>(new Map())

  useEffect(() => () => {
    streamControllersRef.current.forEach((controller) => controller.abort())
    streamControllersRef.current.clear()
  }, [])

  /* ---------- 论文加载 ---------- */
  useEffect(() => {
    if (!id) return
    setLoading(true)
    papersApi.get(id)
      .then((res) => setPaper(res.data))
      .catch(() => toast.error('加载论文失败'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  /* ---------- 阅读进度自动保存 ---------- */
  const progressTimer = useRef<number | null>(null)
  useEffect(() => {
    if (!id || !numPages || !paper) return
    const progress = Math.min(1, currentPage / numPages)
    if (Math.abs((paper.read_progress || 0) - progress) < 0.01 && currentPage !== numPages) return
    if (progressTimer.current) window.clearTimeout(progressTimer.current)
    progressTimer.current = window.setTimeout(() => {
      setPaper((prev) => prev && { ...prev, read_progress: progress })
      papersApi.updateReaderProfile(id, { read_progress: progress, last_read_at: new Date().toISOString() }).catch(() => {})
    }, 1200)
    return () => {
      if (progressTimer.current) window.clearTimeout(progressTimer.current)
    }
  }, [currentPage, numPages, id, paper])

  /* ---------- 翻译懒加载 ---------- */
  const ensurePageTranslation = useCallback(async (pageNumber: number, force = false) => {
    if (!id) return undefined
    const loaded = pageDocs[pageNumber]
    if (loaded && !force) return loaded
    if (pageLoading[pageNumber]) return undefined

    setPageLoading((prev) => ({ ...prev, [pageNumber]: true }))
    try {
      const res = await translationApi.getTranslatedPage(id, pageNumber)
      if (res.data.exists && res.data.translated_markdown?.trim()) {
        setPageDocs((prev) => ({ ...prev, [pageNumber]: res.data }))
        loadedPagesRef.current.add(pageNumber)
        return res.data
      }
      return undefined
    } catch {
      return undefined
    } finally {
      setPageLoading((prev) => ({ ...prev, [pageNumber]: false }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, pageDocs])

  /* ---------- 页面可见性跟踪（滚动翻页） ---------- */
  useEffect(() => {
    const root = scrollRef.current
    if (!root || numPages === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const page = Number((entry.target as HTMLElement).dataset.page)
            if (page) setCurrentPage(page)
          }
        }
      },
      { root, rootMargin: '-45% 0px -45% 0px', threshold: 0 },
    )
    pageRefs.current.forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [numPages, viewMode])

  // 当前页与邻近页的译文预取
  useEffect(() => {
    if (numPages === 0 || !id) return
    if (viewMode === 'source') return
    for (let p = currentPage; p <= Math.min(numPages, currentPage + 1); p += 1) {
      if (!loadedPagesRef.current.has(p)) {
        void ensurePageTranslation(p)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, numPages, id, viewMode])

  /* ---------- 页面导航 / 缩放 ---------- */
  const scrollToPage = useCallback((pageNumber: number) => {
    const el = pageRefs.current.get(pageNumber)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setCurrentPage(pageNumber)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
      if (e.key === 'Escape') {
        setSelection(null)
        setTranslationPopup(null)
      } else if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault()
        scrollToPage(Math.max(1, currentPage - 1))
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
        e.preventDefault()
        scrollToPage(Math.min(numPages, currentPage + 1))
      } else if (e.key === '+' || e.key === '=') {
        setScale((s) => Math.min(2.2, s + 0.12))
      } else if (e.key === '-') {
        setScale((s) => Math.max(0.6, s - 0.12))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [currentPage, numPages, scrollToPage])

  /* ---------- 翻译操作 ---------- */
  const handleTranslatePage = useCallback(async (pageNumber: number, force = false) => {
    if (!id) return
    // 同一页重复触发时先取消进行中的翻译
    streamControllersRef.current.get(pageNumber)?.abort()
    const controller = new AbortController()
    streamControllersRef.current.set(pageNumber, controller)
    setTranslatingPage(pageNumber, true)
    setPageStreams((prev) => ({ ...prev, [pageNumber]: { text: '', attempt: 1, thinking: 0 } }))
    let streamError = ''
    try {
      await streamTranslatePage(
        { paper_id: id, page_number: pageNumber, force, pdfjs_text: '' },
        (type, payload) => {
          if (type === 'thinking') {
            // 思考增量：累计字数用于"思考中"实时反馈
            const chunkLen = (payload?.text || '').length
            setPageStreams((prev) => {
              const current = prev[pageNumber]
              return {
                ...prev,
                [pageNumber]: {
                  text: current?.text || '',
                  attempt: current?.attempt || 1,
                  thinking: (current?.thinking || 0) + chunkLen,
                },
              }
            })
          } else if (type === 'delta') {
            const attempt = Number(payload?.attempt || 1)
            setPageStreams((prev) => {
              const current = prev[pageNumber]
              const base = current && current.attempt === attempt ? current.text : ''
              return {
                ...prev,
                [pageNumber]: {
                  text: base + (payload?.text || ''),
                  attempt,
                  thinking: current?.thinking || 0,
                },
              }
            })
          } else if (type === 'result') {
            setPageDocs((prev) => ({ ...prev, [pageNumber]: payload as TranslatePageResponse }))
            loadedPagesRef.current.add(pageNumber)
          } else if (type === 'error') {
            streamError = payload?.message || '翻译失败'
          }
        },
        controller.signal,
      )
      if (streamError) throw new Error(streamError)
      toast.success(force ? `第 ${pageNumber} 页已重新翻译` : `第 ${pageNumber} 页翻译完成`)
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return
      toast.error(`第 ${pageNumber} 页翻译失败：${(err as Error)?.message || '未知错误'}`)
    } finally {
      // 仅清理属于本次请求的状态（可能已被同页的新请求接管）
      if (streamControllersRef.current.get(pageNumber) === controller) {
        streamControllersRef.current.delete(pageNumber)
        setPageStreams((prev) => {
          const next = { ...prev }
          delete next[pageNumber]
          return next
        })
        setTranslatingPage(pageNumber, false)
      }
    }
  }, [id, setTranslatingPage, toast])

  const handleSavePageEdit = useCallback(async (pageNumber: number) => {
    if (!id) return
    try {
      const res = await translationApi.updateTranslatedPage({
        paper_id: id,
        page_number: pageNumber,
        translated_markdown: editDraft,
      })
      setPageDocs((prev) => ({ ...prev, [pageNumber]: res.data }))
      setEditingPage(null)
      toast.success('译文已保存')
    } catch {
      toast.error('保存失败')
    }
  }, [id, editDraft, toast])

  /* ---------- 内容重新提取 ---------- */
  const handleReextract = useCallback(async () => {
    if (!id) return
    setConfirmReextract(false)
    setReextracting(true)
    try {
      await papersApi.reindex(id, { engine: extractEngine, save_as_default: saveAsDefault })
      // 清空已加载的页面文本/译文，强制重新拉取
      loadedPagesRef.current = new Set()
      setPageDocs({})
      const res = await papersApi.get(id)
      setPaper(res.data)
      toast.success(`已使用 ${extractEngine === 'docling' ? 'Docling' : 'PyMuPDF'} 重新提取原文`)
    } catch (err: any) {
      toast.error(`重新提取失败: ${err?.response?.data?.detail || err?.message || '未知错误'}`)
    } finally {
      setReextracting(false)
    }
  }, [id, extractEngine, saveAsDefault, toast])

  /* ---------- 选段操作 ---------- */
  const handleMouseUp = useCallback(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) {
      setSelection(null)
      return
    }
    const text = sel.toString().trim()
    if (text.length < 2) {
      setSelection(null)
      return
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect()
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setSelection(null)
      return
    }
    setSelection({
      text: text.slice(0, 3000),
      context: buildSelectionContext(sel),
      page: currentPage,
      rect: {
        top: rect.top + window.scrollY,
        left: Math.min(Math.max(rect.left + rect.width / 2, 200), window.innerWidth - 200),
        bottom: rect.bottom + window.scrollY,
      },
    })
  }, [currentPage])

  const selectionBlockKey = useCallback((text: string, page: number) => {
    return `sel-${page}-${text.slice(0, 60)}`
  }, [])

  const handleTranslateSelection = useCallback(async (force = false) => {
    if (!id || !selection) return
    const blockKey = selectionBlockKey(selection.text, selection.page)
    const cached = selectionCache[blockKey]
    setTranslationPopup({
      blockKey,
      original: selection.text,
      translated: cached && !force ? cached : '',
      rect: { top: selection.rect.bottom, left: selection.rect.left },
      loading: !(cached && !force),
      fromCache: !!(cached && !force),
    })
    if (cached && !force) return

    try {
      const res = await translationApi.translate({
        paper_id: id,
        block_id: blockKey,
        text: selection.text,
        context: selection.context,
        force,
      })
      setSelectionCache(blockKey, res.data.translated_text)
      setTranslationPopup((prev) => prev && prev.blockKey === blockKey
        ? { ...prev, translated: res.data.translated_text, loading: false, fromCache: res.data.from_cache }
        : prev)
    } catch {
      setTranslationPopup((prev) => prev && prev.blockKey === blockKey
        ? { ...prev, translated: '⚠️ 翻译失败，请重试', loading: false }
        : prev)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, selection, selectionCache, selectionBlockKey, setSelectionCache])

  const handleCopy = useCallback((text: string, label = '内容') => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label}已复制`),
      () => toast.error('复制失败'),
    )
  }, [toast])

  /* ---------- 渲染：单页内容 ---------- */
  const registerPageRef = useCallback((page: number, el: HTMLElement | null) => {
    if (el) pageRefs.current.set(page, el)
    else pageRefs.current.delete(page)
  }, [])

  const renderTranslationPane = (pageNumber: number) => {
    const doc = pageDocs[pageNumber]
    const streamDraft = pageStreams[pageNumber]
    const translating = translatingPages.includes(pageNumber)
    const isEditing = editingPage === pageNumber

    return (
      <div className={styles.translationPane}>
        <div className={styles.translationHeader}>
          <span className={styles.translationTitle}>译文 · 第 {pageNumber} 页</span>
          <div className={styles.translationActions}>
            {translating ? (
              <span className={styles.translatingTag}><span className="spinner" style={{ width: 12, height: 12 }} /> 翻译中…</span>
            ) : (
              <>
                {!doc ? (
                  <button className="btn btn-primary btn-sm" onClick={() => handleTranslatePage(pageNumber)}>
                    翻译本页
                  </button>
                ) : (
                  <>
                    <button
                      className="btn btn-ghost btn-sm"
                      title="使用上下文重新翻译本页"
                      onClick={() => handleTranslatePage(pageNumber, true)}
                    >
                      ↻ 重译
                    </button>
                    {isEditing ? (
                      <>
                        <button className="btn btn-primary btn-sm" onClick={() => handleSavePageEdit(pageNumber)}>保存</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingPage(null)}>取消</button>
                      </>
                    ) : (
                      <>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => { setEditingPage(pageNumber); setEditDraft(doc.translated_markdown || '') }}
                        >
                          ✎ 编辑
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={() => handleCopy(doc.translated_markdown || '', '译文')}
                        >
                          复制
                        </button>
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
        {isEditing ? (
          <textarea
            className={styles.editArea}
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
          />
        ) : translating ? (
          <div className={styles.translationBody}>
            {streamDraft?.text ? (
              <>
                <Markdown>{streamDraft.text}</Markdown>
                <div className={styles.translationEmpty}>⏳ 正在继续输出…</div>
              </>
            ) : (
              <div className={styles.translationEmpty}>
                <span
                  className="spinner"
                  style={{ width: 12, height: 12, display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }}
                />
                {streamDraft?.thinking
                  ? `模型思考中…（已思考 ${streamDraft.thinking} 字）`
                  : '翻译中…'}
              </div>
            )}
          </div>
        ) : doc?.translated_markdown ? (
          <div className={styles.translationBody}>
            <Markdown>{doc.translated_markdown}</Markdown>
            {doc.edited_by_user && <div className={styles.editedBadge}>已手动修订</div>}
          </div>
        ) : (
          <div className={styles.translationEmpty}>
            {pageLoading[pageNumber] ? '加载中…' : '尚未翻译此页'}
          </div>
        )}
      </div>
    )
  }

  /* ---------- 页面列表 ---------- */
  const pageList = useMemo(() => {
    return Array.from({ length: numPages || 0 }, (_, i) => i + 1)
  }, [numPages])

  const inWindow = useCallback((page: number) => {
    return Math.abs(page - currentPage) <= 2
  }, [currentPage])

  return (
    <div className={styles.container}>
      {/* ======== 顶栏 ======== */}
      <header className={styles.topbar}>
        <button className="btn btn-icon" title="返回" onClick={() => navigate('/')}>←</button>
        <div className={styles.paperTitle} title={paper?.title}>
          {paper?.title || '加载中…'}
        </div>

        <Segmented options={VIEW_MODES} value={viewMode} onChange={setViewMode} size="sm" />

        <div className={styles.zoomControls}>
          <button className="btn btn-icon" title="缩小 (-)" onClick={() => setScale((s) => Math.max(0.6, s - 0.12))}>−</button>
          <span className={styles.zoomLabel}>{Math.round(scale * 100)}%</span>
          <button className="btn btn-icon" title="放大 (+)" onClick={() => setScale((s) => Math.min(2.2, s + 0.12))}>＋</button>
        </div>

        <div className={styles.pageNav}>
          <button className="btn btn-icon" disabled={currentPage <= 1} onClick={() => scrollToPage(currentPage - 1)}>‹</button>
          <span className={styles.pageIndicator}>
            <input
              className={styles.pageInput}
              value={currentPage}
              onChange={(e) => {
                const v = Number(e.target.value)
                if (v >= 1 && v <= numPages) scrollToPage(v)
              }}
            />
            <em>/ {numPages || '?'}</em>
          </span>
          <button className="btn btn-icon" disabled={currentPage >= numPages} onClick={() => scrollToPage(currentPage + 1)}>›</button>
        </div>

        <button
          className="btn btn-icon"
          title={panelOpen ? '收起侧栏' : '展开侧栏'}
          onClick={() => setPanelOpen((v) => !v)}
        >
          {panelOpen ? '⇥' : '⇤'}
        </button>
        <ThemeToggle />
      </header>

      {/* ======== 主体 ======== */}
      <div className={styles.body}>
        {/* 阅读区 */}
        <div
          className={styles.readerWrap}
          ref={scrollRef}
          onMouseUp={handleMouseUp}
        >
          {loading ? (
            <div className={styles.readerLoading}>
              <div className="spinner" />
              <span>加载论文…</span>
            </div>
          ) : (
            <Document
              file={`/api/papers/${id}/file`}
              onLoadSuccess={({ numPages: n }) => setNumPages(n)}
              onLoadError={() => toast.error('PDF 加载失败')}
              loading=""
            >
              <div className={`${styles.pages} ${styles[`mode-${viewMode}`]}`}>
                {pageList.map((page) => (
                  <section
                    key={page}
                    data-page={page}
                    ref={(el) => registerPageRef(page, el)}
                    className={styles.pageSection}
                  >
                    {viewMode !== 'translation' && (
                      <div className={styles.pdfPane}>
                        <div className={styles.pdfPageLabel}>原文 · p.{page}</div>
                        {inWindow(page) ? (
                          <Page
                            pageNumber={page}
                            scale={scale}
                            renderTextLayer
                            renderAnnotationLayer={false}
                          />
                        ) : (
                          <div className={styles.pagePlaceholder} style={{ aspectRatio: '1 / 1.414' }}>
                            <span>第 {page} 页</span>
                          </div>
                        )}
                      </div>
                    )}
                    {viewMode !== 'source' && renderTranslationPane(page)}
                  </section>
                ))}
              </div>
            </Document>
          )}
        </div>

        {/* ======== 侧栏（折叠面板：AI 助手 + 论文信息，无 tab） ======== */}
        {panelOpen && (
          <aside className={styles.sidebar}>
            <section className={`${styles.panelSection} ${assistantExpanded ? styles.panelOpen : ''}`}>
              <button
                className={styles.panelHeader}
                onClick={() => setAssistantExpanded((v) => !v)}
              >
                <span className={styles.panelHeaderTitle}>✦ AI 助手</span>
                <span className={styles.panelChevron}>{assistantExpanded ? '▾' : '▸'}</span>
              </button>
              {assistantExpanded && (
                <div className={styles.panelBody}>
                  <AssistantPanel
                    paperId={id || ''}
                    paperTitle={paper?.title || ''}
                    pendingQuestion={aiQuestion}
                    onQuestionConsumed={() => setAiQuestion(null)}
                    selectedText={selection?.text}
                    currentPage={currentPage}
                  />
                </div>
              )}
            </section>

            <section className={`${styles.panelSection} ${infoExpanded ? styles.panelOpen : ''}`}>
              <button
                className={styles.panelHeader}
                onClick={() => setInfoExpanded((v) => !v)}
              >
                <span className={styles.panelHeaderTitle}>ⓘ 论文信息</span>
                <span className={styles.panelChevron}>{infoExpanded ? '▾' : '▸'}</span>
              </button>
              {infoExpanded && paper && (
                <div className={`${styles.panelBody} ${styles.infoBody}`}>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>标题</span>
                    <span className={styles.infoValue}>{paper.title}</span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>作者</span>
                    <span className={styles.infoValue}>{paper.authors ? parseAuthors(paper.authors) : '—'}</span>
                  </div>
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>年份 / 页数</span>
                    <span className={styles.infoValue}>{paper.year || '—'} · {paper.page_count || numPages} 页</span>
                  </div>
                  {parseTags(paper.tags).length > 0 && (
                    <div className={styles.infoRow}>
                      <span className={styles.infoLabel}>标签</span>
                      <span className={styles.infoTags}>
                        {parseTags(paper.tags).map((tag) => (
                          <span key={tag} className="chip">{tag}</span>
                        ))}
                      </span>
                    </div>
                  )}
                  <div className={styles.infoRow}>
                    <span className={styles.infoLabel}>阅读进度</span>
                    <div className={styles.infoProgress}>
                      <div className={styles.infoProgressBar}>
                        <div
                          className={styles.infoProgressFill}
                          style={{ width: `${Math.round((paper.read_progress || 0) * 100)}%` }}
                        />
                      </div>
                      <span>{Math.round((paper.read_progress || 0) * 100)}%</span>
                    </div>
                  </div>
                  {paper.abstract && (
                    <div className={styles.infoAbstract}>
                      <div className={styles.infoLabel}>摘要</div>
                      <p>{paper.abstract}</p>
                    </div>
                  )}

                  <div className={styles.extractionBox}>
                    <div className={styles.infoLabel}>内容提取</div>
                    <p className={styles.extractionHint}>
                      切换提取器重新提取原文（页面文本/结构/图片），已有译文不受影响。
                    </p>
                    <select
                      className={`select ${styles.extractionSelect}`}
                      value={extractEngine}
                      onChange={(e) => setExtractEngine(e.target.value as 'pymupdf' | 'docling')}
                      disabled={reextracting}
                    >
                      <option value="pymupdf">PyMuPDF（快速文本提取）</option>
                      <option value="docling">Docling（深度解析：公式/表格/图片）</option>
                    </select>
                    <label className={styles.extractionCheck}>
                      <input
                        type="checkbox"
                        checked={saveAsDefault}
                        onChange={(e) => setSaveAsDefault(e.target.checked)}
                        disabled={reextracting}
                      />
                      同时设为默认提取器
                    </label>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => setConfirmReextract(true)}
                      disabled={reextracting}
                    >
                      {reextracting ? '提取中…' : '↻ 重新提取原文'}
                    </button>
                  </div>
                </div>
              )}
            </section>
          </aside>
        )}
      </div>

      {/* ======== 浮动选段工具条 ======== */}
      {selection && (
        <div
          className={styles.selectionToolbar}
          style={{ top: Math.max(selection.rect.top - 6, 64), left: selection.rect.left }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <button className={styles.selectionBtn} onClick={() => handleTranslateSelection(false)}>翻译</button>
          <button className={styles.selectionBtn} onClick={() => handleTranslateSelection(true)}>重译段</button>
          <button
            className={styles.selectionBtn}
            onClick={() => {
              setAiQuestion(`请解释这段内容的含义与作用：\n${selection.text.slice(0, 600)}`)
              setPanelOpen(true)
              setAssistantExpanded(true)
              setSelection(null)
            }}
          >
            解释
          </button>
          <button
            className={styles.selectionBtn}
            onClick={() => {
              setAiQuestion(`关于这段内容，我想进一步了解：`)
              setPanelOpen(true)
              setAssistantExpanded(true)
              setSelection(null)
            }}
          >
            问 AI
          </button>
          <button className={styles.selectionBtn} onClick={() => handleCopy(selection.text, '选段')}>复制</button>
          <button className={styles.selectionClose} onClick={() => setSelection(null)}>✕</button>
        </div>
      )}

      {/* ======== 选段翻译结果弹层 ======== */}
      {translationPopup && (
        <div
          className={styles.translationPopup}
          style={{ top: Math.max(translationPopup.rect.top + 10, 64), left: translationPopup.rect.left }}
        >
          <div className={styles.popupHeader}>
            <span>
              译文
              {translationPopup.fromCache && <em className={styles.cacheTag}>缓存</em>}
            </span>
            <div className={styles.popupActions}>
              {translationPopup.translated && !translationPopup.loading && (
                <button className="btn btn-ghost btn-sm" onClick={() => handleCopy(translationPopup.translated, '译文')}>
                  复制
                </button>
              )}
              <button className={styles.selectionClose} onClick={() => setTranslationPopup(null)}>✕</button>
            </div>
          </div>
          <div className={styles.popupBody}>
            {translationPopup.loading ? (
              <div className={styles.popupLoading}><span className="spinner" /> 翻译中…</div>
            ) : (
              <p>{translationPopup.translated}</p>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmReextract}
        title="重新提取原文"
        message={`将使用 ${extractEngine === 'docling' ? 'Docling（深度解析）' : 'PyMuPDF（快速文本）'} 重新提取该论文的页面文本与结构。提取过程可能需要一些时间，确定继续吗？`}
        confirmText="开始提取"
        onConfirm={handleReextract}
        onCancel={() => setConfirmReextract(false)}
      />
    </div>
  )
}
