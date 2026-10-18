/**
 * Markdown 渲染 — GFM + KaTeX + 图片点击放大
 * 聊天、译文、论文画像统一使用。
 */
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { preprocessMarkdown } from '../../utils/markdown'
import { ZoomableImage } from './kit'
import 'katex/dist/katex.min.css'
import styles from './markdown.module.css'

export function Markdown({ children, compact = false }: { children: string; compact?: boolean }) {
  const processed = preprocessMarkdown(children || '')
  return (
    <div className={`${styles.markdown} ${compact ? styles.compact : ''}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          img: ({ src, alt }) => (
            <ZoomableImage src={String(src || '')} alt={alt} style={{ maxWidth: '100%', height: 'auto', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)', margin: '10px 0' }} />
          ),
          table: ({ children }) => (
            <div className={styles.tableWrap}>
              <table>{children}</table>
            </div>
          ),
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer">{children}</a>
          ),
        }}
      >
        {processed}
      </ReactMarkdown>
    </div>
  )
}
