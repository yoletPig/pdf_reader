import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  chatApi,
  streamChatMessage,
  type ChatMessageItem,
  type ChatSessionItem,
} from '../../api/chat'
import { papersApi, type Paper } from '../../api/papers'
import { useChatStore, type ChatMessage } from '../../stores/chat-store'
import { Markdown } from '../../components/ui/Markdown'
import { ConfirmDialog, useToast } from '../../components/ui/kit'
import styles from './ChatPage.module.css'

const SUGGESTIONS = [
  '总结一下我论文库里的研究方向',
  '对比这两篇论文的方法论差异',
  '解释一下深度学习中的注意力机制',
  '帮我列出某篇论文的核心贡献',
]

function toStoreMessage(item: ChatMessageItem): ChatMessage {
  return {
    id: item.id,
    role: item.role,
    content: item.content,
    sources: item.sources,
    meta: item.meta,
    createdAt: new Date(item.created_at || Date.now()).getTime(),
  }
}

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

export default function ChatPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const {
    messages,
    isStreaming,
    activeSessionId,
    setActiveSession,
    setMessages,
    addMessage,
    appendToLast,
    updateMessage,
    setStreaming,
    clear,
  } = useChatStore()

  const [sessions, setSessions] = useState<ChatSessionItem[]>([])
  const [papers, setPapers] = useState<Paper[]>([])
  const [input, setInput] = useState('')
  const [scopePaperId, setScopePaperId] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId],
  )

  /* ---------- 数据加载 ---------- */

  const refreshSessions = useCallback(async () => {
    try {
      const res = await chatApi.listSessions()
      setSessions(res.data.sessions || [])
      return res.data.sessions || []
    } catch {
      return [] as ChatSessionItem[]
    }
  }, [])

  const selectSession = useCallback(async (session: ChatSessionItem) => {
    if (isStreaming) return
    setActiveSession(session.id)
    setScopePaperId(session.paper_id || '')
    setLoadingHistory(true)
    try {
      const res = await chatApi.listMessages(session.id)
      setMessages((res.data.messages || []).map(toStoreMessage))
    } catch {
      setMessages([])
      toast.error('加载对话历史失败')
    } finally {
      setLoadingHistory(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, setActiveSession, setMessages, toast])

  useEffect(() => {
    refreshSessions().then((list) => {
      if (list.length > 0) selectSession(list[0])
    })
    papersApi.list({ page_size: 100 }).then((res) => setPapers(res.data.papers || [])).catch(() => {})
    return () => {
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  /* ---------- 会话操作 ---------- */

  const handleNewSession = async () => {
    if (isStreaming) return
    try {
      const res = await chatApi.createSession({ title: '新对话', paper_id: '' })
      await refreshSessions()
      setActiveSession(res.data.id)
      setScopePaperId('')
      setMessages([])
    } catch {
      toast.error('创建对话失败')
    }
  }

  const handleDeleteSession = async () => {
    if (!deleteTarget) return
    try {
      await chatApi.deleteSession(deleteTarget)
      toast.success('对话已删除')
      const list = await refreshSessions()
      if (deleteTarget === activeSessionId) {
        if (list.length > 0) {
          selectSession(list[0])
        } else {
          clear()
        }
      }
    } catch {
      toast.error('删除失败')
    } finally {
      setDeleteTarget(null)
    }
  }

  const handleRename = async (session: ChatSessionItem) => {
    const title = renameDraft.trim()
    setRenamingId(null)
    if (!title || title === session.title) return
    try {
      await chatApi.updateSession(session.id, { title })
      await refreshSessions()
      toast.success('已重命名')
    } catch {
      toast.error('重命名失败')
    }
  }

  const handleScopeChange = async (paperId: string) => {
    setScopePaperId(paperId)
    if (activeSessionId) {
      try {
        await chatApi.updateSession(activeSessionId, { paper_id: paperId })
        await refreshSessions()
      } catch {
        /* 静默 */
      }
    }
    if (!isStreaming) setMessages([])
  }

  /* ---------- 发送消息 ---------- */

  const handleSend = async (text?: string) => {
    const question = (text ?? input).trim()
    if (!question || isStreaming) return

    let sessionId = activeSessionId
    if (!sessionId) {
      try {
        const res = await chatApi.createSession({
          title: question.slice(0, 24) + (question.length > 24 ? '…' : ''),
          paper_id: scopePaperId,
        })
        sessionId = res.data.id
        setActiveSession(sessionId)
        await refreshSessions()
      } catch {
        toast.error('创建对话失败')
        return
      }
    }

    setInput('')
    addMessage({
      id: `u-${Date.now()}`,
      role: 'user',
      content: question,
      createdAt: Date.now(),
    })
    const answerId = `a-${Date.now()}`
    addMessage({
      id: answerId,
      role: 'assistant',
      content: '',
      streaming: true,
      createdAt: Date.now(),
    })
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamChatMessage(
        sessionId,
        { question, paper_id: scopePaperId || undefined },
        (type, data) => {
          if (type === 'answer_delta') {
            appendToLast(String(data.content || ''))
          } else if (type === 'result') {
            const answer = data.answer || {}
            updateMessage(answerId, {
              content: answer.content || '',
              sources: answer.sources || [],
              meta: answer.trace_summary || {},
              streaming: false,
            })
          } else if (type === 'error') {
            updateMessage(answerId, {
              content: `⚠️ ${data.detail || '出错了，请稍后重试。'}`,
              meta: { error: true },
              streaming: false,
            })
          }
        },
        controller.signal,
      )
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        updateMessage(answerId, {
          content: '⚠️ 连接中断，请稍后重试。',
          meta: { error: true },
          streaming: false,
        })
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
      refreshSessions()
    }
  }

  /* ---------- 渲染 ---------- */

  return (
    <div className={styles.container}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHeader}>
          <button className={styles.backBtn} onClick={() => navigate('/')} title="返回首页">←</button>
          <button className={`btn btn-primary ${styles.newChatBtn}`} onClick={handleNewSession}>
            ✦ 新对话
          </button>
        </div>

        <div className={styles.sessionList}>
          {sessions.length === 0 && (
            <div className={styles.sidebarEmpty}>暂无对话历史</div>
          )}
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`${styles.sessionItem} ${session.id === activeSessionId ? styles.sessionActive : ''}`}
              onClick={() => selectSession(session)}
            >
              {renamingId === session.id ? (
                <input
                  className={styles.renameInput}
                  value={renameDraft}
                  autoFocus
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onBlur={() => handleRename(session)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleRename(session)
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <>
                  <div className={styles.sessionTitle} title={session.title}>
                    {session.paper_id ? '📄 ' : '💬 '}
                    {session.title || '新对话'}
                  </div>
                  <div className={styles.sessionMeta}>
                    <span className={styles.sessionPreview}>{session.last_message || '（空）'}</span>
                    <span className={styles.sessionTime}>{timeAgo(session.updated_at)}</span>
                  </div>
                  <div className={styles.sessionActions}>
                    <button
                      className={styles.sessionAction}
                      title="重命名"
                      onClick={(e) => {
                        e.stopPropagation()
                        setRenamingId(session.id)
                        setRenameDraft(session.title)
                      }}
                    >
                      ✎
                    </button>
                    <button
                      className={`${styles.sessionAction} ${styles.sessionActionDanger}`}
                      title="删除对话"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteTarget(session.id)
                      }}
                    >
                      🗑
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </aside>

      <main className={styles.main}>
        <header className={styles.header}>
          <div className={styles.headerTitle}>{activeSession?.title || '新对话'}</div>
          <div className={styles.headerActions}>
            <select
              className={`select ${styles.scopeSelect}`}
              value={scopePaperId}
              onChange={(e) => handleScopeChange(e.target.value)}
              disabled={isStreaming}
            >
              <option value="">📚 全部论文</option>
              {papers.map((p) => (
                <option key={p.id} value={p.id}>{p.title}</option>
              ))}
            </select>
            {isStreaming && (
              <button className="btn btn-secondary btn-sm" onClick={() => abortRef.current?.abort()}>
                停止生成
              </button>
            )}
          </div>
        </header>

        <div className={styles.messages}>
          {loadingHistory ? (
            <div className={styles.loadingWrap}>
              <div className="spinner" />
              <span>加载对话历史…</span>
            </div>
          ) : messages.length === 0 ? (
            <div className={styles.welcome}>
              <div className={styles.welcomeIcon}>✦</div>
              <h2>论文阅读助手</h2>
              <p>我可以帮你阅读、对比、总结论文库中的文献</p>
              <div className={styles.suggestions}>
                {SUGGESTIONS.map((s) => (
                  <button key={s} className={styles.suggestionCard} onClick={() => handleSend(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={`${styles.messageRow} ${styles[msg.role]}`}>
                {msg.role === 'assistant' && <div className={styles.avatarAssistant}>✦</div>}
                <div className={styles.messageBubble}>
                  {msg.role === 'user' ? (
                    <div className={styles.userText}>{msg.content}</div>
                  ) : (
                    <>
                      {msg.content ? (
                        <Markdown compact>{msg.content}</Markdown>
                      ) : msg.streaming ? (
                        <div className={styles.typing}>
                          <span className={styles.dot} />
                          <span className={styles.dot} />
                          <span className={styles.dot} />
                        </div>
                      ) : null}
                      {msg.sources && msg.sources.length > 0 && (
                        <div className={styles.sources}>
                          {msg.sources.map((s, i) => (
                            <button
                              key={i}
                              className={styles.sourceChip}
                              onClick={() => s.paper_id && navigate(`/reader/${s.paper_id}`)}
                              title={s.chunk_text || ''}
                            >
                              📄 {s.paper_title || '论文'} {s.page ? `p.${s.page}` : ''}
                            </button>
                          ))}
                        </div>
                      )}
                      {msg.meta && !msg.meta.error && (msg.meta.tool_calls || msg.meta.llm_calls) ? (
                        <div className={styles.trace}>
                          {msg.meta.tools_used?.length ? <span>🔧 {msg.meta.tools_used.join(', ')}</span> : null}
                          {msg.meta.llm_calls ? <span>⚡ {msg.meta.llm_calls} 次推理</span> : null}
                          {msg.meta.token_usage?.total_tokens ? <span>🎯 {msg.meta.token_usage.total_tokens} tokens</span> : null}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
              </div>
            ))
          )}
          <div ref={messagesEndRef} />
        </div>

        <footer className={styles.composer}>
          <div className={styles.composerInner}>
            <textarea
              className={styles.composerInput}
              value={input}
              placeholder={scopePaperId ? '针对当前论文提问…' : '向我提问任何论文相关的问题…'}
              rows={1}
              disabled={isStreaming}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  handleSend()
                }
              }}
            />
            <button
              className={`btn btn-primary ${styles.sendBtn}`}
              onClick={() => handleSend()}
              disabled={isStreaming || !input.trim()}
            >
              发送
            </button>
          </div>
          <div className={styles.composerHint}>Enter 发送 · Shift+Enter 换行</div>
        </footer>
      </main>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除对话"
        message="删除后对话历史将无法恢复，确定要删除吗？"
        confirmText="删除"
        danger
        onConfirm={handleDeleteSession}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
