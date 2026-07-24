import type { JSX } from 'react'

// Lightweight markdown rendering, enough to make Claude output read like the CLI:
// code fences, inline code (accent color), bold, italic, headings, lists, links.

export function Markdown({ text }: { text: string }): JSX.Element {
  return <div className="md">{renderBlocks(text)}</div>
}

function renderBlocks(text: string): JSX.Element[] {
  const lines = text.split('\n')
  const blocks: JSX.Element[] = []
  let i = 0
  let key = 0
  let para: string[] = []

  const flushPara = (): void => {
    if (para.length) {
      blocks.push(
        <p key={key++} className="md-p">
          {renderInline(para.join('\n'))}
        </p>
      )
      para = []
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      flushPara()
      const buf: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        buf.push(lines[i])
        i++
      }
      i++ // skip closing fence
      blocks.push(
        <pre key={key++} className="md-code">
          <code>{buf.join('\n')}</code>
        </pre>
      )
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      flushPara()
      const level = heading[1].length
      blocks.push(
        <div key={key++} className={`md-h md-h${level}`}>
          {renderInline(heading[2])}
        </div>
      )
      i++
      continue
    }

    // Table: a header row followed by a separator row (|---|---|).
    if (
      /^\s*\|.*\|\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])
    ) {
      flushPara()
      const header = splitRow(line)
      const aligns = splitRow(lines[i + 1]).map(parseAlign)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(splitRow(lines[i]))
        i++
      }
      blocks.push(
        <div key={key++} className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {header.map((h, ci) => (
                  <th key={ci} style={{ textAlign: aligns[ci] ?? 'left' }}>
                    {renderInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, ci) => (
                    <td key={ci} style={{ textAlign: aligns[ci] ?? 'left' }}>
                      {renderInline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i++
      }
      blocks.push(
        <ul key={key++} className="md-ul">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ul>
      )
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      flushPara()
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      blocks.push(
        <ol key={key++} className="md-ol">
          {items.map((it, idx) => (
            <li key={idx}>{renderInline(it)}</li>
          ))}
        </ol>
      )
      continue
    }

    if (line.trim() === '') {
      flushPara()
      i++
      continue
    }

    para.push(line)
    i++
  }
  flushPara()
  return blocks
}

const INLINE_RE = /(`[^`]+`|\*\*[^*]+?\*\*|\*[^*\s][^*]*?\*|\[[^\]]+\]\([^)]+\))/g

function renderInline(text: string): (JSX.Element | string)[] {
  const out: (JSX.Element | string)[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  INLINE_RE.lastIndex = 0
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('`')) {
      out.push(
        <code key={key++} className="md-inline-code">
          {tok.slice(1, -1)}
        </code>
      )
    } else if (tok.startsWith('**')) {
      out.push(<strong key={key++}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('*')) {
      out.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    } else {
      const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
      if (link) {
        out.push(
          <span key={key++} className="md-link" title={link[2]}>
            {link[1]}
          </span>
        )
      } else {
        out.push(tok)
      }
    }
    last = m.index + tok.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return t.split('|').map((c) => c.trim())
}

function parseAlign(cell: string): 'left' | 'center' | 'right' {
  const t = cell.trim()
  const l = t.startsWith(':')
  const r = t.endsWith(':')
  if (l && r) return 'center'
  if (r) return 'right'
  return 'left'
}
