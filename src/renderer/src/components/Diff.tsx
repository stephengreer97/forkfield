import type { JSX } from 'react'

export type LineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'gap'

export interface DiffLine {
  kind: LineKind
  text: string
  // Line numbers, when we know them (unified patches). Absent for edits, where
  // we only have the before/after strings and not their place in the file.
  oldNum?: number
  newNum?: number
}

export interface DiffFile {
  path: string
  status: 'new' | 'deleted' | 'renamed' | 'modified'
  lines: DiffLine[]
  added: number
  removed: number
}

// --- unified patch parsing -------------------------------------------------

// Split a `git diff` patch into per-file sections with classified lines.
export function parsePatch(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let oldNum = 0
  let newNum = 0

  const raw = patch.split('\n')
  for (let n = 0; n < raw.length; n++) {
    const line = raw[n]
    if (line.startsWith('diff --git ')) {
      file = { path: filePathFromHeader(line), status: 'modified', lines: [], added: 0, removed: 0 }
      files.push(file)
      continue
    }
    if (!file) continue
    if (line.startsWith('new file mode')) {
      file.status = 'new'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'deleted'
      continue
    }
    if (line.startsWith('rename to ')) {
      file.status = 'renamed'
      file.path = line.slice('rename to '.length)
      continue
    }
    if (line.startsWith('+++ b/')) {
      file.path = line.slice('+++ b/'.length)
      continue
    }
    // Remaining headers carry nothing worth showing.
    if (
      line.startsWith('index ') ||
      line.startsWith('--- ') ||
      line.startsWith('+++ ') ||
      line.startsWith('old mode') ||
      line.startsWith('new mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from ') ||
      line.startsWith('\\ No newline')
    ) {
      continue
    }
    if (line.startsWith('Binary files')) {
      file.lines.push({ kind: 'gap', text: 'Binary file' })
      continue
    }
    if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/)
      if (m) {
        oldNum = Number(m[1])
        newNum = Number(m[2])
        if (file.lines.length) file.lines.push({ kind: 'gap', text: m[3].trim() })
      }
      continue
    }
    if (line.startsWith('+')) {
      file.lines.push({ kind: 'add', text: line.slice(1), newNum })
      file.added++
      newNum++
      continue
    }
    if (line.startsWith('-')) {
      file.lines.push({ kind: 'del', text: line.slice(1), oldNum })
      file.removed++
      oldNum++
      continue
    }
    // A blank line is context whose trailing space was stripped — except the
    // last one, which is just the patch's trailing newline.
    if (line.startsWith(' ') || (line === '' && n < raw.length - 1)) {
      file.lines.push({ kind: 'ctx', text: line.slice(1), oldNum, newNum })
      oldNum++
      newNum++
    }
  }
  return files
}

// "diff --git a/src/x.ts b/src/x.ts" -> "src/x.ts". Falls back to the raw tail
// for paths with spaces, which the +++ line fixes up later anyway.
function filePathFromHeader(line: string): string {
  const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/)
  return m ? m[2] : line.slice('diff --git '.length)
}

// --- line diffing ----------------------------------------------------------

// Longest-common-subsequence diff over lines, the same shape git produces.
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n')
  const b = after === '' ? [] : after.split('\n')
  // The table is O(n*m); past this size fall back to a whole-block replace.
  if (a.length * b.length > 400_000) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'del', text })),
      ...b.map((text): DiffLine => ({ kind: 'add', text }))
    ]
  }

  const w = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * w)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * w + j] =
        a[i] === b[j]
          ? lcs[(i + 1) * w + j + 1] + 1
          : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] })
      i++
      j++
    } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) {
      out.push({ kind: 'del', text: a[i++] })
    } else {
      out.push({ kind: 'add', text: b[j++] })
    }
  }
  while (i < a.length) out.push({ kind: 'del', text: a[i++] })
  while (j < b.length) out.push({ kind: 'add', text: b[j++] })
  return out
}

// Collapse long stretches of untouched lines down to a little context on each
// side, so an edit inside a big block stays readable.
export function collapseContext(lines: DiffLine[], keep = 3): DiffLine[] {
  const out: DiffLine[] = []
  let run: DiffLine[] = []
  const flush = (atEnd: boolean): void => {
    if (run.length <= keep * 2 + 1) {
      out.push(...run)
    } else if (out.length === 0) {
      // Leading run: only the tail is useful context.
      out.push({ kind: 'gap', text: `${run.length - keep} unchanged lines` }, ...run.slice(-keep))
    } else if (atEnd) {
      out.push(...run.slice(0, keep), { kind: 'gap', text: `${run.length - keep} unchanged lines` })
    } else {
      out.push(
        ...run.slice(0, keep),
        { kind: 'gap', text: `${run.length - keep * 2} unchanged lines` },
        ...run.slice(-keep)
      )
    }
    run = []
  }
  for (const l of lines) {
    if (l.kind === 'ctx') run.push(l)
    else {
      flush(false)
      out.push(l)
    }
  }
  flush(true)
  return out
}

