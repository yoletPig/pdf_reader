import { useCallback, useEffect, useState } from 'react'
import { dailyPapersApi, type DailyPaper, type DailyPaperSource } from '../../api/dailyPapers'
import { Segmented, useToast } from '../ui/kit'
import styles from './DailyPapers.module.css'

type SourceFilter = 'all' | 'huggingface' | 'modelscope'

const SOURCE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'huggingface', label: '🤗 HuggingFace' },
  { value: 'modelscope', label: '🟠 ModelScope' },
] as const

const SOURCE_LABELS: Record<DailyPaperSource, string> = {
  huggingface: 'HuggingFace',
  modelscope: 'ModelScope',
}

const PAGE_SIZE = 12

function PaperCard({ paper }: { paper: DailyPaper }) {
  return (
    <article className={styles.card}>
      <div className={styles.cardHead}>
        <span className={`${styles.sourceTag} ${styles[`source_${paper.source}`]}`}>
          {SOURCE_LABELS[paper.source]}
        </span>
        {paper.published_at && <span className={styles.date}>{paper.published_at}</span>}
      </div>
      <h3 className={styles.cardTitle}>
        <a href={paper.url} target="_blank" rel="noreferrer">
          {paper.title}
        </a>
      </h3>
      {paper.authors.length > 0 && (
        <div className={styles.authors}>
          {paper.authors.slice(0, 4).join(', ')}
          {paper.authors.length > 4 ? ` 等 ${paper.authors.length} 位作者` : ''}
        </div>
      )}
      {paper.abstract && <p className={styles.abstract}>{paper.abstract}</p>}
      <div className={styles.chips}>
        {paper.upvotes > 0 && <span className={styles.chip}>👍 {paper.upvotes}</span>}
        {paper.comments > 0 && <span className={styles.chip}>💬 {paper.comments}</span>}
        {paper.rating > 0 && <span className={styles.chip}>⭐ {paper.rating.toFixed(1)}</span>}
        {paper.keywords.slice(0, 3).map((k) => (
          <span key={k} className={`${styles.chip} ${styles.keyword}`}>{k}</span>
        ))}
      </div>
      <div className={styles.actions}>
        <a className={styles.actionBtn} href={paper.url} target="_blank" rel="noreferrer">
          📄 原文
        </a>
        {paper.pdf_url && (
          <a className={styles.actionBtn} href={paper.pdf_url} target="_blank" rel="noreferrer">
            📥 PDF
          </a>
        )}
        {paper.code_url && (
          <a className={styles.actionBtn} href={paper.code_url} target="_blank" rel="noreferrer">
            💻 代码
          </a>
        )}
      </div>
    </article>
  )
}

/** 每日论文：HuggingFace Daily Papers + ModelScope 推荐 */
export function DailyPapers() {
  const toast = useToast()
  const [source, setSource] = useState<SourceFilter>('all')
  const [papers, setPapers] = useState<DailyPaper[]>([])
  const [dateLabel, setDateLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [page, setPage] = useState(1)

  const fetchPapers = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true)
    try {
      const res = await dailyPapersApi.list({ refresh, limit: 30 })
      setPapers(res.data.papers)
      setDateLabel(res.data.date)
    } catch {
      if (refresh) toast.error('刷新失败，请稍后再试')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void fetchPapers()
  }, [fetchPapers])

  const visible = source === 'all' ? papers : papers.filter((p) => p.source === source)

  // 分页（客户端）
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE))
  const current = Math.min(page, totalPages)
  const paged = visible.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  const changeSource = (next: SourceFilter) => {
    setSource(next)
    setPage(1)
  }

  return (
    <section className={styles.section}>
      <header className={styles.head}>
        <h2 className={styles.title}>
          📚 每日论文
          <span className={styles.subtitle}>HF Daily Papers · ModelScope 推荐 · {dateLabel}</span>
        </h2>
        <div className={styles.headActions}>
          <Segmented options={[...SOURCE_OPTIONS]} value={source} onChange={changeSource} size="sm" />
          <button
            className={`btn btn-ghost btn-sm ${refreshing ? styles.refreshing : ''}`}
            onClick={() => fetchPapers(true)}
            disabled={refreshing}
            title="刷新"
          >
            {refreshing ? '⟳ 刷新中…' : '⟳ 刷新'}
          </button>
        </div>
      </header>

      {loading ? (
        <div className={styles.loading}>
          <div className="spinner" />
          <span>正在获取今日论文推荐…</span>
        </div>
      ) : visible.length === 0 ? (
        <div className={styles.empty}>暂无论文数据，点击「刷新」重试</div>
      ) : (
        <div className={styles.grid}>
          {paged.map((paper) => (
            <PaperCard key={`${paper.source}-${paper.id}`} paper={paper} />
          ))}
        </div>
      )}

      {!loading && visible.length > 0 && totalPages > 1 && (
        <div className={styles.pager}>
          <button
            className={styles.pageBtn}
            disabled={current <= 1}
            onClick={() => setPage(current - 1)}
          >
            ‹ 上一页
          </button>
          <span className={styles.pageInfo}>
            第 {current} / {totalPages} 页 · 共 {visible.length} 篇
          </span>
          <button
            className={styles.pageBtn}
            disabled={current >= totalPages}
            onClick={() => setPage(current + 1)}
          >
            下一页 ›
          </button>
        </div>
      )}
    </section>
  )
}
