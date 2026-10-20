import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { clearPendingInvite, type InvitePreview } from '../lib/invites'
import { useRestaurant } from '../lib/restaurant'
import { roleLabel } from '../lib/format'

const statusText: Record<Exclude<InvitePreview['status'], 'ok' | 'member'>, string> = {
  used: 'Esta invitación ya se usó. Pedile a quien te invitó un link nuevo.',
  expired: 'Esta invitación venció. Pedile a quien te invitó un link nuevo.',
  revoked: 'Esta invitación fue anulada. Pedile a quien te invitó un link nuevo.',
  invalid: 'El link de invitación no es válido. Revisá que esté completo.',
}

/** Pantalla para aceptar una invitación al equipo de un local. */
export function Invitacion({ token, onDone }: { token: string; onDone: () => void }) {
  const { reload, select } = useRestaurant()
  const navigate = useNavigate()
  const [preview, setPreview] = useState<InvitePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void supabase.rpc('invite_preview', { p_token: token }).then(({ data, error }) => {
      if (error) setError(errorMessage(error))
      else setPreview(data as unknown as InvitePreview)
    })
  }, [token])

  async function finish(restaurantId?: string) {
    clearPendingInvite()
    if (restaurantId) {
      await reload()
      select(restaurantId)
    }
    onDone()
    navigate('/', { replace: true })
  }

  async function accept() {
    setBusy(true)
    setError(null)
    const { data, error } = await supabase.rpc('accept_invite', { p_token: token })
    if (error) {
      setError(errorMessage(error))
      setBusy(false)
      return
    }
    await finish(data)
  }

  return (
    <main className="entry">
      <section className="entry-brand">
        <div className="wordmark">Comandá</div>
        <p>Invitación al equipo</p>
      </section>
      <section className="entry-body">
        {!preview && !error && <p className="muted">Buscando la invitación…</p>}

        {preview?.status === 'ok' && (
          <>
            <h2>Sumate a {preview.restaurant_name}</h2>
            <p>
              {preview.invited_by ? `${preview.invited_by} te invitó` : 'Te invitaron'} a{' '}
              <strong>{preview.restaurant_name}</strong> como{' '}
              <strong>{roleLabel[preview.role ?? 'waiter']?.toLowerCase()}</strong>.
            </p>
            {error && <div className="notice notice-error" role="alert">{error}</div>}
            <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void accept()}>
              Unirme al equipo
            </button>
            <button className="btn btn-quiet btn-block" disabled={busy} onClick={() => void finish()}>
              Ahora no
            </button>
          </>
        )}

        {preview?.status === 'member' && (
          <>
            <h2>Ya sos parte de {preview.restaurant_name}</h2>
            <button className="btn btn-primary btn-block" onClick={() => void finish(preview.restaurant_id)}>
              Entrar
            </button>
          </>
        )}

        {preview && preview.status !== 'ok' && preview.status !== 'member' && (
          <>
            <div className="notice notice-error" role="alert">{statusText[preview.status]}</div>
            <button className="btn btn-quiet btn-block" onClick={() => void finish()}>
              Seguir
            </button>
          </>
        )}

        {!preview && error && (
          <>
            <div className="notice notice-error" role="alert">{error}</div>
            <button className="btn btn-quiet btn-block" onClick={() => void finish()}>
              Seguir
            </button>
          </>
        )}
      </section>
    </main>
  )
}