// --- rendering -------------------------------------------------------------

function DiffLines(props: { lines: DiffLine[]; numbers: boolean }): JSX.Element {
  return (
    <div className={`dl-body${props.numbers ? ' numbered' : ''}`}>
      {props.lines.map((l, i) => {
        if (l.kind === 'gap') {
          return (
            <div key={i} className="dl dl-gap">
              {props.numbers && <span className="dl-num" />}
              <span className="dl-mark" />
              <span className="dl-text">{l.text || '⋯'}</span>
            </div>
          )
        }
        return (
          <div key={i} className={`dl dl-${l.kind}`}>
            {props.numbers && (
              <span className="dl-num">{l.kind === 'del' ? l.oldNum : l.newNum}</span>
            )}
            <span className="dl-mark">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            <span className="dl-text">{l.text || '​'}</span>
          </div>
        )
      })}
    </div>
  )
}

export function DiffStat(props: { added: number; removed: number }): JSX.Element {
  return (
    <span className="diff-stat">
      {props.added > 0 && <span className="stat-add">+{props.added}</span>}
      {props.removed > 0 && <span className="stat-del">−{props.removed}</span>}
      {props.added === 0 && props.removed === 0 && <span className="stat-none">no changes</span>}
    </span>
  )
}

// A full `git diff` patch, grouped by file.
export function PatchView(props: { patch: string }): JSX.Element {
  const files = parsePatch(props.patch)
  if (files.length === 0) return <pre className="diff-plain">{props.patch}</pre>
  return (
    <div className="patch">
      {files.map((f) => (
        <div key={f.path} className="patch-file">
          <div className="patch-file-head">
            <span className="patch-path">{f.path}</span>
            {f.status !== 'modified' && <span className="patch-badge">{f.status}</span>}
            <DiffStat added={f.added} removed={f.removed} />
          </div>
          <DiffLines lines={f.lines} numbers />
        </div>
      ))}
    </div>
  )
}

// --- file-edit tool calls --------------------------------------------------

export interface FileEdit {
  path: string
  lines: DiffLine[]
  added: number
  removed: number
}

// Turn an Edit/Write/MultiEdit/NotebookEdit tool input into diff lines, or null
// when it isn't one of those (or the input isn't the shape we expect).
export function toolEdit(toolName: string | undefined, input: unknown): FileEdit | null {
  if (!toolName || typeof input !== 'object' || input === null) return null
  const o = input as Record<string, unknown>
  const path = str(o.file_path) ?? str(o.notebook_path) ?? str(o.path)
  if (!path) return null

  let lines: DiffLine[] | null = null
  if (toolName === 'Write' && typeof o.content === 'string') {
    lines = o.content.split('\n').map((text) => ({ kind: 'add' as const, text }))
  } else if (typeof o.old_string === 'string' && typeof o.new_string === 'string') {
    lines = collapseContext(lineDiff(o.old_string, o.new_string))
  } else if (Array.isArray(o.edits)) {
    lines = []
    for (const raw of o.edits) {
      const e = raw as Record<string, unknown>
      if (typeof e?.old_string !== 'string' || typeof e?.new_string !== 'string') continue
      if (lines.length) lines.push({ kind: 'gap', text: '' })
      lines.push(...collapseContext(lineDiff(e.old_string, e.new_string)))
    }
  } else if (typeof o.new_source === 'string') {
    lines = collapseContext(lineDiff(str(o.old_source) ?? '', o.new_source))
  }
  if (!lines) return null

  return {
    path,
    lines,
    added: lines.filter((l) => l.kind === 'add').length,
    removed: lines.filter((l) => l.kind === 'del').length
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

// The +/- view of a single file-editing tool call, shown inline in a transcript.
export function EditView(props: { edit: FileEdit }): JSX.Element {
  return (
    <div className="edit-diff">
      <div className="edit-diff-head">
        <span className="patch-path">{shortPath(props.edit.path)}</span>
        <DiffStat added={props.edit.added} removed={props.edit.removed} />
      </div>
      <DiffLines lines={props.edit.lines} numbers={false} />
    </div>
  )
}

// Absolute paths eat the whole header; keep the last couple of segments.
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length <= 3 ? path : '…/' + parts.slice(-3).join('/')
}
