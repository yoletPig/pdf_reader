import { useEffect, useState } from 'react'
import { useChatStore } from '../../stores/chat-store'
import { agentRunsApi } from '../../api/agent-runs'
import { papersApi, Paper } from '../../api/papers'
import styles from './ChatPage.module.css'

function createQaSessionId(scope: string) {
  return `qa:${scope}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`
}

function getQaSessionKey(scope: string) {
  return `pdf-reader:${scope}:qa-session`
}

export default function ChatPage() {
  const [input, setInput] = useState('')
  const [papers, setPapers] = useState<Paper[]>([])
  const [selectedPaperId, setSelectedPaperId] = useState('')
  const [qaSessionId, setQaSessionId] = useState('')
  const { messages, isStreaming, addMessage, setStreaming, clearMessages } = useChatStore()

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
      addMessage({
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        runId: data.run_id,
        content: data.answer?.content || '抱歉，无法回答这个问题。',
        sources: data.answer?.sources || [],
        traceSummary: data.answer?.trace_summary,
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
