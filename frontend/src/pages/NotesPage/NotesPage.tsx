import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { notesApi, type NoteDetail, type NoteSummary } from '../../api/notes'
import { MarkdownEditor } from '../../components/notes/MarkdownEditor'
import { NOTE_TEMPLATES, renderTemplate, type NoteTemplate } from '../../components/notes/templates'
import { ConfirmDialog, Modal, useToast } from '../../components/ui/kit'
import styles from './NotesPage.module.css'

type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

function timeAgo(iso: string) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  return days < 30 ? `${days} 天前` : new Date(iso).toLocaleDateString()
}

export default function NotesPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()

  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [tags, setTags] = useState<{ name: string; count: number }[]>([])
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState('')
  const [loading, setLoading] = useState(true)

  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get('id'))
  const [note, setNote] = useState<NoteDetail | null>(null)
  const [titleDraft, setTitleDraft] = useState('')
  const [contentDraft, setContentDraft] = useState('')
  const [tagsDraft, setTagsDraft] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('saved')

  const [templateOpen, setTemplateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<NoteSummary | null>(null)
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  const fetchNotes = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const res = await notesApi.list({ q: query, tag: activeTag })
      setNotes(res.data.notes)
      setTags(res.data.tags)
    } catch {
      toast.error('加载笔记失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, activeTag])

  useEffect(() => {
    const timer = setTimeout(() => fetchNotes(), query ? 250 : 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, activeTag])

  /** 载入某篇笔记到编辑器 */
  const loadNote = useCallback(async (id: string) => {
    try {
      const res = await notesApi.get(id)
      const data = res.data
      setNote(data)
      setTitleDraft(data.title)
      setContentDraft(data.content_md)
      setTagsDraft(data.tags)
      setDirty(false)
      setSaveState('saved')
      setSelectedId(id)
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev)
        next.set('id', id)
        return next
      }, { replace: true })
    } catch {
      toast.error('加载笔记失败')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 从 URL 参数 ?id= 进入时自动载入对应笔记 */
  useEffect(() => {
    const id = searchParams.get('id')
    if (id) void loadNote(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 立即保存当前编辑内容 */
  const saveNow = useCallback(async (): Promise<boolean> => {
    if (!selectedId) return true
    setSaveState('saving')
    try {
      await notesApi.update(selectedId, {
        title: titleDraft.trim(),
        content_md: contentDraft,
        tags: tagsDraft,
      })
      setDirty(false)
      setSaveState('saved')
      void fetchNotes(true)
      return true
    } catch {
      setSaveState('error')
      toast.error('保存失败')
      return false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, titleDraft, contentDraft, tagsDraft])

  /** 防抖自动保存 */
  useEffect(() => {
    if (!selectedId || !dirty) return
    setSaveState('dirty')
    const timer = setTimeout(() => {
      void saveNow()
    }, 800)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [titleDraft, contentDraft, tagsDraft, selectedId, dirty])

  /** 切换笔记：先落盘再载入 */
  const selectNote = async (id: string) => {
    if (id === selectedId) return
    if (dirtyRef.current) await saveNow()
    await loadNote(id)
  }

  /** 新建笔记（使用模板） */
  const handleCreateFromTemplate = async (template: NoteTemplate) => {
    setTemplateOpen(false)
    try {
      const res = await notesApi.create({
        title: template.id === 'blank' ? '未命名笔记' : renderTemplate(template).split('\n')[0].replace(/^#\s*/, '') || '未命名笔记',
        content_md: renderTemplate(template),
        template_id: template.id,
      })
      toast.success('已创建笔记')
      await fetchNotes()
      await loadNote(res.data.id)
    } catch {
      toast.error('创建失败')
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await notesApi.delete(deleteTarget.id)
      setDeleteTarget(null)
      toast.success('笔记已删除')
      if (deleteTarget.id === selectedId) {
        setSelectedId(null)
        setNote(null)
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev)
          next.delete('id')
          return next
        }, { replace: true })
      }
      await fetchNotes()
    } catch {
      toast.error('删除失败')
    }
  }

  const togglePin = async () => {
    if (!note) return
    const pinned = !note.pinned
    setNote({ ...note, pinned })
    try {
      await notesApi.update(note.id, { pinned })
      await fetchNotes(true)
    } catch {
      toast.error('置顶失败')
    }
  }

  /* ---------- 标签编辑 ---------- */

  const commitTag = (raw: string) => {
    const t = raw.trim().replace(/^#/, '')
    if (!t) return
    if (!tagsDraft.includes(t)) setTagsDraft([...tagsDraft, t])
    setTagInput('')
    setDirty(true)
  }

  /* ---------- 渲染 ---------- */

  return (
    <div className={styles.container}>
      {/* ======== 侧栏：笔记列表 ======== */}
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')} title="返回首页">←</button>
          <button className={`btn btn-primary ${styles.newBtn}`} onClick={() => setTemplateOpen(true)}>
            ＋ 新建笔记
          </button>
        </div>

        <input
          className={`input ${styles.searchInput}`}
          value={query}
          placeholder="搜索笔记…"
          onChange={(e) => setQuery(e.target.value)}
        />

        {tags.length > 0 && (
          <div className={styles.tagFilter}>
            <button
              className={`${styles.tagChip} ${!activeTag ? styles.tagChipActive : ''}`}
              onClick={() => setActiveTag('')}
            >
              全部
            </button>
            {tags.map((t) => (
              <button
                key={t.name}
                className={`${styles.tagChip} ${activeTag === t.name ? styles.tagChipActive : ''}`}
                onClick={() => setActiveTag(activeTag === t.name ? '' : t.name)}
              >
                #{t.name} <span className={styles.tagCount}>{t.count}</span>
              </button>
            ))}
          </div>
        )}

        <div className={styles.noteList}>
          {loading ? (
            <div className={styles.listEmpty}><div className="spinner" />加载中…</div>
          ) : notes.length === 0 ? (
            <div className={styles.listEmpty}>暂无笔记，点击「新建笔记」开始</div>
          ) : (
            notes.map((item) => (
              <div
                key={item.id}
                className={`${styles.noteItem} ${item.id === selectedId ? styles.noteItemActive : ''}`}
                onClick={() => selectNote(item.id)}
              >
                <div className={styles.noteItemTitle}>
                  {item.pinned ? '📌 ' : ''}
                  {item.title || '未命名笔记'}
                </div>
                <div className={styles.noteItemSnippet}>{item.snippet || '（空笔记）'}</div>
                <div className={styles.noteItemMeta}>
                  <span>{timeAgo(item.updated_at)}</span>
                  {item.source_type === 'chat' ? <span title="来自 AI 对话">💬</span> : null}
                  {item.tags.slice(0, 3).map((t) => (
                    <span key={t} className={styles.noteItemTag}>#{t}</span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* ======== 主区：编辑器 ======== */}
      <main className={styles.main}>
        {!note ? (
          <div className={styles.emptyState}>
            <div className={styles.emptyIcon}>📝</div>
            <h2>选择或创建一篇笔记</h2>
            <p>支持 Markdown 编辑、实时预览、图片粘贴上传，还可以从 AI 对话一键生成笔记</p>
            <button className="btn btn-primary" onClick={() => setTemplateOpen(true)}>
              ＋ 新建笔记
            </button>
          </div>
        ) : (
          <>
            <header className={styles.editorHeader}>
              <input
                className={styles.titleInput}
                value={titleDraft}
                placeholder="笔记标题…"
                onChange={(e) => { setTitleDraft(e.target.value); setDirty(true) }}
              />
              <div className={styles.editorActions}>
                <span className={`${styles.saveState} ${styles[`save_${saveState}`]}`}>
                  {saveState === 'saving' ? '保存中…' : saveState === 'dirty' ? '待保存' : saveState === 'error' ? '保存失败' : '✓ 已保存'}
                </span>
                <button
                  className={`btn btn-ghost btn-sm ${note.pinned ? styles.pinnedBtn : ''}`}
                  onClick={togglePin}
                  title={note.pinned ? '取消置顶' : '置顶'}
                >
                  📌 {note.pinned ? '已置顶' : '置顶'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => saveNow()}>保存</button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setDeleteTarget(note)}
                  title="删除笔记"
                >
                  🗑 删除
                </button>
              </div>
            </header>

            {note.source_type === 'chat' && (note.source_ref?.session_title || note.source_ref?.session_id) ? (
              <div className={styles.sourceBanner}>
                💬 来自 AI 对话{note.source_ref.session_title ? `：${note.source_ref.session_title}` : ''}
                <button className={styles.sourceLink} onClick={() => navigate('/chat')}>查看对话 →</button>
              </div>
            ) : null}

            <div className={styles.tagsRow}>
              {tagsDraft.map((t) => (
                <span key={t} className={styles.tagEditChip}>
                  #{t}
                  <button
                    className={styles.tagRemove}
                    title="移除标签"
                    onClick={() => { setTagsDraft(tagsDraft.filter((x) => x !== t)); setDirty(true) }}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                className={styles.tagInput}
                value={tagInput}
                placeholder="+ 标签（Enter 添加）"
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitTag(tagInput)
                  }
                  if (e.key === 'Backspace' && !tagInput && tagsDraft.length > 0) {
                    setTagsDraft(tagsDraft.slice(0, -1))
                    setDirty(true)
                  }
                }}
                onBlur={() => commitTag(tagInput)}
              />
            </div>

            <MarkdownEditor
              value={contentDraft}
              onChange={(v) => { setContentDraft(v); setDirty(true) }}
              placeholder="开始记录…（Markdown 语法，可粘贴/拖拽图片上传）"
            />
          </>
        )}
      </main>

      {/* 模板选择弹窗 */}
      <Modal open={templateOpen} title="选择笔记模板" onClose={() => setTemplateOpen(false)} width={520}>
        <div className={styles.templateGrid}>
          {NOTE_TEMPLATES.map((t) => (
            <button key={t.id} className={styles.templateCard} onClick={() => handleCreateFromTemplate(t)}>
              <span className={styles.templateIcon}>{t.icon}</span>
              <span className={styles.templateName}>{t.name}</span>
              <span className={styles.templateDesc}>{t.description}</span>
            </button>
          ))}
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除笔记"
        message={`确定删除「${deleteTarget?.title || '未命名笔记'}」吗？删除后无法恢复。`}
        confirmText="删除"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
