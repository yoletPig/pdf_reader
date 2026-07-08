import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import styles from './TranslationResult.module.css'

interface TranslationResultProps {
  originalText: string
  translatedText: string
  isLoading: boolean
  mode: 'quick' | 'polish'
  modelUsed?: string
}

export default function TranslationResult({
  originalText,
  translatedText,
  isLoading,
  mode,
  modelUsed,
}: TranslationResultProps) {
  if (isLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p>翻译中...</p>
        </div>
      </div>
    )
  }

  if (!translatedText) {
    return (
      <div className={styles.container}>
        <p className={styles.placeholder}>点击上方按钮获取翻译或解释</p>
      </div>
    )
  }

  const modeLabel = mode === 'quick' ? '⚡ 快速' : '✍️ 严谨'

  return (
    <div className={styles.container}>
      {originalText && (
        <details className={styles.originalSection}>
          <summary className={styles.originalToggle}>📄 原文</summary>
          <p className={styles.originalText}>{originalText}</p>
        </details>
      )}

      <div className={styles.meta}>
        <span className={`${styles.badge} ${mode === 'quick' ? styles.badgeQuick : styles.badgePolish}`}>
          {modeLabel}
        </span>
        {modelUsed && <span className={styles.modelBadge}>{modelUsed}</span>}
      </div>

      <div className={styles.markdown}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {translatedText}
        </ReactMarkdown>
      </div>
    </div>
  )
}
