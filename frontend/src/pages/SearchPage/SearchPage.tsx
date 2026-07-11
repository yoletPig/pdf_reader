import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { searchApi } from '../../api/search'
import { useSearchStore } from '../../stores/search-store'
import styles from './SearchPage.module.css'

export default function SearchPage() {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [paperUrl, setPaperUrl] = useState('')
  const [error, setError] = useState('')
  const [importingKey, setImportingKey] = useState('')
  const [isImportingUrl, setIsImportingUrl] = useState(false)
  const { results, isSearching, setResults, setSearching } = useSearchStore()

  const handleSearch = async () => {
    const normalizedQuery = query.trim()
    if (!normalizedQuery) return

    setSearching(true)
    setError('')
    try {
      const res = await searchApi.search({ query: normalizedQuery, source: 'arxiv', max_results: 12 })
      setResults(res.data.results || [])
    } catch (err: any) {
      console.error(err)
      setResults([])
      setError(err?.response?.data?.detail || '搜索失败，请稍后重试。')
    } finally {
      setSearching(false)
    }
  }

  const handleImport = async (payload: { source?: string; source_id?: string; url?: string }, key: string) => {
    setImportingKey(key)
    setError('')
    try {
      const res = await searchApi.import(payload)
      const paperId = res.data.paper_id || res.data.paper?.id
      if (!paperId) {
        throw new Error('导入成功但未返回 paper_id')
      }
      navigate(`/reader/${paperId}`)
    } catch (err: any) {
      console.error(err)
      setError(err?.response?.data?.detail || '导入失败，请稍后重试。')
    } finally {
      setImportingKey('')
    }
  }

  const handleImportUrl = async () => {
    const normalizedUrl = paperUrl.trim()
    if (!normalizedUrl) return
    setIsImportingUrl(true)
    await handleImport({ url: normalizedUrl }, `url:${normalizedUrl}`)
    setIsImportingUrl(false)
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <a href="/" className={styles.back}>← 返回</a>
        <div className={styles.headerText}>
          <h1>论文检索与导入</h1>
          <p>先在 arXiv 搜索，也可以直接粘贴论文链接自动下载入库。</p>
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.searchPanel}>
          <div className={styles.panelTitle}>关键词搜索</div>
          <div className={styles.searchBar}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleSearch()}
              placeholder="输入标题、关键词或作者，当前使用 arXiv 搜索..."
              className={styles.input}
            />
            <button onClick={() => void handleSearch()} disabled={isSearching} className={styles.primaryBtn}>
              {isSearching ? '搜索中...' : '搜索'}
            </button>
          </div>
        </div>

        <div className={styles.importPanel}>
          <div className={styles.panelTitle}>URL 导入</div>
          <div className={styles.urlBar}>
            <input
              type="text"
              value={paperUrl}
              onChange={(e) => setPaperUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void handleImportUrl()}
              placeholder="粘贴 arXiv 链接、PDF 直链或带 PDF 下载地址的论文页面..."
              className={styles.input}
            />
            <button onClick={() => void handleImportUrl()} disabled={isImportingUrl} className={styles.secondaryBtn}>
              {isImportingUrl ? '导入中...' : '自动入库'}
            </button>
          </div>
        </div>
      </section>

      {error ? <div className={styles.errorBanner}>{error}</div> : null}

      <main className={styles.results}>
        {!isSearching && results.length === 0 ? (
          <div className={styles.emptyState}>
            <p>还没有搜索结果。</p>
            <span>可以直接搜索 arXiv，也可以粘贴论文 URL 立即入库。</span>
          </div>
        ) : null}

        {results.map((result, index) => {
          const importKey = result.source_id ? `${result.source}:${result.source_id}` : (result.url || `result:${index}`)
          return (
            <article key={importKey} className={styles.resultCard}>
              <div className={styles.cardTop}>
                <div className={styles.cardMain}>
                  <h3>{result.title}</h3>
                  <p className={styles.authors}>{(result.authors || []).join(', ') || '作者信息缺失'}</p>
                </div>
                <button
                  className={styles.primaryBtn}
                  onClick={() => void handleImport({ source: result.source, source_id: result.source_id, url: result.url }, importKey)}
                  disabled={importingKey === importKey}
                >
                  {importingKey === importKey ? '导入中...' : '导入到知识库'}
                </button>
              </div>

              <p className={styles.abstract}>{result.abstract || '暂无摘要'}</p>

              <div className={styles.meta}>
                <span>{result.year || '未知年份'}</span>
                <span>{result.source}</span>
                {result.citation_count !== undefined && result.citation_count !== null ? <span>引用: {result.citation_count}</span> : null}
              </div>

              <div className={styles.links}>
                {result.url ? (
                  <a href={result.url} target="_blank" rel="noreferrer" className={styles.inlineLink}>
                    查看详情
                  </a>
                ) : null}
                {result.pdf_url ? (
                  <a href={result.pdf_url} target="_blank" rel="noreferrer" className={styles.inlineLink}>
                    PDF
                  </a>
                ) : null}
              </div>
            </article>
          )
        })}
      </main>
    </div>
  )
}
