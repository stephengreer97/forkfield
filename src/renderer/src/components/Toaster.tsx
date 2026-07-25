import { useEffect } from 'react'
import type { JSX } from 'react'
import { useStore, type Toast } from '../store'
import Icon, { type IconName } from './Icon'

const ICON: Record<Toast['kind'], IconName> = {
  info: 'command',
  warn: 'alert',
  success: 'check'
}

function ToastRow(props: { toast: Toast }): JSX.Element {
  const dismiss = useStore((s) => s.dismissToast)
  const t = props.toast
  useEffect(() => {
    const ms = t.duration ?? 6000
    const timer = window.setTimeout(() => dismiss(t.id), ms)
    return () => window.clearTimeout(timer)
  }, [t.id, t.duration, dismiss])

  return (
    <div className={`toast toast-${t.kind}`} role="status">
      <span className="toast-icon">
        <Icon name={ICON[t.kind]} size={15} />
      </span>
      <span className="toast-msg">{t.message}</span>
      {t.actionLabel && t.onAction && (
        <button
          className="toast-action"
          onClick={() => {
            t.onAction?.()
            dismiss(t.id)
          }}
        >
          {t.actionLabel}
        </button>
      )}
      <button className="toast-close" title="Dismiss" onClick={() => dismiss(t.id)}>
        <Icon name="close" size={13} />
      </button>
    </div>
  )
}

export default function Toaster(): JSX.Element {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toaster">
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} />
      ))}
    </div>
  )
}
