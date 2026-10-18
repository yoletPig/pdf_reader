import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '../../stores/chat-store'
import { ExecutionMetadata, ThoughtStep, streamPaperQA, agentRunsApi } from '../../api/agent-runs'
import { papersApi, Paper } from '../../api/papers'
import styles from './ChatPage.module.css'

function createQaSessionId(scope: string) {
  return `qa:${scope}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

function getQaSessionKey(scope: string) {
  return `pdf-reader:${scope}:qa-session`
}

function ThinkingTimeline({ steps }: { steps: ThoughtStep[] }) {
  return (
    <div className={styles.thinkingList}>
      {steps.map((step) => (
        <div key={step.id} className={`${styles.thinkingStep} ${styles[step.status]}`}>
          <span className={styles.thinkingMarker} aria-hidden="true" />
          <div>
            <div className={styles.thinkingTitle}>{step.title}</div>
            <p className={styles.thinkingContent}>{step.content}</p>
          </div>
        </div>
      ))}
    </div>
  )
}

export default function ChatPage() {
  const [input, setInput] = useState('')
  const [papers, setPapers] = useState<Paper[]>([])
  const [selectedPaperId, setSelectedPaperId] = useState('')
  const [qaSessionId, setQaSessionId] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const { messages, isStreaming, addMessage, appendToLast, updateMessage, setStreaming, clearMessages } = useChatStore()
  const scopeLabel = useMemo(() => selectedPaperId ? '单论文' : '跨论文', [selectedPaperId])

  useEffect(() => {
    papersApi.list().then(res => setPapers(res.data.papers || [])).catch(console.error)
  }, [])

  useEffect(() => {
    const scope = selectedPaperId || 'all-papers'
    const sessionKey = getQaSessionKey(scope)
    const storedSessionId = window.sessionStorage.getItem(sessionKey) || createQaSessionId(scope)
    window.sessionStorage.setItem(sessionKey, storedSessionId)
    setQaSessionId(storedSessionId)
  }, [selectedPaperId])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [messages])

  const handleSend = async () => {
    if (!input.trim() || isStreaming || !qaSessionId) return
    const userMsg = { id: Date.now().toString(), role: 'user' as const, content: input, timestamp: Date.now() }
    addMessage(userMsg)
    setInput('')
    setStreaming(true)
    const thinkingMessageId = `${userMsg.id}:thinking`
    const answerMessageId = `${userMsg.id}:answer`
    let thinkingStarted = false
    let answerStarted = false
    let activeRunId = ''
    let events: ThoughtStep[] = []
    let streamedContent = ''
    let execution: ExecutionMetadata = {
      mode: 'retrieval',
      trace_visibility: 'compact',
      reason: '',
    }

    try {
      await streamPaperQA({
        input: {
          question: userMsg.content,
          paper_id: selectedPaperId || undefined,
        },
        context: {
          paper_id: selectedPaperId || undefined,
          session_id: qaSessionId,
        },
      }, (item) => {
        if (item.type === 'run_created') {
          activeRunId = item.data.run_id
          execution = item.data.execution
          if (item.data.thought) {
            thinkingStarted = true
            events = [item.data.thought]
            addMessage({
              id: thinkingMessageId,
              role: 'assistant',
              kind: 'thinking',
              execution,
              runId: activeRunId,
              content: '',
              events,
              timestamp: Date.now(),
            })
          }
          return
        }
        if (item.type === 'answer_delta') {
          const delta = item.data.content
          streamedContent += delta
          if (!answerStarted) {
            answerStarted = true
            addMessage({
              id: answerMessageId,
              role: 'assistant',
              kind: 'answer',
              execution,
              content: '',
              timestamp: Date.now(),
            })
          }
          appendToLast(delta)
          return
        }
        if (item.type === 'event') {
          if (!thinkingStarted) return
          events = [...events, item.data]
          updateMessage(thinkingMessageId, { events })
          return
        }
        if (item.type === 'result') {
          execution = item.data.execution || execution
          const answerUpdate = {
            content: item.data.answer.content || streamedContent || '抱歉，无法回答这个问题。',
            sources: item.data.answer.sources || [],
            traceSummary: item.data.answer.trace_summary,
            execution,
          }
          if (answerStarted) {
            updateMessage(answerMessageId, answerUpdate)
          } else {
            answerStarted = true
            addMessage({
              id: answerMessageId,
              role: 'assistant',
              kind: 'answer',
              ...answerUpdate,
              timestamp: Date.now(),
            })
          }
          return
        }
        if (item.type === 'error') {
          const errorContent = `出错了：${item.data.detail || '请稍后再试。'}`
          if (answerStarted) {
            updateMessage(answerMessageId, { content: errorContent })
          } else {
            answerStarted = true
            addMessage({
              id: answerMessageId,
              role: 'assistant',
              kind: 'answer',
              execution,
              content: errorContent,
              timestamp: Date.now(),
            })
          }
        }
      })
    } catch (err) {
      console.error(err)
      if (thinkingStarted) {
        if (answerStarted) {
          updateMessage(answerMessageId, { content: '出错了，请稍后再试。' })
        } else {
          addMessage({
            id: answerMessageId,
            role: 'assistant',
            kind: 'answer',
            execution,
            content: '出错了，请稍后再试。',
            timestamp: Date.now(),
          })
        }
      } else {
        addMessage({
          id: answerMessageId,
          role: 'assistant',
            kind: 'answer',
            execution,
          content: '出错了，请稍后再试。',
          timestamp: Date.now(),
        })
      }
    } finally {
      setStreaming(false)
    }
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <a href="/" className={styles.back}>← 返回</a>
        <h1>💬 跨论文问答</h1>
        <span className={styles.scopeBadge}>{scopeLabel}</span>
      </header>

      <main className={styles.messages}>
        {messages.length === 0 && (
          <div className={styles.empty}>
            <p>🤖 向我提问任何关于你已导入论文的问题</p>
            <p className={styles.hint}>支持跨论文对比、概念解释、方法论分析等</p>
          </div>
        )}
        {messages.map(msg => {
          const messageContent = msg.content || (msg.kind === 'thinking' && isStreaming ? '正在准备执行...' : '')
          return (
            <div key={msg.id} className={`${styles.message} ${styles[msg.role]}`}>
              <div className={styles.avatar}>{msg.role === 'user' ? '👤' : '🤖'}</div>
              <div className={styles.bubble}>
              {messageContent ? <p>{messageContent}</p> : null}
              {msg.sources && msg.sources.length > 0 && (
                <div className={styles.sources}>
                  <p className={styles.sourcesTitle}>📚 引用来源:</p>
                  {msg.sources.map((s: any, i: number) => (
                    <span key={i} className={styles.source}>
                      {s.paper_title} (p.{s.page})
                    </span>
                  ))}
                </div>
              )}
              {msg.execution?.trace_visibility === 'compact' && msg.sources?.length ? (
                <div className={styles.compactTrace}>已检索 {msg.sources.length} 个相关论文片段</div>
              ) : null}
              {msg.execution?.mode === 'agent' && msg.traceSummary ? (
                <div className={styles.trace}>
                  <span>events {msg.traceSummary.event_count || 0}</span>
                  <span>tools {msg.traceSummary.tool_calls || 0}</span>
                  <span>llm {msg.traceSummary.llm_calls || 0}</span>
                  <span>tokens {msg.traceSummary.token_usage?.total_tokens || 0}</span>
                </div>
              ) : null}
              {msg.runId && msg.events && msg.events.length > 0 ? (
                <section className={styles.executionPanel}>
                  <div className={styles.executionHeader}>
                    <span>思考过程</span>
                  </div>
                  <ThinkingTimeline steps={msg.events} />
                </section>
              ) : null}
              </div>
            </div>
          )
        })}
        <div ref={messagesEndRef} />
      </main>

      <footer className={styles.inputBar}>
        <select
          className={styles.scopeSelect}
          value={selectedPaperId}
          onChange={e => {
            setSelectedPaperId(e.target.value)
            clearMessages()
          }}
          disabled={isStreaming}
        >
          <option value="">全部论文</option>
          {papers.map((paper) => (
            <option key={paper.id} value={paper.id}>
              {paper.title}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder="输入你的问题..."
          className={styles.input}
          disabled={isStreaming}
        />
        <button
          onClick={() => {
            const scope = selectedPaperId || 'all-papers'
            const nextSessionId = createQaSessionId(scope)
            window.sessionStorage.setItem(getQaSessionKey(scope), nextSessionId)
            setQaSessionId(nextSessionId)
            clearMessages()
            // 清空 agent-gateway 中的会话上下文
            agentRunsApi.resetSession(qaSessionId).catch(console.error)
          }}
          disabled={isStreaming}
          className="btn"
        >
          重置
        </button>
        <button onClick={handleSend} disabled={isStreaming} className="btn btn-primary">
          {isStreaming ? '思考中...' : '发送'}
        </button>
      </footer>
    </div>
  )
}
