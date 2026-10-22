import { useRef, useState, type DragEvent, type ClipboardEvent } from 'react'
import { Markdown } from '../ui/Markdown'
import { Segmented, useToast } from '../ui/kit'
import { notesApi } from '../../api/notes'
import styles from './MarkdownEditor.module.css'

type EditorMode = 'edit' | 'split' | 'preview'

const MODE_OPTIONS = [
  { value: 'edit', label: '编辑' },
  { value: 'split', label: '分屏' },
  { value: 'preview', label: '预览' },
] as const

interface ToolbarItem {
  icon: string
  title: string
  before: string
  after?: string
  placeholder?: string
}

const TOOLBAR_ITEMS: ToolbarItem[] = [
  { icon: 'H₂', title: '二级标题', before: '\n## ', placeholder: '标题' },
  { icon: 'H₃', title: '三级标题', before: '\n### ', placeholder: '标题' },
  { icon: '𝐁', title: '加粗', before: '**', after: '**', placeholder: '加粗文本' },
  { icon: '𝐼', title: '斜体', before: '*', after: '*', placeholder: '斜体文本' },
  { icon: 'S̶', title: '删除线', before: '~~', after: '~~', placeholder: '删除文本' },
  { icon: '<>', title: '行内代码', before: '`', after: '`', placeholder: 'code' },
  { icon: '🔗', title: '链接', before: '[', after: '](https://)', placeholder: '链接文字' },
  { icon: '•', title: '无序列表', before: '\n- ', placeholder: '列表项' },
  { icon: '1.', title: '有序列表', before: '\n1. ', placeholder: '列表项' },
  { icon: '☑', title: '任务清单', before: '\n- [ ] ', placeholder: '待办事项' },
  { icon: '❝', title: '引用', before: '\n> ', placeholder: '引用内容' },
  { icon: '⊞', title: '表格', before: '\n| 列1 | 列2 |\n| --- | --- |\n| ', after: ' |  |', placeholder: '内容' },
]

interface MarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  minHeight?: number
}

/** Markdown 编辑器：工具栏 + 编辑/分屏/预览 + 图片上传（按钮/粘贴/拖拽） */
export function MarkdownEditor({ value, onChange, placeholder, minHeight = 360 }: MarkdownEditorProps) {
  const toast = useToast()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<EditorMode>('split')
  const [uploading, setUploading] = useState(false)

  /** 在光标处插入/包裹文本 */
  const insertText = (before: string, after = '', placeholder = '') => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const selected = value.slice(start, end) || placeholder
    const next = value.slice(0, start) + before + selected + after + value.slice(end)
    onChange(next)
    // 恢复选区到插入内容
    requestAnimationFrame(() => {
      textarea.focus()
      const selStart = start + before.length
      textarea.setSelectionRange(selStart, selStart + selected.length)
    })
  }

  const uploadImage = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error('仅支持图片文件')
      return
    }
    setUploading(true)
    try {
      const res = await notesApi.uploadImage(file)
      const alt = file.name.replace(/\.[^.]+$/, '') || '图片'
      insertText(`![${alt}](${res.data.url})`)
      toast.success('图片已上传')
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '图片上传失败')
    } finally {
      setUploading(false)
    }
  }

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files || [])
    const image = files.find((f) => f.type.startsWith('image/'))
    if (image) {
      e.preventDefault()
      uploadImage(image)
    }
  }

  const handleDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer?.files || [])
    const image = files.find((f) => f.type.startsWith('image/'))
    if (image) {
      e.preventDefault()
      uploadImage(image)
    }
  }

  return (
    <div className={styles.editor}>
      <div className={styles.toolbar}>
        <div className={styles.toolbarLeft}>
          {TOOLBAR_ITEMS.map((item) => (
            <button
              key={item.title}
              type="button"
              className={styles.toolBtn}
              title={item.title}
              onClick={() => insertText(item.before, item.after, item.placeholder)}
            >
              {item.icon}
            </button>
          ))}
          <button
            type="button"
            className={`${styles.toolBtn} ${uploading ? styles.toolBtnActive : ''}`}
            title="上传图片（也可直接粘贴/拖拽图片）"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? '⏳' : '🖼'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) uploadImage(file)
              e.target.value = ''
            }}
          />
        </div>
        <Segmented options={[...MODE_OPTIONS]} value={mode} onChange={setMode} size="sm" />
      </div>

      <div className={`${styles.panes} ${styles[`mode_${mode}`]}`}>
        {mode !== 'preview' && (
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            style={{ minHeight }}
            value={value}
            placeholder={placeholder || '支持 Markdown 语法，可粘贴或拖拽图片…'}
            onChange={(e) => onChange(e.target.value)}
            onPaste={handlePaste}
            onDrop={handleDrop}
            onDragOver={(e) => e.preventDefault()}
          />
        )}
        {mode !== 'edit' && (
          <div className={styles.preview} style={{ minHeight }}>
            {value.trim() ? (
              <Markdown>{value}</Markdown>
            ) : (
              <div className={styles.previewEmpty}>预览区域 — 开始输入即可实时预览</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
