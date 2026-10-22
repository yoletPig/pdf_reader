import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  chatApi,
  streamChatMessage,
  type ChatMessageItem,
  type ChatSessionItem,
} from '../../api/chat'
import {
  agentRunsApi,
  type AgentStatusFrame,
  type ThoughtStep,
} from '../../api/agent-runs'
import { papersApi, type Paper } from '../../api/papers'
import { notesApi } from '../../api/notes'
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

/** 头部状态栏视图模型（SSE status 帧与 REST 状态接口归一化） */
interface StatusView {
  state: string
  tokens: number
  window: number
  percent: number
  messages: number
}

const STATE_LABELS: Record<string, string> = {
  idle: '空闲',
  thinking: '思考中',
  tool_calling: '调用工具',
  streaming: '生成中',
}

function toStoreMessage(item: ChatMessageItem): ChatMessage {
  return {
    id: item.id,
    role: item.role,
    content: item.content,
    thinking: item.meta?.thinking,
    trace: item.meta?.tool_trace,
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

/** 由首条消息生成会话标题（与后端 _auto_title 规则一致） */
function deriveTitle(question: string, limit = 30) {
  const text = question.replace(/\s+/g, ' ').trim()
  if (!text) return '新对话'
  return text.length > limit ? `${text.slice(0, limit)}…` : text
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
    appendThinking,
    upsertTrace,
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
  const [statusView, setStatusView] = useState<StatusView | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) || null,
    [sessions, activeSessionId],
  )

  /** 刷新上下文用量状态（优先 gateway 实时状态，冷启动时用历史 meta 回退） */
  const refreshStatus = useCallback(
    async (sessionId: string | null, fallbackMessages?: ChatMessage[]) => {
      if (!sessionId) {
        setStatusView(null)
        return
      }
      try {
        const res = await agentRunsApi.getStatus(`chat-${sessionId}`)
        const data = res.data as any
        if (data?.exists) {
          setStatusView({
            state: data.is_streaming ? data.state : 'idle',
            tokens: data.context_tokens || 0,
            window: data.context_window || 0,
            percent: data.context_percent || 0,
            messages: data.message_count || 0,
          })
          return
        }
      } catch {
        /* 静默回退 */
      }
      const msgs = fallbackMessages || []
      const lastMeta = [...msgs].reverse().find((m) => m.meta?.context)?.meta
      if (lastMeta?.context) {
        setStatusView({
          state: 'idle',
          tokens: lastMeta.context.tokens || 0,
          window: lastMeta.context.window || 0,
          percent: lastMeta.context.percent || 0,
          messages: lastMeta.context.messages || 0,
        })
      } else {
        setStatusView(null)
      }
    },
    [],
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
      const mapped = (res.data.messages || []).map(toStoreMessage)
      setMessages(mapped)
      refreshStatus(session.id, mapped)
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
          title: deriveTitle(question),
          paper_id: scopePaperId,
        })
        sessionId = res.data.id
        setActiveSession(sessionId)
        await refreshSessions()
      } catch {
        toast.error('创建对话失败')
        return
      }
    } else {
      // 标题仍为默认占位（新对话）时，首条消息立即更新标题（后端持久化时同样会写入）
      const current = sessions.find((s) => s.id === sessionId)
      if (current && (!current.title || current.title === '新对话')) {
        const title = deriveTitle(question)
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, title } : s)))
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
          if (type === 'thinking_delta') {
            appendThinking(answerId, String(data.content || ''))
          } else if (type === 'event') {
            upsertTrace(answerId, data as ThoughtStep)
          } else if (type === 'status') {
            const s = data as AgentStatusFrame
            setStatusView({
              state: s.state,
              tokens: s.context?.tokens || 0,
              window: s.context?.window || 0,
              percent: s.context?.percent || 0,
              messages: s.context?.messages || 0,
            })
          } else if (type === 'answer_delta') {
            appendToLast(String(data.content || ''))
          } else if (type === 'result') {
            const answer = data.answer || {}
            const summary = answer.trace_summary || {}
            updateMessage(answerId, {
              content: answer.content || '',
              thinking: summary.thinking || undefined,
              trace: summary.tool_trace || undefined,
              sources: answer.sources || [],
              meta: summary,
              streaming: false,
            })
            if (summary.context) {
              setStatusView({
                state: 'idle',
                tokens: summary.context.tokens || 0,
                window: summary.context.window || 0,
                percent: summary.context.percent || 0,
                messages: summary.context.messages || 0,
              })
            }
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

  const handleClearContext = async () => {
    if (!activeSessionId || isStreaming) return
    try {
      await chatApi.clearMessages(activeSessionId)
      await agentRunsApi.resetSession(`chat-${activeSessionId}`).catch(() => {})
      setMessages([])
      setStatusView(null)
      toast.success('已清空上下文与对话历史')
    } catch {
      toast.error('清空失败')
    }
  }

  /* ---------- 保存为笔记 ---------- */

  /** 将单条消息保存为笔记 */
  const handleSaveMessageAsNote = async (msg: ChatMessage) => {
    if (!msg.content.trim()) return
    try {
      const res = await notesApi.create({
        title: deriveTitle(msg.content),
        content_md: msg.content,
        source_type: 'chat',
        source_ref: {
          session_id: activeSessionId || '',
          message_id: msg.id,
          session_title: activeSession?.title || '',
        },
      })
      toast.success('已保存为笔记')
      navigate(`/notes?id=${res.data.id}`)
    } catch {
      toast.error('保存笔记失败')
    }
  }

  /** 将整个会话导出为笔记 */
  const handleExportSessionAsNote = async () => {
    if (!messages.length || isStreaming) return
    const sessionTitle = activeSession?.title || '对话笔记'
    const lines: string[] = [
      `# ${sessionTitle}`,
      '',
      `> 📅 ${new Date().toLocaleDateString('zh-CN')} · 来自 AI 对话`,
      '',
    ]
    for (const m of messages) {
      const content = m.content.trim()
      if (!content) continue
      if (m.role === 'user') {
        lines.push('## 🧑 提问', '', content, '')
      } else {
        lines.push('## ✦ 回答', '', content, '')
      }
    }
    try {
      const res = await notesApi.create({
        title: sessionTitle,
        content_md: lines.join('\n'),
        source_type: 'chat',
        source_ref: {
          session_id: activeSessionId || '',
          session_title: sessionTitle,
        },
      })
      toast.success('已导出为笔记')
      navigate(`/notes?id=${res.data.id}`)
    } catch {
      toast.error('导出笔记失败')
    }
  }

  const handleCopyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('已复制')
    } catch {
      toast.error('复制失败')
    }
  }

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
          <div className={styles.statusArea}>
            {statusView ? (
              <>
                <span className={`${styles.statusPill} ${isStreaming ? styles.statusActive : ''}`}>
                  <span className={styles.statusDot} />
                  {STATE_LABELS[statusView.state] || statusView.state}
                </span>
                <div
                  className={styles.contextBarWrap}
                  title={`上下文用量：约 ${statusView.tokens.toLocaleString()} / ${statusView.window.toLocaleString()} tokens（${statusView.percent}%）· ${statusView.messages} 条消息`}
                >
                  <div className={styles.contextBar}>
                    <div
                      className={`${styles.contextFill} ${statusView.percent > 80 ? styles.contextHigh : ''}`}
                      style={{ width: `${Math.max(2, statusView.percent)}%` }}
                    />
                  </div>
                  <span className={styles.contextLabel}>
                    {statusView.tokens >= 1000
                      ? `${(statusView.tokens / 1000).toFixed(1)}k`
                      : statusView.tokens}
                    /{statusView.window >= 1000 ? `${Math.round(statusView.window / 1000)}k` : statusView.window}
                  </span>
                </div>
              </>
            ) : null}
          </div>
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
            {activeSessionId && !isStreaming && messages.length > 0 ? (
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleExportSessionAsNote}
                title="将当前对话导出为一篇 Markdown 笔记"
              >
                📝 导出为笔记
              </button>
            ) : null}
            {activeSessionId && !isStreaming && messages.length > 0 ? (
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleClearContext}
                title="清空当前对话的上下文与历史"
              >
                清空上下文
              </button>
            ) : null}
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
                      {msg.trace && msg.trace.length > 0 && (
                        <div className={styles.traceList}>
                          {msg.trace.map((t) => (
                            <div
                              key={t.id}
                              className={`${styles.traceItem} ${
                                t.status === 'failed'
                                  ? styles.traceFailed
                                  : t.status === 'running'
                                    ? styles.traceRunning
                                    : ''
                              }`}
                            >
                              <span className={styles.traceIcon}>
                                {t.status === 'running' ? '⏳' : t.status === 'failed' ? '✕' : '✓'}
                              </span>
                              <span className={styles.traceTitle}>{t.title}</span>
                              {t.content ? <span className={styles.traceContent}>{t.content}</span> : null}
                            </div>
                          ))}
                        </div>
                      )}
                      {msg.thinking ? (
                        <details className={styles.thinking} open={!!msg.streaming}>
                          <summary className={styles.thinkingSummary}>
                            🧠 思考过程（{msg.thinking.length.toLocaleString()} 字{msg.streaming ? '，生成中' : ''}）
                          </summary>
                          <pre className={styles.thinkingBody}>{msg.thinking}</pre>
                        </details>
                      ) : null}
                      {msg.content ? (
                        <Markdown compact>{msg.content}</Markdown>
                      ) : msg.streaming ? (
                        msg.thinking ? (
                          <div className={styles.thinkingIndicator}>模型思考中…</div>
                        ) : (
                          <div className={styles.typing}>
                            <span className={styles.dot} />
                            <span className={styles.dot} />
                            <span className={styles.dot} />
                          </div>
                        )
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
                      {msg.meta && !msg.meta.error && (msg.meta.tool_calls || msg.meta.llm_calls || msg.meta.duration_ms) ? (
                        <div className={styles.trace}>
                          {msg.meta.tools_used?.length ? <span>🔧 {msg.meta.tools_used.join(', ')}</span> : null}
                          {msg.meta.llm_calls ? <span>⚡ {msg.meta.llm_calls} 次推理</span> : null}
                          {msg.meta.token_usage?.total_tokens ? <span>🎯 {msg.meta.token_usage.total_tokens} tokens</span> : null}
                          {msg.meta.duration_ms ? <span>⏱ {(msg.meta.duration_ms / 1000).toFixed(1)}s</span> : null}
                          {msg.meta.context?.percent != null ? <span>📚 上下文 {msg.meta.context.percent}%</span> : null}
                        </div>
                      ) : null}
                    </>
                  )}
                  {msg.content && !msg.streaming ? (
                    <div className={styles.msgActions}>
                      <button
                        className={styles.msgAction}
                        title="将此消息保存为笔记"
                        onClick={() => handleSaveMessageAsNote(msg)}
                      >
                        📝 存为笔记
                      </button>
                      <button
                        className={styles.msgAction}
                        title="复制内容"
                        onClick={() => handleCopyText(msg.content)}
                      >
                        复制
                      </button>
                    </div>
                  ) : null}
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
