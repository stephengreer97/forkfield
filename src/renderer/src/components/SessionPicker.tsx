import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { SessionSummary } from '../../../shared/types'
import { relativeTime } from '../util'
import Icon from './Icon'

// Matches the search box against everything visible in a row, so typing a
// folder name, a branch, or a phrase from the opening prompt all work.
function haystack(s: SessionSummary): string {
  return [s.title, s.cwd, s.gitBranch, s.sessionId].filter(Boolean).join(' ').toLowerCase()
}

function projectName(cwd: string | null): string {
  if (!cwd) return 'unknown folder'
  const parts = cwd.replace(/[/\\]+$/, '').split(/[/\\]/)
  return parts[parts.length - 1] || cwd
}

export default function SessionPicker(props: {
  onPick: (session: SessionSummary) => void
  onEnterId: () => void
  onClose: () => void
}): JSX.Element {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)

  useEffect(() => {
    let live = true
    window.forkfield
      .listSessions()
      .then((s) => {
        if (live) setSessions(s)
      })
      .catch(() => {
        if (live) setSessions([])
      })
    return () => {
      live = false
    }
  }, [])

  const filtered = useMemo(() => {
    if (!sessions) return []
    const q = query.trim().toLowerCase()
    if (!q) return sessions
    return sessions.filter((s) => haystack(s).includes(q))
  }, [sessions, query])

  const clampedSel = Math.min(sel, Math.max(0, filtered.length - 1))

  function choose(s: SessionSummary | undefined): void {
    if (!s) return
    props.onClose()
    props.onPick(s)
  }

  return (
    <div
      className="confirm-backdrop palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="palette session-picker">
        <div className="palette-input-row">
          <Icon name="search" size={16} />
          <input
            className="palette-input"
            autoFocus
            placeholder="Search your Claude sessions by prompt, folder, or branch…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSel(0)
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSel((s) => Math.min(filtered.length - 1, s + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSel((s) => Math.max(0, s - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                choose(filtered[clampedSel])
              } else if (e.key === 'Escape') {
                e.preventDefault()
                props.onClose()
              }
            }}
          />
        </div>

        <div className="palette-list">
          {sessions === null && <div className="palette-empty">Reading your sessions…</div>}
          {sessions !== null && filtered.length === 0 && (
            <div className="palette-empty">
              {sessions.length === 0
                ? 'No Claude sessions found on this machine.'
                : 'No sessions match that search.'}
            </div>
          )}
          {filtered.map((s, i) => (
            <button
              key={s.sessionId}
              className={`palette-item session-item${i === clampedSel ? ' active' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(s)}
              title={s.cwd ?? s.sessionId}
            >
              <span className="session-main">
                <span className="session-title">{s.title ?? '(no opening prompt)'}</span>
                <span className="session-meta">
                  <span className="session-project">{projectName(s.cwd)}</span>
                  {s.gitBranch && (
                    <>
                      <span className="session-dot">·</span>
                      <span className="session-branch">
                        <Icon name="branch" size={11} />
                        {s.gitBranch}
                      </span>
                    </>
                  )}
                  {!s.cwdExists && (
                    <>
                      <span className="session-dot">·</span>
                      <span className="session-missing">folder missing</span>
                    </>
                  )}
                </span>
              </span>
              <span className="session-when">{relativeTime(s.updatedAt)}</span>
            </button>
          ))}
        </div>

        <div className="session-picker-footer">
          <button className="btn tiny ghost" onClick={props.onEnterId}>
            Enter a session id instead…
          </button>
        </div>
      </div>
    </div>
  )
}
