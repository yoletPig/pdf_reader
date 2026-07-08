import { useState, useEffect, useRef } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { papersApi, Paper } from '../../api/papers'
import styles from './HomePage.module.css'

export default function HomePage() {
  const [papers, setPapers] = useState<Paper[]>([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const fetchPapers = () => {
    papersApi.list()
      .then(res => setPapers(res.data.papers || []))
      .catch(console.error)
      .finally(() => setLoading(false))
  }

  useEffect(() => { fetchPapers() }, [])

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.name.toLowerCase().endsWith('.pdf')) {
      alert('仅支持 PDF 文件')
      return
    }

    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await papersApi.upload(formData)
      const paper = res.data.paper
      // 上传成功后直接跳转到阅读器
      navigate(`/reader/${paper.id}`)
    } catch (err) {
      console.error('上传失败:', err)
      alert('上传失败，请重试')
    } finally {
      setUploading(false)
      // 重置 input 以允许重复上传同一文件
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDelete = async (e: React.MouseEvent, paperId: string) => {
    e.preventDefault()
    e.stopPropagation()
    if (!confirm('确定要删除这篇论文吗？')) return
    try {
      await papersApi.delete(paperId)
      fetchPapers()
    } catch (err) {
      console.error('删除失败:', err)
    }
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h1>📚 知识库</h1>
        <div className={styles.actions}>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            onChange={handleUpload}
            style={{ display: 'none' }}
            id="pdf-upload-input"
          />
          <button
            className="btn btn-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? '⏳ 上传中...' : '📤 上传 PDF'}
          </button>
          <Link to="/search" className="btn btn-secondary">🔍 检索论文</Link>
          <Link to="/chat" className="btn btn-secondary">💬 跨论文问答</Link>
          <Link to="/verify-pdf" className="btn btn-secondary">🔬 验证 PDF</Link>
          <Link to="/settings" className="btn btn-ghost">⚙️ 设置</Link>
        </div>
      </header>

      <main className={styles.main}>
        {loading ? (
          <div className={styles.loading}>加载论文列表中...</div>
        ) : papers.length === 0 ? (
          <div className={styles.empty}>
            <p>📭 还没有论文</p>
            <p className={styles.emptyHint}>点击「上传 PDF」添加论文，或前往检索页面搜索</p>
            <div className={styles.emptyActions}>
              <button
                className="btn btn-primary"
                onClick={() => fileInputRef.current?.click()}
              >
                📤 上传 PDF
              </button>
              <Link to="/search" className="btn btn-secondary">🔍 检索论文</Link>
            </div>
          </div>
        ) : (
          <div className={styles.grid}>
            {papers.map(paper => (
              <Link to={`/reader/${paper.id}`} key={paper.id} className={styles.card}>
                <div className={styles.cardHeader}>
                  <h3>{paper.title || '未命名论文'}</h3>
                  <button
                    className={styles.deleteBtn}
                    onClick={(e) => handleDelete(e, paper.id)}
                    title="删除"
                  >
                    🗑️
                  </button>
                </div>
                <p className={styles.authors}>
                  {(() => {
                    try { return JSON.parse(paper.authors || '[]').join(', ') }
                    catch { return paper.authors || '' }
                  })()}
                </p>
                <p className={styles.abstract}>
                  {paper.abstract?.slice(0, 150) || '暂无摘要'}
                </p>
                <div className={styles.meta}>
                  <span>{paper.year || '未知年份'}</span>
                  <span>{paper.source}</span>
                  {paper.page_count ? <span>{paper.page_count} 页</span> : null}
                  {paper.is_indexed && <span className={styles.badge}>已索引</span>}
                </div>
                <div className={styles.progress}>
                  <div className={styles.progressBar} style={{ width: `${paper.read_progress * 100}%` }} />
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
