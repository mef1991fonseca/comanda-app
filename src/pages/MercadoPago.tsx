import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useCurrentRestaurant } from '../lib/restaurant'
import { mpConnect, mpDisconnect, mpStatus, type MpStatus } from '../lib/mercadopago'
import { TopBar } from '../components/AppShell'

const dateFmt = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'long', year: 'numeric' })

/** Vincular la cuenta de Mercado Pago del local: los cobros con QR se acreditan ahí. */
export function MercadoPago() {
  const { restaurant, role } = useCurrentRestaurant()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [status, setStatus] = useState<MpStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const result = params.get('mp')
  const reason = params.get('motivo')

  const load = useCallback(async () => {
    const { data, error } = await mpStatus(restaurant.id)
    setStatus(data)
    if (error) setError(error)
  }, [restaurant.id])

  useEffect(() => {
    void load()
  }, [load])

  async function connect() {
    setBusy(true)
    setError(null)
    const { data, error } = await mpConnect(restaurant.id)
    if (error || !data) {
      setBusy(false)
      return setError(error ?? 'No se pudo iniciar la vinculación.')
    }
    // Se va a Mercado Pago y vuelve a esta pantalla
    window.location.assign(data.url)
  }

  async function disconnect() {
    setBusy(true)
    setError(null)
    const { error } = await mpDisconnect(restaurant.id)
    setBusy(false)
    setConfirming(false)
    if (error) return setError(error)
    setParams({}, { replace: true })
    await load()
  }

  return (
    <>
      <TopBar title="Mercado Pago" />
      <div className="content form">
        {result === 'conectado' && (
          <div className="notice notice-info" role="status">
            Listo: la cuenta quedó vinculada. Los cobros con QR se acreditan en tu cuenta de Mercado Pago.
          </div>
        )}
        {result === 'error' && (
          <div className="notice notice-error" role="alert">
            No se pudo vincular la cuenta. {reason ?? ''}
          </div>
        )}
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        {!status ? (
          !error && <p className="muted">Revisando la cuenta…</p>
        ) : status.own ? (
          <section className="section">
            <h2>Cuenta vinculada</h2>
            <div className="ticket">
              <div className="ticket-row"><span>Cuenta</span><span>{status.nickname ?? 'Mercado Pago'}</span></div>
              {status.test && <div className="ticket-row"><span>Tipo</span><span>De prueba</span></div>}
              {status.expires_at && (
                <div className="ticket-row">
                  <span>Se renueva sola antes del</span>
                  <span>{dateFmt.format(new Date(status.expires_at))}</span>
                </div>
              )}
            </div>
            <p className="muted">
              Cada cobro con QR de este local se acredita en esta cuenta. Comandá no ve tu dinero ni tus datos de acceso.
            </p>
            {role === 'owner' &&
              (confirming ? (
                <div className="notice notice-warn">
                  <p style={{ margin: '0 0 10px' }}>
                    Si la desvinculás, los QR vuelven a cobrarse en la cuenta general de Comandá hasta que vincules otra.
                  </p>
                  <div className="sheet-actions">
                    <button className="btn btn-primary" disabled={busy} onClick={() => void disconnect()}>Desvincular</button>
                    <button className="btn btn-quiet" onClick={() => setConfirming(false)}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <div className="sheet-actions">
                  <button className="btn btn-quiet" onClick={() => setConfirming(true)}>Desvincular cuenta</button>
                  <button className="btn btn-quiet" disabled={busy} onClick={() => void connect()}>Vincular otra cuenta</button>
                </div>
              ))}
          </section>
        ) : (
          <section className="section">
            <h2>Cobrá con QR en tu propia cuenta</h2>
            <p className="muted">
              {status.connected
                ? 'Hoy los QR de este local cobran en la cuenta general de Comandá'
                : 'Este local todavía no tiene una cuenta de Mercado Pago'}
              {status.connected && status.test ? ', que es de prueba: no mueve dinero real.' : '.'} Vinculá la cuenta de Mercado
              Pago del local y cada cobro se acredita ahí.
            </p>
            <ol className="steps-list">
              <li>Tocá «Vincular mi cuenta». Se abre Mercado Pago.</li>
              <li>Entrá con la cuenta del local (la que recibe los pagos) y aceptá los permisos.</li>
              <li>Volvés acá con la cuenta vinculada.</li>
            </ol>
            {status.oauth_ready ? (
              <div className="sheet-actions">
                <button className="btn btn-primary" disabled={busy} onClick={() => void connect()}>
                  {busy ? 'Abriendo Mercado Pago…' : 'Vincular mi cuenta de Mercado Pago'}
                </button>
              </div>
            ) : (
              <div className="notice notice-warn">
                La vinculación todavía no está habilitada en el servidor. Mientras tanto los QR siguen funcionando con la
                cuenta general.
              </div>
            )}
          </section>
        )}

        <div className="sheet-actions">
          <button className="btn btn-quiet" onClick={() => navigate('/mas')}>Volver a Más</button>
        </div>
      </div>
    </>
  )
}
