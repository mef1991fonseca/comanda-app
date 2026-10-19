import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { useRestaurant } from '../lib/restaurant'

export function Onboarding({ first = true }: { first?: boolean }) {
  const { reload, select } = useRestaurant()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [tables, setTables] = useState(10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { data, error } = await supabase.rpc('create_restaurant', { p_name: name, p_tables: tables })
    if (error || !data) {
      setError(errorMessage(error))
      setBusy(false)
      return
    }
    select(data)
    await reload()
    navigate('/salon', { replace: true })
  }

  return (
    <main className="entry">
      <section className="entry-brand">
        <div className="wordmark">{first ? 'Tu local' : 'Otro local'}</div>
        <p>Lo dejamos listo con un salón, caja, medios de pago y estaciones de cocina y barra. Después lo ajustás.</p>
      </section>

      <form className="entry-body" onSubmit={submit}>
        <div className="field">
          <label htmlFor="rname">Nombre del local</label>
          <input id="rname" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Bodegón Don Julio" />
        </div>
        <div className="field">
          <label htmlFor="rtables">Cantidad de mesas</label>
          <input
            id="rtables"
            type="number"
            inputMode="numeric"
            min={0}
            max={200}
            required
            value={tables}
            onChange={(e) => setTables(Number(e.target.value))}
          />
          <span className="hint">Podés agregar salones y mesas cuando quieras.</span>
        </div>

        {error && <div className="notice notice-error" role="alert">{error}</div>}

        <button className="btn btn-primary btn-block" disabled={busy}>
          Crear local
        </button>
        {!first && (
          <button type="button" className="btn btn-quiet btn-block" onClick={() => navigate(-1)}>
            Volver
          </button>
        )}
      </form>
    </main>
  )
}
