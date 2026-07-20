export function preprocessMarkdown(text: string) {
  return convertHtmlTablesToMarkdown(text)
    .replace(/\\\[((?:.|\n)*?)\\\]/g, '\n$$\n$1\n$$\n')
    .replace(
      /\\begin\{([a-zA-Z*]+)\}[\s\S]*?\\end\{\1\}(?:\s*\\tag\{[^}]+\})?/g,
      (match, _env, offset: number, source: string) => {
        const before = source.slice(Math.max(0, offset - 3), offset)
        const after = source.slice(offset + match.length, offset + match.length + 3)
        if (before.includes('$$') || after.includes('$$')) {
          return match
        }
        return `\n$$\n${String(match).trim()}\n$$\n`
      },
    )
    .replace(/\\\((.+?)\\\)/g, (_, expr) => `$${String(expr).trim()}$`)
}

function convertHtmlTablesToMarkdown(text: string) {
  return (text || '').replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (tableHtml) => {
    const rows = Array.from(tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi))
      .map((rowMatch) => (
        Array.from(rowMatch[1].matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi))
          .map((cellMatch) => normalizeHtmlTableCell(cellMatch[2]))
      ))
      .filter((row) => row.length > 0)

    if (!rows.length) {
      return tableHtml
    }

    const columnCount = Math.max(...rows.map((row) => row.length))
    const paddedRows = rows.map((row) => [
      ...row,
      ...Array.from({ length: columnCount - row.length }, () => ''),
    ])
    const renderRow = (row: string[]) => `| ${row.map(escapeMarkdownTableCell).join(' | ')} |`
    const separator = `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`

    return `\n\n${[renderRow(paddedRows[0]), separator, ...paddedRows.slice(1).map(renderRow)].join('\n')}\n\n`
  })
}

function normalizeHtmlTableCell(cellHtml: string) {
  return decodeHtmlEntities(
    cellHtml
      .replace(/<br\s*\/?>/gi, ' / ')
      .replace(/<\/p>\s*<p\b[^>]*>/gi, ' / ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

function decodeHtmlEntities(text: string) {
  return text
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function escapeMarkdownTableCell(text: string) {
  return (text || ' ')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ')
}
