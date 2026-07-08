import { useState } from 'react'
import { searchApi } from '../../api/search'
import { useSearchStore } from '../../stores/search-store'
import styles from './SearchPage.module.css'

export default function SearchPage() {
  const [query, setQuery] = useState('')
  const { results, isSearching, setResults, setSearching } = useSearchStore()

  const handleSearch = async () => {
    if (!query.trim()) return
    setSearching(true)
    try {
      const res = await searchApi.search({ query })
      setResults(res.data.results || [])
    } catch (err) {
      console.error(err)
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <a href="/" className={styles.back}>← 返回</a>
        <h1>🔍 论文检索</h1>
      </header>

      <div className={styles.searchBar}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="输入关键词、标题或作者名搜索论文..."
          className={styles.input}
        />
        <button onClick={handleSearch} disabled={isSearching} className="btn btn-primary">
          {isSearching ? '搜索中...' : '搜索'}
        </button>
      </div>

      <main className={styles.results}>
        {results.map((r, i) => (
          <div key={i} className={styles.resultCard}>
            <h3>{r.title}</h3>
            <p className={styles.authors}>{(r.authors || []).join(', ')}</p>
            <p className={styles.abstract}>{r.abstract}</p>
            <div className={styles.meta}>
              <span>{r.year}</span>
              <span>{r.source}</span>
              {r.citation_count !== undefined && <span>引用: {r.citation_count}</span>}
            </div>
            <button className="btn btn-primary btn-sm">📥 导入</button>
          </div>
        ))}
      </main>
    </div>
  )
}
