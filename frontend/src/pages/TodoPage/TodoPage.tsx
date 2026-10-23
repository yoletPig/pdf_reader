import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { todosApi, type TodoItem, type TodoListInfo, type TodoPriority } from '../../api/todos'
import { TodoRow, todayStr } from '../../components/todo/TodoRow'
import { TodoLogo } from '../../components/todo/TodoLogo'
import { CalendarView } from '../../components/todo/CalendarView'
import { ConfirmDialog, Modal, Segmented, useToast } from '../../components/ui/kit'
import { InboxBell } from '../../components/ui/InboxBell'
import styles from './TodoPage.module.css'

type FilterKey = 'all' | 'pending' | 'done'
type ViewMode = 'list' | 'calendar'
type ListFilter = 'all' | 'inbox' | string // string = 具体列表 id

const FILTER_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'pending', label: '待办' },
  { value: 'done', label: '已完成' },
] as const

const VIEW_OPTIONS = [
  { value: 'list', label: '📋 列表' },
  { value: 'calendar', label: '📅 日历' },
] as const

const PRIORITY_OPTIONS = [
  { value: 'low', label: '低优先级' },
  { value: 'medium', label: '中优先级' },
  { value: 'high', label: '高优先级' },
]

const LIST_ICONS = ['📋', '📄', '📚', '🔬', '✍️', '🎯', '💡', '🏠', '🛒', '🎓']

interface Bucket {
  key: string
  label: string
  items: TodoItem[]
}

