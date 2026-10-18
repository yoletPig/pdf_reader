import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { papersApi, type Paper } from '../../api/papers'
import { foldersApi, type FolderItem, type TagCount } from '../../api/folders'
import { ConfirmDialog, Modal, ThemeToggle, useToast } from '../../components/ui/kit'
import styles from './HomePage.module.css'

type NavKey = 'all' | 'uncategorized' | string // string = folder id

function truncate(text: string, max: number) {
  if (!text) return ''
  return text.length > max ? text.slice(0, max) + '…' : text
}

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
    return raw || ''
  }
}

export default function HomePage() {
  const navigate = useNavigate()
  const toast = useToast()

  const [papers, setPapers] = useState<Paper[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [queryInput, setQueryInput] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [sortMode, setSortMode] = useState<'recent' | 'title' | 'year' | 'progress'>('recent')
  const [navKey, setNavKey] = useState<NavKey>('all')
  const [folders, setFolders] = useState<FolderItem[]>([])
  const [folderCounts, setFolderCounts] = useState({ uncategorized: 0, total: 0 })
  const [tags, setTags] = useState<TagCount[]>([])
  const [activeTag, setActiveTag] = useState('')
  const [dragOver, setDragOver] = useState(false)

  // 弹窗状态
  const [folderModal, setFolderModal] = useState<{ open: boolean; editing?: FolderItem }>({ open: false })
  const [folderName, setFolderName] = useState('')
  const [tagModalPaper, setTagModalPaper] = useState<Paper | null>(null)
  const [tagDraft, setTagDraft] = useState('')
  const [moveModalPaper, setMoveModalPaper] = useState<Paper | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Paper | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  /* ---------- 数据加载 ---------- */

  const fetchMeta = useCallback(async () => {
    const [foldersRes, tagsRes] = await Promise.all([foldersApi.list(), foldersApi.allTags()])
    setFolders(foldersRes.data.folders || [])
    setFolderCounts({
      uncategorized: foldersRes.data.uncategorized_count || 0,
      total: foldersRes.data.total_count || 0,
    })
    setTags(tagsRes.data.tags || [])
  }, [])

  const fetchPapers = useCallback(async () => {
    setLoading(true)
    try {
      const params: any = {
        sort: sortMode,
        query: appliedQuery,
        page_size: 100,
      }
      if (navKey === 'uncategorized') params.folder_id = ''
      else if (navKey !== 'all') params.folder_id = navKey
      if (activeTag) params.tag = activeTag
      const res = await papersApi.list(params)
      setPapers(res.data.papers || [])
      setTotal(res.data.total || 0)
    } catch {
      toast.error('加载论文列表失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortMode, appliedQuery, navKey, activeTag])

  useEffect(() => {
    fetchMeta().catch(() => {})
    fetchPapers()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchPapers])

  /* ---------- 上传 ---------- */

  const doUpload = async (file: File) => {
    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await papersApi.upload(formData)
      toast.success('论文导入成功')
      await fetchMeta()
      await fetchPapers()
      navigate(`/reader/${res.data.paper.id}`)
    } catch {
      toast.error('导入失败，请检查文件格式')
    } finally {
      setUploading(false)
    }
  }

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) doUpload(file)
    e.target.value = ''
  }

  /* ---------- 文件夹 / 标签操作 ---------- */

  const handleSaveFolder = async () => {
    const name = folderName.trim()
    if (!name) return
    try {
      if (folderModal.editing) {
        await foldersApi.update(folderModal.editing.id, {
          name,
          parent_id: folderModal.editing.parent_id,
          sort_order: folderModal.editing.sort_order,
        })
        toast.success('文件夹已更新')
      } else {
        await foldersApi.create({ name })
        toast.success('文件夹已创建')
      }
      setFolderModal({ open: false })
      setFolderName('')
      await fetchMeta()
    } catch {
      toast.error('操作失败')
    }
  }

  const handleDeleteFolder = async (folder: FolderItem) => {
    try {
      await foldersApi.delete(folder.id)
      toast.success(`已删除文件夹「${folder.name}」，论文移至未分组`)
      if (navKey === folder.id) setNavKey('all')
      await fetchMeta()
      await fetchPapers()
    } catch {
      toast.error('删除失败')
    }
  }

  const handleSaveTags = async () => {
    if (!tagModalPaper) return
    const list = tagDraft.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean)
    try {
      await foldersApi.setTags(tagModalPaper.id, list)
      toast.success('标签已保存')
      setTagModalPaper(null)
      await fetchMeta()
      await fetchPapers()
    } catch {
      toast.error('保存失败')
    }
  }

  const handleMovePaper = async (folderId: string) => {
    if (!moveModalPaper) return
    try {
      await foldersApi.assignPaper(moveModalPaper.id, folderId)
      toast.success(folderId ? '已移动到文件夹' : '已移出文件夹')
      setMoveModalPaper(null)
      await fetchMeta()
      await fetchPapers()
    } catch {
      toast.error('移动失败')
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await papersApi.delete(deleteTarget.id)
      toast.success('论文已删除')
      setDeleteTarget(null)
      await fetchMeta()
      await fetchPapers()
    } catch {
      toast.error('删除失败')
    }
  }

  /* ---------- 渲染 ---------- */

  return (
    <div
      className={styles.container}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const file = e.dataTransfer.files?.[0]
        if (file) doUpload(file)
      }}
    >
      {/* ======== 侧栏：文件夹 & 标签 ======== */}
      <aside className={styles.sidebar}>
        <div className={styles.brand} onClick={() => setNavKey('all')}>
          <span className={styles.brandIcon}>📜</span>
          <span className={styles.brandName}>Papers</span>
        </div>

        <nav className={styles.navSection}>
          <button
            className={`${styles.navItem} ${navKey === 'all' ? styles.navActive : ''}`}
            onClick={() => setNavKey('all')}
          >
            <span className={styles.navIcon}>🗂</span>
            <span className={styles.navLabel}>全部论文</span>
            <span className={styles.navCount}>{folderCounts.total}</span>
          </button>
          <button
            className={`${styles.navItem} ${navKey === 'uncategorized' ? styles.navActive : ''}`}
            onClick={() => setNavKey('uncategorized')}
          >
            <span className={styles.navIcon}>📄</span>
            <span className={styles.navLabel}>未分组</span>
            <span className={styles.navCount}>{folderCounts.uncategorized}</span>
          </button>
          <button className={styles.navItem} onClick={() => navigate('/chat')}>
            <span className={styles.navIcon}>✦</span>
            <span className={styles.navLabel}>AI 对话</span>
          </button>
          <button className={styles.navItem} onClick={() => navigate('/settings')}>
            <span className={styles.navIcon}>⚙️</span>
            <span className={styles.navLabel}>系统设置</span>
          </button>
        </nav>

        <div className={styles.sectionHeader}>
          <span>文件夹</span>
          <button
            className={styles.sectionAction}
            title="新建文件夹"
            onClick={() => { setFolderModal({ open: true }); setFolderName('') }}
          >
            ＋
          </button>
        </div>
        <div className={styles.folderList}>
          {folders.map((folder) => (
            <div
              key={folder.id}
              className={`${styles.navItem} ${navKey === folder.id ? styles.navActive : ''}`}
              onClick={() => setNavKey(folder.id)}
            >
              <span className={styles.navIcon}>📁</span>
              <span className={styles.navLabel}>{folder.name}</span>
              <span className={styles.navCount}>{folder.paper_count}</span>
              <div className={styles.folderActions}>
                <button
                  className={styles.folderAction}
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation()
                    setFolderModal({ open: true, editing: folder })
                    setFolderName(folder.name)
                  }}
                >
                  ✎
                </button>
                <button
                  className={styles.folderAction}
                  title="删除"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDeleteFolder(folder)
                  }}
                >
                  🗑
                </button>
              </div>
            </div>
          ))}
          {folders.length === 0 && <div className={styles.sidebarEmpty}>暂无文件夹</div>}
        </div>

        <div className={styles.sectionHeader}>
          <span>标签</span>
          {activeTag && (
            <button className={styles.sectionAction} onClick={() => setActiveTag('')}>✕</button>
          )}
        </div>
        <div className={styles.tagCloud}>
          {tags.slice(0, 24).map((tag) => (
            <button
              key={tag.name}
              className={`${styles.tagChip} ${activeTag === tag.name ? styles.tagChipActive : ''}`}
              onClick={() => setActiveTag(activeTag === tag.name ? '' : tag.name)}
            >
              {tag.name} <em>{tag.count}</em>
            </button>
          ))}
          {tags.length === 0 && <div className={styles.sidebarEmpty}>暂无标签</div>}
        </div>
      </aside>

      {/* ======== 主区 ======== */}
      <main className={styles.main}>
        <header className={styles.topbar}>
          <div className={styles.searchBox}>
            <span className={styles.searchIcon}>🔍</span>
            <input
              className={styles.searchInput}
              placeholder="搜索标题、摘要或作者…"
              value={queryInput}
              onChange={(e) => setQueryInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setAppliedQuery(queryInput.trim())
                if (e.key === 'Escape') { setQueryInput(''); setAppliedQuery('') }
              }}
            />
          </div>
          <select
            className="select"
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as any)}
          >
            <option value="recent">最近添加</option>
            <option value="title">按标题</option>
            <option value="year">按年份</option>
            <option value="progress">按阅读进度</option>
          </select>
          <ThemeToggle />
          <button
            className="btn btn-primary"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? '导入中…' : '＋ 导入论文'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf"
            hidden
            onChange={handleFileInput}
          />
        </header>

        <div className={styles.content}>
          {loading ? (
            <div className={styles.cardGrid}>
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={`${styles.card} ${styles.cardSkeleton}`}>
                  <div className="skeleton" style={{ height: 18, width: '78%' }} />
                  <div className="skeleton" style={{ height: 12, width: '42%' }} />
                  <div className="skeleton" style={{ height: 32, width: '100%', marginTop: 8 }} />
                  <div className="skeleton" style={{ height: 10, width: '55%', marginTop: 12 }} />
                </div>
              ))}
            </div>
          ) : papers.length === 0 ? (
            <div className="empty-state">
              <div className="empty-icon">📚</div>
              <div className="empty-title">
                {appliedQuery || activeTag ? '没有匹配的论文' : '论文库还是空的'}
              </div>
              <div className="empty-desc">
                {appliedQuery || activeTag
                  ? '换个关键词或筛选条件试试'
                  : '拖拽 PDF 到此页面，或点击右上角「导入论文」'}
              </div>
            </div>
          ) : (
            <div className={styles.cardGrid}>
              {papers.map((paper) => {
                const paperTags = parseTags(paper.tags)
                const progress = Math.round((paper.read_progress || 0) * 100)
                return (
                  <article
                    key={paper.id}
                    className={styles.card}
                    onClick={() => navigate(`/reader/${paper.id}`)}
                  >
                    <div className={styles.cardHeader}>
                      <h3 className={styles.cardTitle}>{paper.title || '未命名论文'}</h3>
                      <div className={styles.cardActions}>
                        <button
                          className={styles.cardAction}
                          title="编辑标签"
                          onClick={(e) => {
                            e.stopPropagation()
                            setTagModalPaper(paper)
                            setTagDraft(parseTags(paper.tags).join(' '))
                          }}
                        >
                          🏷
                        </button>
                        <button
                          className={styles.cardAction}
                          title="移动到文件夹"
                          onClick={(e) => {
                            e.stopPropagation()
                            setMoveModalPaper(paper)
                          }}
                        >
                          📁
                        </button>
                        <button
                          className={`${styles.cardAction} ${styles.cardActionDanger}`}
                          title="删除"
                          onClick={(e) => {
                            e.stopPropagation()
                            setDeleteTarget(paper)
                          }}
                        >
                          🗑
                        </button>
                      </div>
                    </div>
                    <div className={styles.cardAuthors}>{paper.authors ? truncate(parseAuthors(paper.authors), 60) : '未知作者'}</div>
                    {paper.abstract && (
                      <p className={styles.cardAbstract}>{truncate(paper.abstract, 120)}</p>
                    )}
                    <div className={styles.cardChips}>
                      {paper.year && <span className={styles.metaChip}>{paper.year}</span>}
                      {paper.page_count ? <span className={styles.metaChip}>{paper.page_count} 页</span> : null}
                      {paper.source && paper.source !== 'local' && (
                        <span className={styles.metaChip}>{paper.source}</span>
                      )}
                    </div>
                    {paperTags.length > 0 && (
                      <div className={styles.cardTags}>
                        {paperTags.slice(0, 4).map((tag) => (
                          <span key={tag} className={styles.cardTag}>{tag}</span>
                        ))}
                      </div>
                    )}
                    <div className={styles.cardProgress}>
                      <div className={styles.progressBar}>
                        <div className={styles.progressFill} style={{ width: `${progress}%` }} />
                      </div>
                      <span className={styles.progressText}>{progress > 0 ? `${progress}%` : ''}</span>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </div>
      </main>

      {/* 拖拽遮罩 */}
      {dragOver && (
        <div className={styles.dropOverlay}>
          <div className={styles.dropBox}>
            <div className={styles.dropIcon}>📄</div>
            <div>松开导入 PDF 论文</div>
          </div>
        </div>
      )}

      {/* 文件夹弹窗 */}
      <Modal
        open={folderModal.open}
        title={folderModal.editing ? '重命名文件夹' : '新建文件夹'}
        onClose={() => setFolderModal({ open: false })}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setFolderModal({ open: false })}>取消</button>
            <button className="btn btn-primary" onClick={handleSaveFolder}>保存</button>
          </>
        }
      >
        <input
          className="input"
          placeholder="文件夹名称"
          value={folderName}
          autoFocus
          onChange={(e) => setFolderName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSaveFolder()}
        />
      </Modal>

      {/* 标签编辑弹窗 */}
      <Modal
        open={!!tagModalPaper}
        title="编辑标签"
        onClose={() => setTagModalPaper(null)}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setTagModalPaper(null)}>取消</button>
            <button className="btn btn-primary" onClick={handleSaveTags}>保存</button>
          </>
        }
      >
        <p className={styles.modalHint}>用空格或逗号分隔多个标签</p>
        <input
          className="input"
          placeholder="例如: 机器学习 NLP 综述"
          value={tagDraft}
          autoFocus
          onChange={(e) => setTagDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSaveTags()}
        />
      </Modal>

      {/* 移动文件夹弹窗 */}
      <Modal
        open={!!moveModalPaper}
        title="移动到文件夹"
        onClose={() => setMoveModalPaper(null)}
        footer={
          <button className="btn btn-secondary" onClick={() => setMoveModalPaper(null)}>取消</button>
        }
      >
        <div className={styles.moveList}>
          <button className={styles.moveItem} onClick={() => handleMovePaper('')}>
            📄 未分组
          </button>
          {folders.map((folder) => (
            <button key={folder.id} className={styles.moveItem} onClick={() => handleMovePaper(folder.id)}>
              📁 {folder.name}
            </button>
          ))}
        </div>
      </Modal>

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="删除论文"
        message={`确定要删除「${deleteTarget?.title || '未命名论文'}」吗？文件与翻译记录将一并删除。`}
        confirmText="删除"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
