import type { JSX } from 'react'

// Small, consistent inline-SVG icon set (16px grid, 1.6 stroke, currentColor)
// so glyphs match across platforms instead of relying on emoji.
export type IconName =
  | 'settings'
  | 'close'
  | 'search'
  | 'plus'
  | 'branch'
  | 'diff'
  | 'undo'
  | 'chevronLeft'
  | 'chevronRight'
  | 'tidy'
  | 'command'
  | 'merge'
  | 'stop'
  | 'send'
  | 'external'
  | 'collapse'
  | 'expand'
  | 'check'
  | 'alert'
  | 'trash'

const PATHS: Record<IconName, JSX.Element> = {
  settings: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.5v1.7M8 12.8v1.7M14.5 8h-1.7M3.2 8H1.5M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2M12.6 12.6l-1.2-1.2M4.6 4.6 3.4 3.4" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.2" />
      <path d="M10.4 10.4L14 14" />
    </>
  ),
  plus: <path d="M8 3.2v9.6M3.2 8h9.6" />,
  branch: (
    <>
      <circle cx="4.5" cy="4" r="1.6" />
      <circle cx="4.5" cy="12" r="1.6" />
      <circle cx="11.5" cy="6" r="1.6" />
      <path d="M4.5 5.6v4.8M4.5 8h3.4c1.7 0 3.1-1 3.1-2" />
    </>
  ),
  diff: (
    <>
      <path d="M8 2.5v4M6 4.5h4" />
      <path d="M6 11.5h4" />
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" />
    </>
  ),
  undo: <path d="M6 4L3 7l3 3M3 7h6.5A3.5 3.5 0 0 1 13 10.5v0A3.5 3.5 0 0 1 9.5 14H6" />,
  chevronLeft: <path d="M10 3.5L5.5 8l4.5 4.5" />,
  chevronRight: <path d="M6 3.5L10.5 8 6 12.5" />,
  tidy: (
    <>
      <rect x="2" y="6" width="4" height="4" rx="1" />
      <rect x="10" y="2.5" width="4" height="3.5" rx="1" />
      <rect x="10" y="10" width="4" height="3.5" rx="1" />
      <path d="M6 8h2M8 8V4.2h2M8 8v3.8h2" />
    </>
  ),
  command: <path d="M5.5 2.5a2 2 0 1 0 2 2v7a2 2 0 1 0 2-2h-4a2 2 0 1 0 2 2v-7a2 2 0 1 0-2-2z" />,
  merge: (
    <>
      <circle cx="4.5" cy="4" r="1.6" />
      <circle cx="4.5" cy="12" r="1.6" />
      <circle cx="11.5" cy="9" r="1.6" />
      <path d="M4.5 5.6v4.8M4.5 8c0 2 1.4 3 3.1 3h2.3" />
    </>
  ),
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" />,
  send: <path d="M2.5 8h9M8 4.5L11.5 8 8 11.5" />,
  external: (
    <>
      <path d="M9 3.5h3.5V7" />
      <path d="M12.5 3.5L7 9" />
      <path d="M11 9v3.5H3.5V5H7" />
    </>
  ),
  collapse: <path d="M3 8h10M8 3v10M5.5 5.5L8 8l2.5-2.5M5.5 10.5L8 8l2.5 2.5" />,
  expand: <path d="M3 8h10M8 3v10" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  alert: (
    <>
      <path d="M8 2.5L14.5 13.5H1.5L8 2.5z" />
      <path d="M8 6.5v3M8 11.4v.1" />
    </>
  ),
  trash: <path d="M3.5 4.5h9M6 4.5V3h4v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5" />
}

export default function Icon(props: {
  name: IconName
  size?: number
  className?: string
}): JSX.Element {
  const s = props.size ?? 15
  return (
    <svg
      className={props.className}
      width={s}
      height={s}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[props.name]}
    </svg>
  )
}