export default function TodoPage() {
  const navigate = useNavigate()
  const toast = useToast()

  const [todos, setTodos] = useState<TodoItem[]>([])
  const [lists, setLists] = useState<TodoListInfo[]>([])
  const [inboxCounts, setInboxCounts] = useState({ pending_count: 0, done_count: 0 })
  const [listFilter, setListFilter] = useState<ListFilter>('all')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)

  // 快速添加
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState<TodoPriority>('medium')
  const [dueDate, setDueDate] = useState('')
  const [adding, setAdding] = useState(false)

  // 待办编辑弹窗
  const [editing, setEditing] = useState<TodoItem | null>(null)
  const [draft, setDraft] = useState({ title: '', description: '', priority: 'medium' as TodoPriority, due_date: '' })
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<TodoItem | null>(null)

  // 列表管理弹窗
  const [listModal, setListModal] = useState<{ open: boolean; editing?: TodoListInfo }>({ open: false })
  const [listDraft, setListDraft] = useState({ name: '', icon: '📋', color: '' })
  const [deleteListTarget, setDeleteListTarget] = useState<TodoListInfo | null>(null)

  /* ---------- 数据加载 ---------- */

  const fetchLists = useCallback(async () => {
    try {
      const res = await todosApi.listLists()
      setLists(res.data.lists)
      setInboxCounts(res.data.inbox)
    } catch {
      /* 静默 */
    }
  }, [])

  const fetchTodos = useCallback(async () => {
    try {
      const res = await todosApi.list({
        q: query,
        list_id: listFilter === 'all' ? undefined : listFilter,
      })
      setTodos(res.data.todos)
    } catch {
      toast.error('加载待办失败')
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFilter, query])

  useEffect(() => {
    void fetchLists()
  }, [fetchLists])

  useEffect(() => {
    const timer = setTimeout(() => fetchTodos(), query ? 250 : 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFilter, query])

  /* ---------- 待办操作 ---------- */

  /** 当前列表上下文（新建待办时归属） */
  const currentListId = listFilter === 'all' || listFilter === 'inbox' ? '' : listFilter

  const handleAdd = async (overrideTitle?: string, overrideDate?: string) => {
    const t = (overrideTitle ?? title).trim()
    if (!t || adding) return
    setAdding(true)
    try {
      await todosApi.create({
        title: t,
        priority,
        due_date: overrideDate ?? dueDate,
        list_id: currentListId,
      })
      if (!overrideTitle) {
        setTitle('')
        setDueDate('')
      }
      toast.success('已添加待办')
      await Promise.all([fetchTodos(), fetchLists()])
    } catch {
      toast.error('添加失败')
    } finally {
      setAdding(false)
    }
  }

  const toggleTodo = async (todo: TodoItem) => {
    const next = todo.status === 'done' ? 'pending' : 'done'
    setTodos((prev) => prev.map((t) => (t.id === todo.id ? { ...t, status: next } : t)))
    try {
      await todosApi.update(todo.id, { status: next })
      await Promise.all([fetchTodos(), fetchLists()])
    } catch {
      toast.error('更新失败')
      await fetchTodos()
    }
  }

  const openEdit = (todo: TodoItem) => {
    setEditing(todo)
    setDraft({
      title: todo.title,
      description: todo.description,
      priority: todo.priority,
      due_date: todo.due_date,
    })
  }

  const handleSave = async () => {
    if (!editing) return
    if (!draft.title.trim()) {
      toast.error('标题不能为空')
      return
    }
    setSaving(true)
    try {
      await todosApi.update(editing.id, {
        title: draft.title.trim(),
        description: draft.description,
        priority: draft.priority,
        due_date: draft.due_date,
      })
      setEditing(null)
      toast.success('已保存')
      await Promise.all([fetchTodos(), fetchLists()])
    } catch {
      toast.error('保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await todosApi.delete(deleteTarget.id)
      setDeleteTarget(null)
      toast.success('已删除')
      await Promise.all([fetchTodos(), fetchLists()])
    } catch {
      toast.error('删除失败')
    }
  }

  /* ---------- 列表管理 ---------- */

  const openListModal = (editingList?: TodoListInfo) => {
    setListModal({ open: true, editing: editingList })
    setListDraft(
      editingList
        ? { name: editingList.name, icon: editingList.icon, color: editingList.color }
        : { name: '', icon: '📋', color: '' },
    )
  }

  const handleSaveList = async () => {
    const name = listDraft.name.trim()
    if (!name) {
      toast.error('列表名不能为空')
      return
    }
    try {
      if (listModal.editing) {
        await todosApi.updateList(listModal.editing.id, listDraft)
        toast.success('列表已更新')
      } else {
        await todosApi.createList(listDraft)
        toast.success('列表已创建')
      }
      setListModal({ open: false })
      await Promise.all([fetchLists(), fetchTodos()])
    } catch {
      toast.error('操作失败')
    }
  }

  const handleDeleteList = async () => {
    if (!deleteListTarget) return
    try {
      await todosApi.deleteList(deleteListTarget.id)
      if (listFilter === deleteListTarget.id) setListFilter('all')
      setDeleteListTarget(null)
      toast.success('列表已删除，待办已移回收件箱')
      await Promise.all([fetchLists(), fetchTodos()])
    } catch {
      toast.error('删除失败')
    }
  }

  /* ---------- 派生数据 ---------- */

  const visibleTodos = useMemo(
    () => (filter === 'all' ? todos : todos.filter((t) => t.status === filter)),
    [todos, filter],
  )

  /** 按截止日期分组：已逾期 / 今天 / 未来 / 无期限 */
  const buckets = useMemo<Bucket[]>(() => {
    const today = todayStr()
    const overdue: TodoItem[] = []
    const todayList: TodoItem[] = []
    const upcoming: TodoItem[] = []
    const someday: TodoItem[] = []
    for (const todo of visibleTodos) {
      if (todo.status === 'done') continue
      if (!todo.due_date) someday.push(todo)
      else if (todo.due_date < today) overdue.push(todo)
      else if (todo.due_date === today) todayList.push(todo)
      else upcoming.push(todo)
    }
    return [
      { key: 'overdue', label: '已逾期', items: overdue },
      { key: 'today', label: '今天', items: todayList },
      { key: 'upcoming', label: '未来', items: upcoming },
      { key: 'someday', label: '无期限', items: someday },
    ].filter((b) => b.items.length > 0)
  }, [visibleTodos])

  const doneList = useMemo(() => visibleTodos.filter((t) => t.status === 'done'), [visibleTodos])

  const listTitle =
    listFilter === 'all'
      ? '全部待办'
      : listFilter === 'inbox'
        ? '📥 收件箱'
        : lists.find((l) => l.id === listFilter)?.name || '待办'

  const pendingTotal = todos.filter((t) => t.status === 'pending').length

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('/')}>← 返回</button>
        <h1 className={styles.title}>
          <TodoLogo size={22} />
          待办事项
        </h1>
        <div className={styles.headerStats}>
          <span className={styles.stat}>待办 {pendingTotal}</span>
          <span className={styles.stat}>已完成 {todos.length - pendingTotal}</span>
        </div>
        <InboxBell />
      </header>

      <div className={styles.body}>
        {/* ======== 侧栏：待办列表 ======== */}
        <aside className={styles.sidebar}>
          <button
            className={`${styles.listItem} ${listFilter === 'all' ? styles.listActive : ''}`}
            onClick={() => setListFilter('all')}
          >
            <span className={styles.listIcon}>🗂</span>
            <span className={styles.listName}>全部待办</span>
          </button>
          <button
            className={`${styles.listItem} ${listFilter === 'inbox' ? styles.listActive : ''}`}
            onClick={() => setListFilter('inbox')}
          >
            <span className={styles.listIcon}>📥</span>
            <span className={styles.listName}>收件箱</span>
            {inboxCounts.pending_count > 0 && (
              <span className={styles.listCount}>{inboxCounts.pending_count}</span>
            )}
          </button>

          <div className={styles.sectionHeader}>
            <span>我的列表</span>
            <button className={styles.sectionAction} title="新建列表" onClick={() => openListModal()}>＋</button>
          </div>

          {lists.length === 0 ? (
            <div className={styles.sidebarEmpty}>暂无自定义列表，点 ＋ 创建</div>
          ) : (
            lists.map((list) => (
              <div
                key={list.id}
                className={`${styles.listItem} ${listFilter === list.id ? styles.listActive : ''}`}
                onClick={() => setListFilter(list.id)}
              >
                <span className={styles.listIcon}>{list.icon}</span>
                <span className={styles.listName}>{list.name}</span>
                {list.pending_count > 0 && <span className={styles.listCount}>{list.pending_count}</span>}
                <div className={styles.listActions}>
                  <button
                    className={styles.listAction}
                    title="编辑列表"
                    onClick={(e) => { e.stopPropagation(); openListModal(list) }}
                  >
                    ✎
                  </button>
                  <button
                    className={`${styles.listAction} ${styles.listActionDanger}`}
                    title="删除列表"
                    onClick={(e) => { e.stopPropagation(); setDeleteListTarget(list) }}
                  >
                    🗑
                  </button>
                </div>
              </div>
            ))
          )}
        </aside>

        {/* ======== 主区 ======== */}
        <main className={styles.main}>
          <div className={styles.mainHead}>
            <h2 className={styles.mainTitle}>
              {listTitle}
              <span className={styles.mainCount}>{todos.length}</span>
            </h2>
            <Segmented options={[...VIEW_OPTIONS]} value={viewMode} onChange={setViewMode} size="sm" />
          </div>

          {/* 快速添加 */}
          <div className={styles.addBar}>
            <input
              className={`input ${styles.addInput}`}
              value={title}
              placeholder={`添加到「${listTitle}」，Enter 确认…`}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAdd()
              }}
            />
            <select
              className={`select ${styles.addPriority}`}
              value={priority}
              onChange={(e) => setPriority(e.target.value as TodoPriority)}
            >
              {PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <input
              type="date"
              className={`input ${styles.addDate}`}
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
            <button className="btn btn-primary" onClick={() => handleAdd()} disabled={adding || !title.trim()}>
              添加
            </button>
          </div>

          {viewMode === 'list' ? (
            <>
              {/* 过滤 */}
              <div className={styles.filterBar}>
                <Segmented options={[...FILTER_OPTIONS]} value={filter} onChange={setFilter} size="sm" />
                <input
                  className={`input ${styles.searchInput}`}
                  value={query}
                  placeholder="搜索待办…"
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>

              {loading ? (
                <div className={styles.empty}><div className="spinner" />加载中…</div>
              ) : (
                <>
                  {filter !== 'done' && buckets.map((bucket) => (
                    <section key={bucket.key} className={styles.bucket}>
                      <h3 className={`${styles.bucketLabel} ${bucket.key === 'overdue' ? styles.bucketOverdue : ''}`}>
                        {bucket.label}
                        <span className={styles.bucketCount}>{bucket.items.length}</span>
                      </h3>
                      <div className={styles.todoList}>
                        {bucket.items.map((todo) => (
                          <TodoRow
                            key={todo.id}
                            todo={todo}
                            onToggle={toggleTodo}
                            onEdit={openEdit}
                            onDelete={setDeleteTarget}
                          />
                        ))}
                      </div>
                    </section>
                  ))}

                  {(filter === 'done' || doneList.length > 0) && (
                    <section className={styles.bucket}>
                      <h3 className={styles.bucketLabel}>
                        已完成
                        <span className={styles.bucketCount}>{doneList.length}</span>
                      </h3>
                      <div className={styles.todoList}>
                        {doneList.length === 0 ? (
                          <div className={styles.emptySmall}>暂无已完成事项</div>
                        ) : (
                          doneList.map((todo) => (
                            <TodoRow
                              key={todo.id}
                              todo={todo}
                              onToggle={toggleTodo}
                              onEdit={openEdit}
                              onDelete={setDeleteTarget}
                            />
                          ))
                        )}
                      </div>
                    </section>
                  )}

                  {visibleTodos.length === 0 && (
                    <div className={styles.empty}>
                      <div className={styles.emptyIcon}>🎉</div>
                      <p>{query || filter !== 'all' ? '没有匹配的待办事项' : '暂无待办，享受轻松一刻～'}</p>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <CalendarView
              todos={todos}
              onToggle={toggleTodo}
              onEdit={openEdit}
              onDelete={setDeleteTarget}
              onQuickAdd={(t, date) => handleAdd(t, date)}
            />
          )}
        </main>
      </div>

      {/* 待办编辑弹窗 */}
      <Modal
        open={!!editing}
        title="编辑待办"
        onClose={() => setEditing(null)}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>标题</label>
          <input
            className="input"
            value={draft.title}
            autoFocus
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>描述</label>
          <textarea
            className={`input ${styles.formTextarea}`}
            rows={4}
            value={draft.description}
            placeholder="补充说明（可选）…"
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </div>
        <div className={styles.formRow}>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>优先级</label>
            <select
              className="select"
              value={draft.priority}
              onChange={(e) => setDraft({ ...draft, priority: e.target.value as TodoPriority })}
            >
              {PRIORITY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
          <div className={styles.formGroup}>
            <label className={styles.formLabel}>截止日期</label>
            <input
              type="date"
              className="input"
              value={draft.due_date}
              onChange={(e) => setDraft({ ...draft, due_date: e.target.value })}
            />
          </div>
        </div>
      </Modal>

      {/* 列表编辑弹窗 */}
      <Modal
        open={listModal.open}
        title={listModal.editing ? '编辑列表' : '新建列表'}
        onClose={() => setListModal({ open: false })}
        footer={
          <>
            <button className="btn btn-ghost" onClick={() => setListModal({ open: false })}>取消</button>
            <button className="btn btn-primary" onClick={handleSaveList}>
              {listModal.editing ? '保存' : '创建'}
            </button>
          </>
        }
      >
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>列表名</label>
          <input
            className="input"
            value={listDraft.name}
            autoFocus
            placeholder="如：论文任务、生活、购物…"
            onChange={(e) => setListDraft({ ...listDraft, name: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSaveList()
            }}
          />
        </div>
        <div className={styles.formGroup}>
          <label className={styles.formLabel}>图标</label>
          <div className={styles.iconGrid}>
            {LIST_ICONS.map((icon) => (
              <button
                key={icon}
                className={`${styles.iconBtn} ${listDraft.icon === icon ? styles.iconBtnActive : ''}`}
                onClick={() => setListDraft({ ...listDraft, icon })}
              >
                {icon}
              </button>
            ))}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除待办"
        message={`确定删除「${deleteTarget?.title || ''}」吗？`}
        confirmText="删除"
        danger
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={!!deleteListTarget}
        title="删除列表"
        message={`删除「${deleteListTarget?.name || ''}」后，其中的待办会移回收件箱。确定删除吗？`}
        confirmText="删除"
        danger
        onConfirm={handleDeleteList}
        onCancel={() => setDeleteListTarget(null)}
      />
    </div>
  )
}
