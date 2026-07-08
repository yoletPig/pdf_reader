import { useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Document, Page, pdfjs } from 'react-pdf'
import styles from './VerifyPDFPage.module.css'

// 引入 react-pdf 的核心样式，确保文本选区和批注正确对齐且不混乱
import 'react-pdf/dist/Page/TextLayer.css'
import 'react-pdf/dist/Page/AnnotationLayer.css'

// 设置 Worker (使用之前复制过来的新版本地 Worker 文件)
pdfjs.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'

export default function VerifyPDFPage() {
  const [file, setFile] = useState<File | null>(null)
  const [numPages, setNumPages] = useState<number | null>(null)
  const [currentPage, setCurrentPage] = useState(1)
  const [scale, setScale] = useState(1.2)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  
  // 状态：当前选中的文本
  const [selectedText, setSelectedText] = useState('')
  // 状态：当前页提取出来的纯文本
  const [extractedText, setExtractedText] = useState('')

  // 处理文件上传
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0]
    if (selectedFile) {
      if (selectedFile.type !== 'application/pdf') {
        alert('请选择 PDF 文件！')
        return
      }
      setFile(selectedFile)
      setCurrentPage(1)
      setExtractedText('')
      setSelectedText('')
      setError('')
    }
  }

  // PDF 加载成功
  const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
    setNumPages(numPages)
    setLoading(false)
  }

  // PDF 加载失败
  const onDocumentLoadError = (err: Error) => {
    setError('PDF 加载失败: ' + err.message)
    setLoading(false)
  }

  // 页面加载成功时，提取页面文本
  const onPageLoadSuccess = useCallback(async (page: any) => {
    try {
      const textContent = await page.getTextContent()
      // 将文本项拼接起来
      let lastY = -1
      let textItems: string[] = []
      
      for (const item of textContent.items) {
        // 如果换行了，添加换行符以保持基本的排版结构
        if (lastY !== -1 && Math.abs(item.transform[5] - lastY) > 5) {
          textItems.push('\n')
        }
        textItems.push(item.str)
        lastY = item.transform[5]
      }
      
      setExtractedText(textItems.join(' '))
    } catch (err) {
      console.error('提取页面文本失败:', err)
      setExtractedText('无法从该页提取文本')
    }
  }, [])

  // 监听选区变化
  const handleTextSelection = () => {
    const selection = window.getSelection()
    if (selection) {
      setSelectedText(selection.toString().trim())
    }
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerLeft}>
          <Link to="/" className={styles.backLink}>← 返回首页</Link>
          <h1 className={styles.title}>🔬 PDF 功能纯前端验证页</h1>
        </div>
        
        {file && (
          <div className={styles.controls}>
            <button 
              className={styles.btn}
              onClick={() => {
                setFile(null)
                setNumPages(null)
                setExtractedText('')
                setSelectedText('')
              }}
            >
              重新上传
            </button>
            <div style={{ width: '1px', height: '24px', background: '#e2e8f0' }} />
            <button 
              className={styles.btn}
              onClick={() => setCurrentPage(prev => Math.max(1, prev - 1))}
              disabled={currentPage <= 1}
            >
              上一页
            </button>
            <span className={styles.zoomValue}>{currentPage} / {numPages || '?'}</span>
            <button 
              className={styles.btn}
              onClick={() => setCurrentPage(prev => Math.min(numPages || 1, prev + 1))}
              disabled={currentPage >= (numPages || 1)}
            >
              下一页
            </button>
            <div style={{ width: '1px', height: '24px', background: '#e2e8f0' }} />
            <button 
              className={styles.btn} 
              onClick={() => setScale(s => Math.max(0.5, s - 0.1))}
            >
              缩小 -
            </button>
            <span className={styles.zoomValue}>{Math.round(scale * 100)}%</span>
            <button 
              className={styles.btn} 
              onClick={() => setScale(s => Math.min(2.0, s + 0.1))}
            >
              放大 +
            </button>
          </div>
        )}
      </header>

      <main className={styles.main}>
        {!file ? (
          <label className={styles.uploadArea}>
            <div className={styles.uploadIcon}>📤</div>
            <div className={styles.uploadText}>点击或拖拽上传 PDF 进行验证</div>
            <div className={styles.uploadSubtext}>支持单栏学术论文或任意 PDF 文档</div>
            <input 
              type="file" 
              accept=".pdf" 
              className={styles.fileInput} 
              onChange={handleFileChange}
            />
            <span className={styles.btn + ' ' + styles.btnPrimary}>选择 PDF 文件</span>
          </label>
        ) : (
          <div className={styles.viewerContainer}>
            {/* 左侧：PDF 渲染区域 */}
            <div className={styles.pdfPane} onMouseUp={handleTextSelection}>
              {error ? (
                <div style={{ color: '#ef4444', padding: '20px' }}>{error}</div>
              ) : (
                <div className={styles.pdfWrapper}>
                  <Document
                    file={file}
                    onLoadSuccess={onDocumentLoadSuccess}
                    onLoadError={onDocumentLoadError}
                    loading={<div style={{ padding: '20px' }}>正在加载 PDF 文档...</div>}
                  >
                    <Page 
                      pageNumber={currentPage} 
                      scale={scale}
                      onLoadSuccess={onPageLoadSuccess}
                      devicePixelRatio={Math.min(4, window.devicePixelRatio || 1)}
                      loading={<div style={{ padding: '20px' }}>正在渲染页面...</div>}
                    />
                  </Document>
                </div>
              )}
            </div>

            {/* 右侧：诊断与文本分析面板 */}
            <aside className={styles.sidebar}>
              <div className={styles.sidebarSection}>
                <h3 className={styles.sectionTitle}>文档诊断信息</h3>
                <div className={styles.statsGrid}>
                  <div className={styles.statCard}>
                    <div className={styles.statLabel}>文件名</div>
                    <div className={styles.statValue} style={{ wordBreak: 'break-all', fontSize: '12px' }}>
                      {file.name}
                    </div>
                  </div>
                  <div className={styles.statCard}>
                    <div className={styles.statLabel}>文件大小</div>
                    <div className={styles.statValue}>
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                    </div>
                  </div>
                </div>
              </div>

              <div className={styles.sidebarSection}>
                <h3 className={styles.sectionTitle}>🖱️ 鼠标当前选中的文本</h3>
                {selectedText ? (
                  <div className={styles.selectedTextContainer}>
                    {selectedText}
                  </div>
                ) : (
                  <p className={styles.emptyText}>在左侧 PDF 中用鼠标选择文本以测试划词...</p>
                )}
              </div>

              <div className={styles.sidebarSection}>
                <h3 className={styles.sectionTitle}>📝 当前页提取的文本流 (PDF.js)</h3>
                <div className={styles.textExtractor}>
                  <pre className={styles.extractedText}>
                    {extractedText || '正在提取当前页文本...'}
                  </pre>
                </div>
              </div>
            </aside>
          </div>
        )}
      </main>
    </div>
  )
}
