// Rebindable global commands. Settings stores only the overrides users change;
// everything else falls back to the defaults here.
export interface KeyCommand {
  id: string
  label: string
  default: string
}

export const KEY_COMMANDS: KeyCommand[] = [
  { id: 'commandPalette', label: 'Command palette', default: 'mod+k' },
  { id: 'newRoot', label: 'New root session', default: 'mod+shift+n' },
  { id: 'focusSearch', label: 'Search nodes', default: 'mod+f' },
  { id: 'openSettings', label: 'Open settings', default: 'mod+,' }
]

const isMac =
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent)

export function comboFor(id: string, overrides: Record<string, string>): string {
  if (overrides[id]) return overrides[id]
  return KEY_COMMANDS.find((c) => c.id === id)?.default ?? ''
}

// Normalize a keyboard event to a canonical combo string, e.g. "mod+shift+n".
// Modifier order is fixed (mod, alt, shift) so it always matches the registry.
export function eventCombo(e: KeyboardEvent): string {
  let key = e.key.toLowerCase()
  if (['control', 'meta', 'shift', 'alt'].includes(key)) return ''
  if (key === ' ') key = 'space'
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(key)
  return parts.join('+')
}

export function hasModifier(combo: string): boolean {
  return combo.startsWith('mod') || combo.includes('alt')
}

// Pretty-print a combo for display: ⌘⇧N on mac, Ctrl+Shift+N elsewhere.
export function formatCombo(combo: string): string {
  if (!combo) return '—'
  const label: Record<string, string> = {
    mod: isMac ? '⌘' : 'Ctrl',
    shift: isMac ? '⇧' : 'Shift',
    alt: isMac ? '⌥' : 'Alt',
    space: 'Space'
  }
  const sep = isMac ? '' : '+'
  return combo
    .split('+')
    .map((p) => label[p] ?? (p.length === 1 ? p.toUpperCase() : p))
    .join(sep)
}
