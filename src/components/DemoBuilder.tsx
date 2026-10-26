import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { buildDemo, deleteDemo, type DemoProgress } from '../lib/demo'
import { useRestaurant } from '../lib/restaurant'

/** Botón que crea el local de demostración, con barra de avance, y entra a él. */
export function DemoBuilder({ variant = 'row' }: { variant?: 'row' | 'block' }) {
  const { select, reload } = useRestaurant()
  const navigate = useNavigate()
  const [progress, setProgress] = useState<DemoProgress | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function start() {
    setError(null)
    const { id, error } = await buildDemo(setProgress)
    if (error) {
      setProgress(null)
      // Si quedó a medias, se borra para poder intentar de nuevo
      if (id) await deleteDemo(id)
      return setError(error)
    }
    if (!id) return
    await reload()
    select(id)
    navigate('/inicio', { replace: true })
  }

  if (progress) {
    const pct = Math.round((progress.step / progress.total) * 100)
    return (
      <div className="demo-progress" role="status" aria-live="polite">
        <span>{progress.label}</span>
        <div className="demo-bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Avance">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>
    )
  }

  return (
    <>
      {variant === 'row' ? (
        <button className="list-row" onClick={() => void start()}>
          <span className="product-line">
            <span style={{ color: 'var(--bottle)', fontWeight: 600 }}>Crear local de demostración</span>
            <span className="product-sub">Un bodegón con carta, ventas de las últimas semanas y mesas ocupadas, para mostrar la app</span>
          </span>
        </button>
      ) : (
        <button type="button" className="btn btn-quiet btn-block" onClick={() => void start()}>
          Probar con un local de demostración
        </button>
      )}
      {error && <div className="notice notice-error" role="alert">No se pudo armar la demo: {error}</div>}
    </>
  )
}
