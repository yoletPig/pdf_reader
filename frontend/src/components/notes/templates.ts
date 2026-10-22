/**
 * 笔记模板 - 新建笔记时可选的 Markdown 模板
 */
export interface NoteTemplate {
  id: string
  name: string
  icon: string
  description: string
  content: string
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: 'blank',
    name: '空白笔记',
    icon: '📄',
    description: '从零开始自由记录',
    content: '',
  },
  {
    id: 'reading',
    name: '读书笔记',
    icon: '📖',
    description: '书籍/章节阅读记录与感想',
    content: `# 读书笔记：《书名》

> 📅 {{date}} · 章节：第 X 章

## 核心观点

- 
- 

## 精彩摘录

> 

## 我的思考

- 

## 行动清单

- [ ] 
`,
  },
  {
    id: 'paper',
    name: '文献精读',
    icon: '📄',
    description: '论文精读：问题、方法、结论',
    content: `# 文献精读：论文标题

> 📅 {{date}} · 来源：
> 作者：

## 研究问题

这篇论文要解决什么问题？

## 方法与创新

- **核心方法**：
- **创新点**：

## 实验与结论

| 对比项 | 内容 |
| --- | --- |
| 数据集 |  |
| 基线 |  |
| 结果 |  |

## 评价与启发

- **优点**：
- **局限**：
- **对我的启发**：

## 关键摘录

> 
`,
  },
  {
    id: 'meeting',
    name: '会议记录',
    icon: '🗓',
    description: '组会/讨论记录与待办',
    content: `# 会议记录：主题

> 📅 {{date}} · 参与人：

## 议题

1. 

## 讨论要点

- 

## 结论

- 

## 待办事项

- [ ] 
`,
  },
  {
    id: 'ideas',
    name: '灵感速记',
    icon: '💡',
    description: '快速捕捉想法与灵感',
    content: `# 💡 灵感：一句话概括

> 📅 {{date}}

## 想法

 

## 为什么值得做

- 

## 下一步

- [ ] 
`,
  },
]

/** 渲染模板：替换 {{date}} 等占位符 */
export function renderTemplate(template: NoteTemplate): string {
  return template.content.replace(/\{\{date\}\}/g, new Date().toLocaleDateString('zh-CN'))
}
