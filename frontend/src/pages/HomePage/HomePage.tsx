import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Paper, papersApi } from '../../api/papers'
import styles from './HomePage.module.css'

type GroupMode = 'all' | 'source' | 'year'
type IndexFilter = 'all' | 'indexed' | 'pending'
type SortMode = 'recent' | 'title' | 'year' | 'progress'

const PAGE_SIZE = 24

function parseAuthors(value: string) {
  try {
    const parsed = JSON.parse(value || '[]')
    return Array.isArray(parsed) ? parsed.filter(Boolean).join(', ') : value
  } catch {
    return value || ''
  }
}

function truncateText(value: string, maxLength = 220) {
  const text = (value || '').trim()
  if (!text) return '暂无摘要'
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text
}

function formatDate(value: string) {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '未知时间'
  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

function progressPercent(paper: Paper) {
  return Math.round(Math.max(0, Math.min(1, paper.read_progress || 0)) * 100)
}

export default function HomePage() {
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [papers, setPapers] = useState<Paper[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [total, setTotal] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [queryInput, setQueryInput] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [indexFilter, setIndexFilter] = useState<IndexFilter>('all')
  const [sortMode, setSortMode] = useState<SortMode>('recent')
  const [groupMode, setGroupMode] = useState<GroupMode>('all')
  const [reindexingId, setReindexingId] = useState('')

  const fetchPapers = async (page: number, query = appliedQuery, source = sourceFilter, indexedState = indexFilter, sort = sortMode) => {
    setLoading(true)
    try {
      const res = await papersApi.list({
        page,
        page_size: PAGE_SIZE,
        query: query || undefined,
        source: source === 'all' ? undefined : source,
        indexed: indexedState === 'all' ? undefined : indexedState === 'indexed',
        sort,
      })
      setPapers(res.data.papers || [])
      setTotal(res.data.total || 0)
      setCurrentPage(res.data.page || page)
    } catch (err) {
      console.error(err)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void fetchPapers(currentPage)
  }, [currentPage, appliedQuery, sourceFilter, indexFilter, sortMode])

  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await papersApi.upload(formData)
      navigate(`/reader/${res.data.paper.id}`)
    } catch (err) {
      console.error('上传失败:', err)
      alert('上传失败，请重试')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDelete = async (event: React.MouseEvent, paperId: string) => {
    event.preventDefault()
    event.stopPropagation()
    if (!confirm('确定要删除这篇论文吗？')) return
    try {
      await papersApi.delete(paperId)
      void fetchPapers(currentPage)
    } catch (err) {
      console.error('删除失败:', err)
    }
  }

  const handleReindex = async (event: React.MouseEvent, paperId: string) => {
    event.preventDefault()
    event.stopPropagation()
    setReindexingId(paperId)
    try {
      await papersApi.reindex(paperId)
      await fetchPapers(currentPage)
    } catch (err: any) {
      console.error('重建索引失败:', err)
      alert(err?.response?.data?.detail || '重建索引失败，请稍后重试')
    } finally {
      setReindexingId('')
    }
  }

  const handleSearchSubmit = () => {
    setCurrentPage(1)
    setAppliedQuery(queryInput.trim())
  }

  const groupedPapers = useMemo(() => {
    if (groupMode === 'all') {
      return [{ key: 'all', label: `当前结果 (${papers.length})`, items: papers }]
    }

    const bucket = new Map<string, { label: string; items: Paper[] }>()
    for (const paper of papers) {
      const key = groupMode === 'source'
        ? (paper.source || 'unknown')
        : String(paper.year || '未知年份')
      const label = groupMode === 'source'
        ? `${paper.source || 'unknown'}`
        : `${paper.year || '未知年份'}`
      const entry = bucket.get(key) || { label, items: [] }
      entry.items.push(paper)
      bucket.set(key, entry)
    }

    return Array.from(bucket.entries())
      .map(([key, value]) => ({ key, label: `${value.label} (${value.items.length})`, items: value.items }))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }))
  }, [groupMode, papers])

  const sourceSummary = useMemo(() => {
    const counts = papers.reduce<Record<string, number>>((acc, paper) => {
      const key = paper.source || 'unknown'
      acc[key] = (acc[key] || 0) + 1
      return acc
    }, {})
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([source, count]) => `${source} ${count}`)
      .join(' · ') || '暂无来源统计'
  }, [papers])

  const indexedCount = papers.filter((paper) => paper.is_indexed).length
  const averageProgress = papers.length
    ? Math.round(papers.reduce((sum, paper) => sum + progressPercent(paper), 0) / papers.length)
    : 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerMain}>
          <div>
            <p className={styles.eyebrow}>Knowledge Base</p>
            <h1>知识库</h1>
            <p className={styles.subtitle}>为后续大规模归档预留了检索、筛选、分组和分页，不再依赖整页卡片堆叠。</p>
          </div>

          <div className={styles.headerActions}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.md,.html,.htm,.txt"
              onChange={handleUpload}
              style={{ display: 'none' }}
              id="pdf-upload-input"
            />
            <button className={styles.primaryAction} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? '上传中...' : '上传文件'}
            </button>
            <Link to="/search" className={styles.secondaryAction}>检索论文</Link>
            <Link to="/chat" className={styles.secondaryAction}>跨论文问答</Link>
            <Link to="/settings" className={styles.ghostAction}>设置</Link>
          </div>
        </div>

        <div className={styles.overviewGrid}>
          <div className={styles.overviewCard}>
            <span>当前命中</span>
            <strong>{total}</strong>
            <small>筛选后总论文数</small>
          </div>
          <div className={styles.overviewCard}>
            <span>已索引</span>
            <strong>{indexedCount}</strong>
            <small>当前页可直接用于检索</small>
          </div>
          <div className={styles.overviewCard}>
            <span>平均进度</span>
            <strong>{averageProgress}%</strong>
            <small>按当前页阅读进度估算</small>
          </div>
          <div className={styles.overviewCard}>
            <span>来源分布</span>
            <strong className={styles.overviewText}>{sourceSummary}</strong>
            <small>便于后续按来源归档</small>
          </div>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.controlPanel}>
          <div className={styles.searchRow}>
            <input
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              onKeyDown={(event) => event.key === 'Enter' && handleSearchSubmit()}
              placeholder="按标题、摘要、作者检索知识库..."
              className={styles.searchInput}
            />
            <button className={styles.primaryAction} onClick={handleSearchSubmit}>搜索</button>
          </div>

          <div className={styles.filterRow}>
            <label className={styles.filterItem}>
              <span>来源</span>
              <select value={sourceFilter} onChange={(event) => { setCurrentPage(1); setSourceFilter(event.target.value) }}>
                <option value="all">全部</option>
                <option value="local">本地上传</option>
                <option value="arxiv">arXiv</option>
                <option value="url">URL 导入</option>
              </select>
            </label>

            <label className={styles.filterItem}>
              <span>状态</span>
              <select value={indexFilter} onChange={(event) => { setCurrentPage(1); setIndexFilter(event.target.value as IndexFilter) }}>
                <option value="all">全部</option>
                <option value="indexed">已索引</option>
                <option value="pending">未索引</option>
              </select>
            </label>

            <label className={styles.filterItem}>
              <span>排序</span>
              <select value={sortMode} onChange={(event) => { setCurrentPage(1); setSortMode(event.target.value as SortMode) }}>
                <option value="recent">最近加入</option>
                <option value="title">标题 A-Z</option>
                <option value="year">年份优先</option>
                <option value="progress">阅读进度</option>
              </select>
            </label>

            <label className={styles.filterItem}>
              <span>归档视图</span>
              <select value={groupMode} onChange={(event) => setGroupMode(event.target.value as GroupMode)}>
                <option value="all">单列表</option>
                <option value="source">按来源分组</option>
                <option value="year">按年份分组</option>
              </select>
            </label>
          </div>
        </section>

        {loading ? (
          <div className={styles.loading}>加载论文列表中...</div>
        ) : total === 0 ? (
          <div className={styles.empty}>
            <p>当前筛选条件下没有论文。</p>
            <p className={styles.emptyHint}>可以清空筛选、重新检索，或者继续上传 PDF / 从检索页导入。</p>
          </div>
        ) : (
          <>
            <div className={styles.listHeader}>
              <span>第 {currentPage}/{totalPages} 页</span>
              <span>每页 {PAGE_SIZE} 篇</span>
              <span>{appliedQuery ? `关键词: ${appliedQuery}` : '无关键词限制'}</span>
            </div>

            <div className={styles.sections}>
              {groupedPapers.map((group) => (
                <section key={group.key} className={styles.sectionCard}>
                  <div className={styles.sectionHeader}>
                    <h2>{group.label}</h2>
                  </div>

                  <div className={styles.paperList}>
                    {group.items.map((paper) => (
                      <article key={paper.id} className={styles.paperRow}>
                        <div className={styles.paperMain}>
                          <div className={styles.paperTop}>
                            <button className={styles.paperTitle} onClick={() => navigate(`/reader/${paper.id}`)}>
                              {paper.title || '未命名论文'}
                            </button>
                            <div className={styles.paperActions}>
                              <button className={styles.openBtn} onClick={() => navigate(`/reader/${paper.id}`)}>打开</button>
                              {!paper.is_indexed ? (
                                <button
                                  className={styles.reindexBtn}
                                  onClick={(event) => void handleReindex(event, paper.id)}
                                  disabled={reindexingId === paper.id}
                                >
                                  {reindexingId === paper.id ? '重建中...' : '重建索引'}
                                </button>
                              ) : null}
                              <button className={styles.deleteBtn} onClick={(event) => void handleDelete(event, paper.id)}>删除</button>
                            </div>
                          </div>

                          <p className={styles.authors}>{parseAuthors(paper.authors) || '作者信息缺失'}</p>
                          <p className={styles.abstract}>{truncateText(paper.abstract)}</p>
                        </div>

                        <div className={styles.paperMeta}>
                          <div className={styles.metaChips}>
                            <span>{paper.year || '未知年份'}</span>
                            <span>{paper.source}</span>
                            {paper.page_count ? <span>{paper.page_count} 页</span> : null}
                            <span>{formatDate(paper.added_at)}</span>
                            {paper.is_indexed ? <span className={styles.goodChip}>已索引</span> : <span>待索引</span>}
                            {!paper.is_indexed && paper.reader_profile?.indexing_status === 'failed' ? (
                              <span className={styles.warnChip}>索引失败</span>
                            ) : null}
                          </div>

                          <div className={styles.progressBlock}>
                            <div className={styles.progressLabel}>
                              <span>阅读进度</span>
                              <strong>{progressPercent(paper)}%</strong>
                            </div>
                            <div className={styles.progressTrack}>
                              <div className={styles.progressBar} style={{ width: `${progressPercent(paper)}%` }} />
                            </div>
                            {!paper.is_indexed && paper.reader_profile?.indexing_error ? (
                              <p className={styles.indexError}>{String(paper.reader_profile.indexing_error)}</p>
                            ) : null}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>

            <div className={styles.pagination}>
              <button className={styles.pageBtn} onClick={() => setCurrentPage((value) => Math.max(1, value - 1))} disabled={currentPage <= 1}>
                上一页
              </button>
              <div className={styles.pageStatus}>{currentPage} / {totalPages}</div>
              <button className={styles.pageBtn} onClick={() => setCurrentPage((value) => Math.min(totalPages, value + 1))} disabled={currentPage >= totalPages}>
                下一页
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
