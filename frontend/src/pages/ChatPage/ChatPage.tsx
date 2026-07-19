import { useEffect, useMemo, useState } from 'react'
import { useChatStore } from '../../stores/chat-store'
import { AgentRunEvent, RetrievalDebugResult, agentRunsApi } from '../../api/agent-runs'
import { papersApi, Paper } from '../../api/papers'
import styles from './ChatPage.module.css'

function createQaSessionId(scope: string) {
  return `qa:${scope}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

function getQaSessionKey(scope: string) {
  return `pdf-reader:${scope}:qa-session`
}

function formatEventSummary(event: AgentRunEvent) {
  const payload = event.payload || {}
  switch (event.type) {
    case 'plan_created':
      return `steps: ${(payload.steps || []).join(' -> ')}`
    case 'tool_started':
      return `${payload.tool} attempt ${payload.attempt || 1}`
    case 'tool_finished':
      return `${payload.tool} ${payload.duration_ms || 0}ms`
    case 'tool_failed':
      return `${payload.tool} ${payload.error_type || 'Error'}`
    case 'retry_scheduled':
      return `${payload.tool} retry ${payload.next_attempt || ''}`.trim()
    case 'llm_started':
      return `${payload.model || 'default'} ${payload.message_count || 0} msgs`
    case 'llm_finished':
      return `${payload.model || 'default'} ${payload.duration_ms || 0}ms / ${payload.usage?.total_tokens || 0} tokens`
    case 'citation_checked':
      return `${payload.valid || 0}/${payload.total || 0} valid`
    case 'run_finished':
    case 'run_failed':
      return `${payload.duration_ms || 0}ms`
    default:
      return Object.entries(payload).slice(0, 2).map(([key, value]) => `${key}: ${String(value)}`).join(' · ')
  }
}

export default function ChatPage() {
  const [input, setInput] = useState('')
  const [papers, setPapers] = useState<Paper[]>([])
  const [selectedPaperId, setSelectedPaperId] = useState('')
  const [qaSessionId, setQaSessionId] = useState('')
  const [expandedRuns, setExpandedRuns] = useState<Record<string, boolean>>({})
  const [expandedRetrievals, setExpandedRetrievals] = useState<Record<string, boolean>>({})
  const { messages, isStreaming, addMessage, setStreaming, clearMessages } = useChatStore()
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

  const handleSend = async () => {
    if (!input.trim() || isStreaming || !qaSessionId) return
    const userMsg = { id: Date.now().toString(), role: 'user' as const, content: input, timestamp: Date.now() }
    addMessage(userMsg)
    setInput('')
    setStreaming(true)

    try {
      const res = await agentRunsApi.createPaperQA({
        input: {
          question: userMsg.content,
          paper_id: selectedPaperId || undefined,
          top_k: 5,
        },
        context: {
          paper_id: selectedPaperId || undefined,
          session_id: qaSessionId,
        },
      })
      const data = res.data as any
      let events: AgentRunEvent[] = []
      let retrievalDebug
      if (data.run_id) {
        try {
          const [eventsRes, retrievalRes] = await Promise.all([
            agentRunsApi.getEvents(data.run_id),
            agentRunsApi.getRetrieveDebug({
              question: userMsg.content,
              paper_id: selectedPaperId || undefined,
              top_k: 5,
            }),
          ])
          events = eventsRes.data.events || []
          retrievalDebug = retrievalRes.data
        } catch (eventErr) {
          console.error(eventErr)
        }
      }
      addMessage({
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        runId: data.run_id,
        content: data.answer?.content || '抱歉，无法回答这个问题。',
        sources: data.answer?.sources || [],
        traceSummary: data.answer?.trace_summary,
        events,
        retrievalDebug,
        timestamp: Date.now(),
      })
    } catch (err) {
      addMessage({
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: '出错了，请稍后再试。',
        timestamp: Date.now(),
      })
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
        {messages.map(msg => (
          <div key={msg.id} className={`${styles.message} ${styles[msg.role]}`}>
            <div className={styles.avatar}>{msg.role === 'user' ? '👤' : '🤖'}</div>
            <div className={styles.bubble}>
              <p>{msg.content}</p>
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
              {msg.traceSummary ? (
                <div className={styles.trace}>
                  <span>events {msg.traceSummary.event_count || 0}</span>
                  <span>tools {msg.traceSummary.tool_calls || 0}</span>
                  <span>llm {msg.traceSummary.llm_calls || 0}</span>
                  <span>{msg.traceSummary.duration_ms || 0}ms</span>
                  <span>tokens {msg.traceSummary.token_usage?.total_tokens || 0}</span>
                </div>
              ) : null}
              {msg.runId && msg.events && msg.events.length > 0 ? (
                <div className={styles.eventsPanel}>
                  <div className={styles.panelActions}>
                    <button
                      type="button"
                      className={styles.eventsToggle}
                      onClick={() => setExpandedRuns((state) => ({ ...state, [msg.runId!]: !state[msg.runId!] }))}
                    >
                      {expandedRuns[msg.runId] ? '隐藏执行过程' : '查看执行过程'}
                    </button>
                    {msg.retrievalDebug?.results?.length ? (
                      <button
                        type="button"
                        className={styles.eventsToggle}
                        onClick={() => setExpandedRetrievals((state) => ({ ...state, [msg.runId!]: !state[msg.runId!] }))}
                      >
                        {expandedRetrievals[msg.runId] ? '隐藏检索命中' : '查看检索命中'}
                      </button>
                    ) : null}
                  </div>
                  {expandedRuns[msg.runId] ? (
                    <div className={styles.eventsList}>
                      {msg.events.map((event) => (
                        <div key={`${msg.runId}-${event.sequence}`} className={styles.eventRow}>
                          <span className={styles.eventType}>{event.type}</span>
                          <span className={styles.eventSummary}>{formatEventSummary(event)}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {expandedRetrievals[msg.runId] && msg.retrievalDebug?.results?.length ? (
                    <div className={styles.retrievalList}>
                      <div className={styles.retrievalHeader}>
                        <span>{msg.retrievalDebug.candidate_count} chunks</span>
                        <span>{msg.retrievalDebug.used_fallback ? 'fallback' : 'scored'}</span>
                      </div>
                      {msg.retrievalDebug.results.map((result: RetrievalDebugResult) => (
                        <div key={`${msg.runId}-${result.chunk_id}`} className={styles.retrievalCard}>
                          <div className={styles.retrievalMeta}>
                            <span>{result.paper_title}</span>
                            <span>p.{result.page}</span>
                            <span>{result.chunk_id}</span>
                          </div>
                          {result.section_title ? (
                            <div className={styles.retrievalSection}>{result.section_title}</div>
                          ) : null}
                          <pre className={styles.retrievalText}>{result.chunk_text}</pre>
                          <div className={styles.retrievalScores}>
                            <span>final {result.score_breakdown.final_score.toFixed(4)}</span>
                            <span>vector {result.score_breakdown.vector_score.toFixed(4)}</span>
                            <span>lexical {result.score_breakdown.lexical_score.toFixed(4)}</span>
                            <span>bridge {result.score_breakdown.bridge_score.toFixed(4)}</span>
                            <span>section {result.score_breakdown.section_bonus.toFixed(4)}</span>
                            <span>clue {result.score_breakdown.clue_bonus.toFixed(4)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        ))}
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
