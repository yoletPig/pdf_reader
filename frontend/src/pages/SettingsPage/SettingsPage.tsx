import { useEffect, useState } from 'react'
import { configApi, SettingField, SettingGroup } from '../../api/config'
import { promptsApi } from '../../api/prompts'
import { useConfigStore } from '../../stores/config-store'
import styles from './SettingsPage.module.css'

type TabId = 'pdf' | 'model' | 'prompts' | 'general'

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

  const updateField = (key: string, value: string | number | boolean) => {
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
          <button className={`${styles.tab} ${activeTab === 'prompts' ? styles.active : ''}`} onClick={() => setActiveTab('prompts')}>📝 Prompt 模板</button>
          <button className={`${styles.tab} ${activeTab === 'general' ? styles.active : ''}`} onClick={() => setActiveTab('general')}>🎨 通用设置</button>
        </nav>

        <main className={styles.content}>
          {(activeTab === 'pdf' || activeTab === 'model') && (
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

          {(activeTab === 'pdf' || activeTab === 'model') && groups[activeTab] && (
            <section>
              <h2>{groups[activeTab].title}</h2>
              <p className={styles.groupDescription}>{groups[activeTab].description}</p>
              <div className={styles.formCard}>
                {groups[activeTab].fields.map(f => renderField(fields[f.key] || f))}
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
