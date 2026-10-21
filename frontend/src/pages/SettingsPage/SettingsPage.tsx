import { useEffect, useState } from 'react'
import { configApi, SettingField, SettingGroup } from '../../api/config'
import { agentRunsApi, type McpServerStatus } from '../../api/agent-runs'
import { promptsApi } from '../../api/prompts'
import { useConfigStore } from '../../stores/config-store'
import styles from './SettingsPage.module.css'

type TabId = 'pdf' | 'model' | 'agent' | 'prompts' | 'general'

interface EditableField extends SettingField {
  dirty: boolean
  error?: string
}

export default function SettingsPage() {
  const { prompts, setPrompts, theme, setTheme } = useConfigStore()
  const [activeTab, setActiveTab] = useState<TabId>('pdf')
  const [groups, setGroups] = useState<Record<string, SettingGroup>>({})
  const [fields, setFields] = useState<Record<string, EditableField>>({})
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState('')
  const [savingAll, setSavingAll] = useState(false)
  const [gatewayStatus, setGatewayStatus] = useState<string>('')
  const [agentOverview, setAgentOverview] = useState<any>(null)
  const [mcpTests, setMcpTests] = useState<Record<string, { loading: boolean; result?: McpServerStatus }>>({})

  useEffect(() => {
    if (activeTab === 'agent') {
      agentRunsApi
        .getStatus()
        .then(res => setAgentOverview(res.data))
        .catch(() => setAgentOverview(null))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  useEffect(() => {
    refreshSettings()
    promptsApi.list().then(res => setPrompts(res.data.templates || [])).catch(console.error)
    import('../../api/agent-runs').then(({ agentRunsApi }) =>
      agentRunsApi.health().then(res => {
        setGatewayStatus(res.data.status === 'ok' ? `运行中（${res.data.active_sessions ?? 0} 个会话）` : '异常')
      }).catch(() => setGatewayStatus('未启动'))
    ).catch(() => setGatewayStatus('未启动'))
  }, [setPrompts])

  const refreshSettings = async () => {
    try {
      const res = await configApi.getSettings()
      setGroups(res.data.groups)
      const fieldMap: Record<string, EditableField> = {}
      for (const group of Object.values(res.data.groups)) {
        for (const field of group.fields) {
          fieldMap[field.key] = { ...field, dirty: false }
        }
      }
      setFields(fieldMap)
    } catch (error: any) {
      setStatus(`读取设置失败: ${error?.response?.data?.detail || error.message}`)
    }
  }

  const updateField = (key: string, value: any) => {
    setFields(prev => ({
      ...prev,
      [key]: { ...prev[key], value, dirty: true, error: undefined },
    }))
  }

  const dirtyCount = Object.values(fields).filter(f => f.dirty).length

  const saveAll = async () => {
    const dirty = Object.values(fields).filter(f => f.dirty)
    if (!dirty.length || savingAll) return
    setSavingAll(true)
    setStatus('')
    try {
      // secret 留空表示保持不变，不提交；其他空值表示重置回默认
      const items = dirty
        .filter(f => !(f.type === 'secret' && f.has_value && f.value === ''))
        .map(f => ({ key: f.key, value: f.value === '' ? null : f.value }))
      if (!items.length) {
        await refreshSettings()
        setStatus('没有需要保存的修改。')
        return
      }
      await configApi.saveSettings(items)
      // trust_env 只影响传输层，保存后无需重复测试模型连通性
      const llmTouched = items.some(
        i => i.key.startsWith('llm.') && i.key !== 'llm.api_key' && i.key !== 'llm.trust_env',
      )
      await refreshSettings()
      setStatus(`✅ 已保存 ${items.length} 项设置，立即生效。`)
      if (llmTouched) handleTestModel()
    } catch (error: any) {
      setStatus(`❌ 保存失败: ${error?.response?.data?.detail || error.message}`)
    } finally {
      setSavingAll(false)
    }
  }

  const discardChanges = () => {
    refreshSettings()
    setStatus('已放弃未保存的修改。')
  }

  const handleTestModel = async () => {
    setTesting(true)
    setStatus('')
    try {
      const res = await configApi.testModel()
      if (res.data.status === 'ok') {
        setStatus(`✅ 模型连通成功，耗时 ${res.data.latency_ms}ms，返回: ${res.data.response?.slice(0, 60)}`)
      } else {
        setStatus(`❌ 测试失败: ${res.data.message}`)
      }
    } catch (error: any) {
      setStatus(`❌ 测试失败: ${error?.response?.data?.detail || error.message}`)
    } finally {
      setTesting(false)
    }
  }

  const renderField = (field: EditableField) => {
    const commonProps = {
      disabled: savingAll,
    }
    let control: React.ReactNode = null
    if (field.type === 'enum') {
      control = (
        <select
          value={String(field.value ?? '')}
          onChange={e => updateField(field.key, e.target.value)}
          {...commonProps}
        >
          {(field.choices || []).map(choice => (
            <option key={choice.value} value={choice.value}>{choice.label}</option>
          ))}
        </select>
      )
    } else if (field.type === 'number') {
      control = (
        <input
          type="number"
          value={Number(field.value ?? 0)}
          onChange={e => updateField(field.key, Number(e.target.value))}
          {...commonProps}
        />
      )
    } else if (field.type === 'boolean') {
      control = (
        <input
          type="checkbox"
          checked={Boolean(field.value ?? false)}
          onChange={e => updateField(field.key, e.target.checked)}
          {...commonProps}
        />
      )
    } else if (field.type === 'text') {
      control = (
        <textarea
          value={String(field.value ?? '')}
          onChange={e => updateField(field.key, e.target.value)}
          rows={5}
          {...commonProps}
        />
      )
    } else if (field.type === 'list') {
      return renderListField(field)
    } else {
      control = (
        <input
          type={field.type === 'secret' ? 'password' : 'text'}
          value={String(field.value ?? '')}
          placeholder={field.type === 'secret' && field.has_value ? '已配置（留空保持不变）' : ''}
          onChange={e => updateField(field.key, e.target.value)}
          {...commonProps}
        />
      )
    }

    return (
      <div key={field.key} className={styles.field}>
        <label className={styles.fieldLabel}>
          <span>{field.label}</span>
          {field.overridden ? <span className={styles.overriddenBadge}>已自定义</span> : null}
          {field.dirty ? <span className={styles.dirtyBadge}>未保存</span> : null}
        </label>
        {field.description ? <p className={styles.fieldHint}>{field.description}</p> : null}
        <div className={styles.fieldRow}>
          {control}
        </div>
        {field.error ? <p className={styles.fieldError}>{field.error}</p> : null}
      </div>
    )
  }

  /* ---------- list 字段：技能 / MCP 服务器结构化编辑 ---------- */

  const parseEnvLines = (text: string): Record<string, string> => {
    const env: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const eq = trimmed.indexOf('=')
      if (eq <= 0) continue
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1)
    }
    return env
  }

  const envToLines = (env: any) =>
    Object.entries(env || {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')

  const handleTestMcp = async (fieldKey: string, index: number, server: Record<string, any>) => {
    const testKey = `${fieldKey}:${index}`
    setMcpTests(prev => ({ ...prev, [testKey]: { loading: true } }))
    try {
      const res = await agentRunsApi.testMcpServer(server)
      setMcpTests(prev => ({ ...prev, [testKey]: { loading: false, result: res.data } }))
    } catch (error: any) {
      setMcpTests(prev => ({
        ...prev,
        [testKey]: {
          loading: false,
          result: {
            name: server.name,
            transport: server.transport,
            status: 'error',
            tools: [],
            error: error?.response?.data?.detail || error.message || '测试失败',
          },
        },
      }))
    }
  }

  const renderListField = (field: EditableField) => {
    const items: any[] = Array.isArray(field.value) ? field.value : []
    const setItems = (next: any[]) => updateField(field.key, next)
    const updateItem = (index: number, patch: Record<string, any>) =>
      setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)))

    return (
      <div key={field.key} className={styles.field}>
        <label className={styles.fieldLabel}>
          <span>{field.label}</span>
          {field.overridden ? <span className={styles.overriddenBadge}>已自定义</span> : null}
          {field.dirty ? <span className={styles.dirtyBadge}>未保存</span> : null}
        </label>
        {field.description ? <p className={styles.fieldHint}>{field.description}</p> : null}

        {items.length === 0 ? <p className={styles.fieldHint}>暂无条目</p> : null}

        {items.map((item, index) =>
          field.item === 'skill' ? (
            <div key={index} className={styles.listCard}>
              <div className={styles.listCardHeader}>
                <input
                  value={String(item.name ?? '')}
                  placeholder="技能名（如 summarize_paper）"
                  onChange={e => updateItem(index, { name: e.target.value })}
                  disabled={savingAll}
                />
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setItems(items.filter((_, i) => i !== index))}
                  disabled={savingAll}
                >
                  🗑 删除
                </button>
              </div>
              <input
                value={String(item.description ?? '')}
                placeholder="描述（agent 据此判断何时使用）"
                onChange={e => updateItem(index, { description: e.target.value })}
                disabled={savingAll}
              />
              <textarea
                value={String(item.content ?? '')}
                placeholder="技能内容（提示词 / 知识片段 / 操作指引）"
                rows={5}
                onChange={e => updateItem(index, { content: e.target.value })}
                disabled={savingAll}
              />
            </div>
          ) : (
            <div key={index} className={styles.listCard}>
              <div className={styles.listCardHeader}>
                <input
                  value={String(item.name ?? '')}
                  placeholder="服务器名（如 fetch）"
                  onChange={e => updateItem(index, { name: e.target.value })}
                  disabled={savingAll}
                />
                <select
                  value={String(item.transport ?? 'stdio')}
                  onChange={e => updateItem(index, { transport: e.target.value })}
                  disabled={savingAll}
                >
                  <option value="stdio">本地进程 (stdio)</option>
                  <option value="http">远程 (HTTP)</option>
                </select>
                <label className={styles.checkboxInline}>
                  <input
                    type="checkbox"
                    checked={item.enabled !== false}
                    onChange={e => updateItem(index, { enabled: e.target.checked })}
                    disabled={savingAll}
                  />
                  启用
                </label>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleTestMcp(field.key, index, item)}
                  disabled={savingAll || mcpTests[`${field.key}:${index}`]?.loading}
                >
                  {mcpTests[`${field.key}:${index}`]?.loading ? '测试中…' : '🔌 测试'}
                </button>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setItems(items.filter((_, i) => i !== index))}
                  disabled={savingAll}
                >
                  🗑 删除
                </button>
              </div>
              {(item.transport ?? 'stdio') === 'stdio' ? (
                <>
                  <input
                    value={String(item.command ?? '')}
                    placeholder="启动命令，如 npx / uvx / node"
                    onChange={e => updateItem(index, { command: e.target.value })}
                    disabled={savingAll}
                  />
                  <input
                    value={Array.isArray(item.args) ? item.args.join(' ') : String(item.args ?? '')}
                    placeholder="参数（空格分隔），如 -y @modelcontextprotocol/server-filesystem /path"
                    onChange={e =>
                      updateItem(index, {
                        args: e.target.value.split(/\s+/).filter(Boolean),
                      })
                    }
                    disabled={savingAll}
                  />
                  <textarea
                    value={envToLines(item.env)}
                    placeholder={'环境变量（每行 KEY=value），如\nAPI_KEY=sk-xxx'}
                    rows={2}
                    onChange={e => updateItem(index, { env: parseEnvLines(e.target.value) })}
                    disabled={savingAll}
                  />
                </>
              ) : (
                <>
                  <input
                    value={String(item.url ?? '')}
                    placeholder="Streamable HTTP 端点，如 https://example.com/mcp"
                    onChange={e => updateItem(index, { url: e.target.value })}
                    disabled={savingAll}
                  />
                  <textarea
                    value={envToLines(item.headers)}
                    placeholder={'请求头（每行 KEY=value），如\nAuthorization=Bearer xxx'}
                    rows={2}
                    onChange={e => updateItem(index, { headers: parseEnvLines(e.target.value) })}
                    disabled={savingAll}
                  />
                </>
              )}
              {mcpTests[`${field.key}:${index}`]?.result ? (
                <p
                  className={`${styles.testResult} ${
                    mcpTests[`${field.key}:${index}`].result?.status === 'connected'
                      ? styles.testOk
                      : styles.testErr
                  }`}
                >
                  {mcpTests[`${field.key}:${index}`].result?.status === 'connected'
                    ? `✅ 连接成功，发现 ${mcpTests[`${field.key}:${index}`].result?.tools?.length ?? 0} 个工具${
                        mcpTests[`${field.key}:${index}`].result?.tools?.length
                          ? `：${mcpTests[`${field.key}:${index}`].result?.tools.join(', ')}`
                          : ''
                      }`
                    : `❌ 连接失败：${mcpTests[`${field.key}:${index}`].result?.error || '未知错误'}`}
                </p>
              ) : null}
            </div>
          ),
        )}

        <button
          className="btn btn-secondary btn-sm"
          onClick={() =>
            setItems(
              field.item === 'skill'
                ? [...items, { name: '', description: '', content: '' }]
                : [
                    ...items,
                    {
                      name: '',
                      transport: 'stdio',
                      command: '',
                      args: [],
                      env: {},
                      url: '',
                      headers: {},
                      enabled: true,
                    },
                  ],
            )
          }
          disabled={savingAll}
        >
          + {field.item === 'skill' ? '添加技能' : '添加 MCP 服务器'}
        </button>
        {field.error ? <p className={styles.fieldError}>{field.error}</p> : null}
      </div>
    )
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <a href="/" className={styles.back}>← 返回</a>
        <h1>⚙️ 系统设置</h1>
      </header>

      <div className={styles.layout}>
        <nav className={styles.tabs}>
          <button className={`${styles.tab} ${activeTab === 'pdf' ? styles.active : ''}`} onClick={() => setActiveTab('pdf')}>📄 PDF 识别</button>
          <button className={`${styles.tab} ${activeTab === 'model' ? styles.active : ''}`} onClick={() => setActiveTab('model')}>🤖 模型配置</button>
          <button className={`${styles.tab} ${activeTab === 'agent' ? styles.active : ''}`} onClick={() => setActiveTab('agent')}>🧠 Agent 设置</button>
          <button className={`${styles.tab} ${activeTab === 'prompts' ? styles.active : ''}`} onClick={() => setActiveTab('prompts')}>📝 Prompt 模板</button>
          <button className={`${styles.tab} ${activeTab === 'general' ? styles.active : ''}`} onClick={() => setActiveTab('general')}>🎨 通用设置</button>
        </nav>

        <main className={styles.content}>
          {(activeTab === 'pdf' || activeTab === 'model' || activeTab === 'agent') && (
            <div className={styles.saveBar}>
              <span className={dirtyCount ? `${styles.saveInfo} ${styles.saveInfoDirty}` : styles.saveInfo}>
                {dirtyCount ? `有 ${dirtyCount} 项未保存的修改` : '所有修改已保存'}
              </span>
              <div className={styles.saveActions}>
                <button className="btn btn-ghost" onClick={discardChanges} disabled={!dirtyCount || savingAll}>
                  放弃更改
                </button>
                <button className="btn btn-primary" onClick={saveAll} disabled={!dirtyCount || savingAll}>
                  {savingAll ? '保存中...' : `保存所有修改${dirtyCount ? `（${dirtyCount}）` : ''}`}
                </button>
              </div>
            </div>
          )}
          {status ? <div className={styles.statusBar}>{status}</div> : null}

          {(activeTab === 'pdf' || activeTab === 'model' || activeTab === 'agent') && groups[activeTab] && (
            <section>
              <h2>{groups[activeTab].title}</h2>
              <p className={styles.groupDescription}>{groups[activeTab].description}</p>
              <div className={styles.formCard}>
                {groups[activeTab].fields.map(f => renderField(fields[f.key] || f))}
              </div>
            </section>
          )}

          {activeTab === 'agent' && (
            <section>
              <div className={styles.formCard}>
                <h3>Agent 运行状态</h3>
                {agentOverview && agentOverview.status === 'ok' ? (
                  <>
                    <p className={styles.fieldHint}>
                      模型：{agentOverview.model || '未配置'} · 活跃会话：{agentOverview.active_sessions ?? 0} ·
                      技能：{agentOverview.skills?.length || 0} 个 · MCP 服务器：{agentOverview.mcp?.length || 0} 个
                    </p>
                    <div className={styles.mcpStatusList}>
                      {(agentOverview.mcp || []).map((s: McpServerStatus) => (
                        <div key={s.name} className={styles.mcpStatusItem}>
                          <span
                            className={`${styles.mcpDot} ${
                              s.status === 'connected'
                                ? styles.mcpOk
                                : s.status === 'disabled'
                                  ? styles.mcpOff
                                  : styles.mcpErr
                            }`}
                          />
                          <strong>{s.name}</strong>
                          <span>
                            {s.status === 'connected'
                              ? `已连接（${s.tools?.length ?? 0} 个工具）`
                              : s.status === 'disabled'
                                ? '已禁用'
                                : s.status === 'connecting'
                                  ? '连接中…'
                                  : `连接失败：${s.error || '未知错误'}`}
                          </span>
                        </div>
                      ))}
                      {(agentOverview.mcp || []).length === 0 ? (
                        <p className={styles.fieldHint}>未配置 MCP 服务器</p>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <p className={styles.fieldHint}>agent 服务不可用（{gatewayStatus || '未启动'}），配置仍可保存。</p>
                )}
                <p className={styles.fieldHint}>
                  提示：修改 Agent 配置后下一次提问即生效；进行中的对话保留历史，系统提示与工具按新配置重建。
                </p>
              </div>
            </section>
          )}

          {activeTab === 'model' && (
            <section className={styles.modelActions}>
              <div className={styles.formCard}>
                <h3>连通性测试</h3>
                <p className={styles.fieldHint}>使用当前生效配置发起一次最小请求。</p>
                <div className={styles.fieldRow}>
                  <button className="btn btn-primary" onClick={handleTestModel} disabled={testing}>
                    {testing ? '测试中...' : '🧪 测试模型连通性'}
                  </button>
                  <span className={styles.gatewayStatus}>
                    agent 服务: {gatewayStatus || '检测中...'}
                  </span>
                </div>
              </div>
            </section>
          )}

          {activeTab === 'prompts' && (
            <section>
              <h2>Prompt 模板管理</h2>
              {prompts.map(p => (
                <div key={p.id} className={styles.card}>
                  <div>
                    <strong>{p.name}</strong>
                    <span className={styles.badge}>{p.agent_mode}</span>
                    <span className={styles.badge}>{p.layer}</span>
                    <span className={styles.versionBadge}>v{p.version}</span>
                  </div>
                  <pre className={styles.promptPreview}>{p.content.slice(0, 200)}...</pre>
                </div>
              ))}
            </section>
          )}

          {activeTab === 'general' && (
            <section>
              <h2>通用设置</h2>
              <div className={styles.settingItem}>
                <span>主题</span>
                <select value={theme} onChange={e => setTheme(e.target.value as 'light' | 'dark')}>
                  <option value="light">浅色</option>
                  <option value="dark">暗色</option>
                </select>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  )
}
