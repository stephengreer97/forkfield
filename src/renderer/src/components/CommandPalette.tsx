import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import Icon, { type IconName } from './Icon'

export interface PaletteItem {
  id: string
  label: string
  hint?: string
  icon?: IconName
  run: () => void
}

// Subsequence fuzzy match: returns a score (lower is better) or null if the
// query characters don't all appear in order.
function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let ti = 0
  let score = 0
  let lastMatch = -1
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi]
    const found = t.indexOf(c, ti)
    if (found === -1) return null
    if (lastMatch !== -1) score += found - lastMatch - 1
    if (found === 0 || t[found - 1] === ' ' || t[found - 1] === '/') score -= 2
    lastMatch = found
    ti = found + 1
  }
  return score + (t.length - q.length) * 0.05
}

export default function CommandPalette(props: {
  items: PaletteItem[]
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [sel, setSel] = useState(0)

  const filtered = useMemo(() => {
    const scored: { item: PaletteItem; score: number }[] = []
    for (const item of props.items) {
      const s = fuzzyScore(query, item.label + ' ' + (item.hint ?? ''))
      if (s !== null) scored.push({ item, score: s })
    }
    scored.sort((a, b) => a.score - b.score)
    return scored.map((s) => s.item).slice(0, 40)
  }, [props.items, query])

  const clampedSel = Math.min(sel, Math.max(0, filtered.length - 1))

  function choose(item: PaletteItem | undefined): void {
    if (!item) return
    props.onClose()
    item.run()
  }

  return (
    <div
      className="confirm-backdrop palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div className="palette">
        <div className="palette-input-row">
          <Icon name="search" size={16} />
          <input
            className="palette-input"
            autoFocus
            placeholder="Type a command or search nodes…"
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
          {filtered.length === 0 && <div className="palette-empty">No matches</div>}
          {filtered.map((item, i) => (
            <button
              key={item.id}
              className={`palette-item${i === clampedSel ? ' active' : ''}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(item)}
            >
              <span className="palette-item-icon">
                {item.icon && <Icon name={item.icon} size={15} />}
              </span>
              <span className="palette-item-label">{item.label}</span>
              {item.hint && <span className="palette-item-hint">{item.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
