/**
 * 阅读页内嵌 AI 助手 — 绑定当前论文的 pi agent 对话
 * 历史持久化到后端 chat 会话。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { chatApi, streamChatMessage } from '../../api/chat'
import { useChatStore, type ChatMessage } from '../../stores/chat-store'
import { Markdown } from '../ui/Markdown'
import { useToast } from '../ui/kit'
import styles from './AssistantPanel.module.css'

export interface AssistantPanelProps {
  paperId: string
  paperTitle: string
  /** 外部注入的问题（选中文字「问AI」等） */
  pendingQuestion?: string | null
  onQuestionConsumed?: () => void
  /** 选中原文（作为上下文随问题一起发送） */
  selectedText?: string
  currentPage?: number
}

export function AssistantPanel({
  paperId,
  paperTitle,
  pendingQuestion,
  onQuestionConsumed,
  selectedText,
  currentPage,
}: AssistantPanelProps) {
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
  } = useChatStore()
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  /** 查找或创建绑定当前论文的会话 */
  const ensureSession = useCallback(async () => {
    const list = await chatApi.listSessions()
    const existing = (list.data.sessions || []).find((s) => s.paper_id === paperId)
    if (existing) {
      setActiveSession(existing.id)
      setLoading(true)
      try {
        const res = await chatApi.listMessages(existing.id)
        setMessages(
          (res.data.messages || []).map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            sources: m.sources,
            meta: m.meta,
            createdAt: new Date(m.created_at || Date.now()).getTime(),
          })),
        )
      } finally {
        setLoading(false)
      }
      return existing.id
    }
    const created = await chatApi.createSession({
      title: `${paperTitle.slice(0, 18)}${paperTitle.length > 18 ? '…' : ''}`,
      paper_id: paperId,
    })
    setActiveSession(created.data.id)
    setMessages([])
    return created.data.id
  }, [paperId, paperTitle, setActiveSession, setMessages])

  useEffect(() => {
    ensureSession().catch(() => toast.error('初始化助手会话失败'))
    return () => {
      abortRef.current?.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperId])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const send = useCallback(async (question: string, contextText?: string) => {
    const text = question.trim()
    if (!text || isStreaming) return
    const sessionId = activeSessionId || (await ensureSession())

    addMessage({ id: `u-${Date.now()}`, role: 'user', content: text, createdAt: Date.now() })
    const answerId = `a-${Date.now()}`
    addMessage({ id: answerId, role: 'assistant', content: '', streaming: true, createdAt: Date.now() })
    setStreaming(true)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      await streamChatMessage(
        sessionId,
        {
          question: text,
          paper_id: paperId,
          selected_text: contextText || undefined,
          current_page: currentPage,
        },
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
              content: `⚠️ ${data.detail || '出错了'}`,
              meta: { error: true },
              streaming: false,
            })
          }
        },
        controller.signal,
      )
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        updateMessage(answerId, { content: '⚠️ 连接中断', meta: { error: true }, streaming: false })
      }
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }, [
    activeSessionId, addMessage, appendToLast, currentPage, ensureSession, isStreaming,
    paperId, setMessages, setStreaming, updateMessage,
  ])

  // 处理外部注入的提问
  useEffect(() => {
    if (pendingQuestion) {
      send(pendingQuestion, selectedText)
      onQuestionConsumed?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingQuestion])

  return (
    <div className={styles.container}>
      <div className={styles.messages}>
        {loading ? (
          <div className={styles.loading}><div className="spinner" /></div>
        ) : messages.length === 0 ? (
          <div className={styles.empty}>
            <div className={styles.emptyIcon}>✦</div>
            <p>针对这篇论文向我提问</p>
            <div className={styles.emptyHints}>
              <button onClick={() => send('这篇论文的核心贡献是什么？')}>核心贡献</button>
              <button onClick={() => send('用通俗的语言总结这篇论文的方法')}>方法总结</button>
              <button onClick={() => send('这篇论文有哪些局限性？')}>局限性</button>
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`${styles.msg} ${styles[msg.role]}`}>
              {msg.role === 'user' ? (
                <div className={styles.userBubble}>{msg.content}</div>
              ) : (
                <div className={styles.assistantBubble}>
                  {msg.content ? (
                    <Markdown compact>{msg.content}</Markdown>
                  ) : msg.streaming ? (
                    <span className={styles.typing}>思考中…</span>
                  ) : null}
                  {msg.sources && msg.sources.length > 0 && (
                    <div className={styles.sources}>
                      {msg.sources.map((s, i) => (
                        <span key={i} className={styles.sourceChip}>
                          {s.page ? `p.${s.page}` : '引用'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      <div className={styles.composer}>
        <textarea
          className={styles.input}
          rows={1}
          placeholder="提问当前论文…"
          value={input}
          disabled={isStreaming}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              send(input, selectedText)
              setInput('')
            }
          }}
        />
        {isStreaming ? (
          <button className="btn btn-secondary btn-sm" onClick={() => abortRef.current?.abort()}>停止</button>
        ) : (
          <button
            className="btn btn-primary btn-sm"
            disabled={!input.trim()}
            onClick={() => { send(input, selectedText); setInput('') }}
          >
            发送
          </button>
        )}
      </div>
    </div>
  )
}
