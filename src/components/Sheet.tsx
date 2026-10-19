import { useEffect, useId, type ReactNode } from 'react'

/** Hoja inferior modal. En tablet/PC se centra con ancho limitado. */
export function Sheet({
  title,
  aside,
  onClose,
  children,
}: {
  title: ReactNode
  aside?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const titleId = useId()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [onClose])

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <span id={titleId} className="sheet-title">{title}</span>
          {aside}
        </div>
        {children}
      </div>
    </div>
  )
}
