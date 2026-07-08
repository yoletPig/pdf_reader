import { useState, useEffect } from 'react'
import { configApi } from '../../api/config'
import { promptsApi } from '../../api/prompts'
import { useConfigStore } from '../../stores/config-store'
import styles from './SettingsPage.module.css'

export default function SettingsPage() {
  const { modelConfig, prompts, setModelConfig, setPrompts, theme, setTheme } = useConfigStore()
  const [activeTab, setActiveTab] = useState<'models' | 'prompts' | 'general'>('models')
  const [testing, setTesting] = useState(false)
  const [status, setStatus] = useState('')

  useEffect(() => {
    configApi.getModel().then(res => setModelConfig(res.data)).catch(console.error)
    promptsApi.list().then(res => setPrompts(res.data.templates || [])).catch(console.error)
  }, [setModelConfig, setPrompts])

  const handleTestModel = async () => {
    setTesting(true)
    setStatus('')
    try {
      const res = await configApi.testModel()
      setStatus(res.data.status === 'ok' ? `连通成功，耗时 ${res.data.latency_ms}ms` : `测试失败: ${res.data.message}`)
    } catch (error: any) {
      setStatus(error?.response?.data?.detail || '测试失败')
    } finally {
      setTesting(false)
    }
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <a href="/" className={styles.back}>← 返回</a>
        <h1>⚙️ 设置</h1>
      </header>

      <div className={styles.layout}>
        <nav className={styles.tabs}>
          <button className={`${styles.tab} ${activeTab === 'models' ? styles.active : ''}`} onClick={() => setActiveTab('models')}>🤖 模型配置</button>
          <button className={`${styles.tab} ${activeTab === 'prompts' ? styles.active : ''}`} onClick={() => setActiveTab('prompts')}>📝 Prompt 模板</button>
          <button className={`${styles.tab} ${activeTab === 'general' ? styles.active : ''}`} onClick={() => setActiveTab('general')}>🎨 通用设置</button>
        </nav>

        <main className={styles.content}>
          {activeTab === 'models' && (
            <section>
              <h2>当前模型配置</h2>
              <div className={styles.formCard}>
                <label className={styles.field}>
                  <span>Base URL</span>
                  <input value={modelConfig?.base_url || ''} readOnly />
                </label>
                <label className={styles.field}>
                  <span>模型名</span>
                  <input value={modelConfig?.model || ''} readOnly />
                </label>
                <label className={styles.field}>
                  <span>API Key</span>
                  <input value={modelConfig?.api_key || ''} readOnly type="password" />
                </label>
                <p className={styles.statusText}>
                  该项目现在只通过 <code>backend/.env</code> 配置模型。修改后请重启后端服务。
                </p>
                <div className={styles.formActions}>
                  <button className="btn btn-secondary" onClick={handleTestModel} disabled={testing}>
                    {testing ? '测试中...' : '测试连通性'}
                  </button>
                </div>
                {status ? <p className={styles.statusText}>{status}</p> : null}
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
