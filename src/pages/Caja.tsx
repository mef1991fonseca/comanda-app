import { useEffect, useState, type FormEvent } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { parseAmount, summarize, useCash, type CashSession } from '../lib/cash'
import { formatMoney } from '../lib/format'
import { TopBar } from '../components/AppShell'
import { Sheet } from '../components/Sheet'

const time = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' })
const dateTime = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

type Dialog = 'in' | 'out' | 'close' | null

export function Caja() {
  const { restaurant, role } = useCurrentRestaurant()
  const { register, session, payments, moves, methods, history, loading, error, reload } = useCash(restaurant.id)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [closed, setClosed] = useState<CashSession | null>(null)
  const canOperate = ['owner', 'manager', 'cashier'].includes(role)

  return (
    <>
      <TopBar title="Caja" />
      <div className="content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        {closed && <CloseResult session={closed} onDismiss={() => setClosed(null)} />}

        {loading ? (
          <p className="muted">Cargando la caja…</p>
        ) : !register ? (
          <div className="empty">
            <h2>Este local no tiene una caja configurada</h2>
          </div>
        ) : session ? (
          <OpenSession
            session={session}
            summary={summarize(session, payments, methods, moves)}
            moves={moves}
            canOperate={canOperate}
            onDialog={setDialog}
          />
        ) : (
          <OpenForm restaurantId={restaurant.id} registerId={register.id} canOperate={canOperate} onOpened={reload} />
        )}

        {history.length > 0 && (
          <section className="section" style={{ marginTop: 28 }}>
            <h2>Cierres anteriores</h2>
            <div className="list">
              {history.map((h) => {
                const diff = (h.counted_cash ?? 0) - (h.expected_cash ?? 0)
                return (
                  <div key={h.id} className="list-row">
                    <span className="product-line">
                      <span>{dateTime.format(new Date(h.closed_at ?? h.opened_at))}</span>
                      <span className="product-sub">
                        Esperado {formatMoney(h.expected_cash)} · contado {formatMoney(h.counted_cash)}
                      </span>
                    </span>
                    <span className={`price ${diff < 0 ? 'neg' : diff > 0 ? 'pos' : ''}`}>
                      {diff === 0 ? 'Sin diferencia' : `${diff > 0 ? '+' : ''}${formatMoney(diff)}`}
                    </span>
                  </div>
                )
              })}
            </div>
          </section>
        )}
      </div>

      {session && (dialog === 'in' || dialog === 'out') && (
        <MovementSheet
          kind={dialog}
          restaurantId={restaurant.id}
          sessionId={session.id}
          onClose={() => setDialog(null)}
          onSaved={async () => {
            await reload()
            setDialog(null)
          }}
        />
      )}
      {session && dialog === 'close' && (
        <CloseSheet
          restaurantId={restaurant.id}
          session={session}
          expected={summarize(session, payments, methods, moves).expectedCash}
          onClose={() => setDialog(null)}
          onClosed={async (s) => {
            setClosed(s)
            setDialog(null)
            await reload()
          }}
        />
      )}
    </>
  )
}

function OpenForm({
  restaurantId,
  registerId,
  canOperate,
  onOpened,
}: {
  restaurantId: string
  registerId: string
  canOperate: boolean
  onOpened: () => Promise<void>
}) {
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const value = amount.trim() ? parseAmount(amount) : 0
    if (!Number.isFinite(value) || value < 0) return setError('Ingresá el efectivo inicial, por ejemplo 20000.')
    setBusy(true)
    setError(null)
    const { error } = await supabase
      .from('cash_sessions')
      .insert({ restaurant_id: restaurantId, register_id: registerId, opening_amount: value })
    if (error) {
      setError(errorMessage(error))
      setBusy(false)
      return
    }
    await onOpened()
  }

  return (
    <div className="empty">
      <h2>La caja está cerrada</h2>
      {canOperate ? (
        <form className="form" onSubmit={submit}>
          <p className="muted">Contá el efectivo con el que arranca el turno y abrí la caja para empezar a cobrar.</p>
          <div className="field">
            <label htmlFor="opening">Efectivo inicial</label>
            <input id="opening" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <button className="btn btn-primary" disabled={busy}>Abrir caja</button>
        </form>
      ) : (
        <p className="muted">Pedile a un cajero o al encargado que abra la caja. Mientras tanto se puede cobrar con tarjeta o transferencia.</p>
      )}
    </div>
  )
}

function OpenSession({
  session,
  summary,
  moves,
  canOperate,
  onDialog,
}: {
  session: CashSession
  summary: ReturnType<typeof summarize>
  moves: { id: string; kind: string; amount: number; reason: string | null; created_at: string }[]
  canOperate: boolean
  onDialog: (d: Dialog) => void
}) {
  return (
    <>
      <p className="muted" style={{ marginBottom: 12 }}>Abierta desde las {time.format(new Date(session.opened_at))}</p>

      <div className="cash-grid">
        <div className="ticket cash-expected">
          <span className="muted">Efectivo que debería haber</span>
          <span className="cash-big">{formatMoney(summary.expectedCash)}</span>
          <div className="ticket-row"><span>Apertura</span><span>{formatMoney(session.opening_amount)}</span></div>
          <div className="ticket-row"><span>Cobros en efectivo</span><span>{formatMoney(summary.cashSales)}</span></div>
          {summary.cashTips > 0 && <div className="ticket-row"><span>Propinas en efectivo</span><span>{formatMoney(summary.cashTips)}</span></div>}
          {summary.movesIn > 0 && <div className="ticket-row"><span>Ingresos</span><span>+{formatMoney(summary.movesIn)}</span></div>}
          {summary.movesOut > 0 && <div className="ticket-row"><span>Retiros</span><span>−{formatMoney(summary.movesOut)}</span></div>}
        </div>

        <div className="cash-side">
          <section className="section">
            <h2>Ventas del turno · {formatMoney(summary.totalSales)}</h2>
            {summary.byMethod.length === 0 ? (
              <p className="muted">Todavía no hay cobros en este turno.</p>
            ) : (
              <div className="list">
                {summary.byMethod.map((m) => (
                  <div key={m.method.id} className="list-row">
                    <span className="product-line">
                      <span>{m.method.name}</span>
                      <span className="product-sub">
                        {m.count} cobro{m.count > 1 ? 's' : ''}{m.tips > 0 ? ` · propinas ${formatMoney(m.tips)}` : ''}
                      </span>
                    </span>
                    <span className="price">{formatMoney(m.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {moves.length > 0 && (
            <section className="section">
              <h2>Ingresos y retiros</h2>
              <div className="list">
                {moves.map((m) => (
                  <div key={m.id} className="list-row">
                    <span className="product-line">
                      <span>{m.reason || (m.kind === 'in' ? 'Ingreso' : 'Retiro')}</span>
                      <span className="product-sub">{time.format(new Date(m.created_at))}</span>
                    </span>
                    <span className="price">{m.kind === 'in' ? '+' : '−'}{formatMoney(m.amount)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>

      {canOperate && (
        <div className="toolbar" style={{ marginTop: 16 }}>
          <button className="btn btn-quiet" onClick={() => onDialog('in')}>Ingreso de efectivo</button>
          <button className="btn btn-quiet" onClick={() => onDialog('out')}>Retiro de efectivo</button>
          <button className="btn btn-primary" onClick={() => onDialog('close')}>Cerrar caja</button>
        </div>
      )}
    </>
  )
}

function MovementSheet({
  kind,
  restaurantId,
  sessionId,
  onClose,
  onSaved,
}: {
  kind: 'in' | 'out'
  restaurantId: string
  sessionId: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const label = kind === 'in' ? 'Ingreso de efectivo' : 'Retiro de efectivo'

  async function submit(e: FormEvent) {
    e.preventDefault()
    const value = parseAmount(amount)
    if (!Number.isFinite(value) || value <= 0) return setError('Ingresá un monto mayor a cero.')
    setBusy(true)
    const { error } = await supabase
      .from('cash_movements')
      .insert({ restaurant_id: restaurantId, cash_session_id: sessionId, kind, amount: value, reason: reason.trim() || null })
    if (error) {
      setError(errorMessage(error))
      setBusy(false)
      return
    }
    await onSaved()
  }

  return (
    <Sheet title={label} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="mv-amount">Monto</label>
          <input id="mv-amount" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="mv-reason">Motivo</label>
          <input
            id="mv-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={kind === 'in' ? 'Ej.: cambio para el turno' : 'Ej.: pago a proveedor de hielo'}
          />
        </div>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" disabled={busy}>Registrar {kind === 'in' ? 'ingreso' : 'retiro'}</button>
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Sheet>
  )
}

function CloseSheet({
  restaurantId,
  session,
  expected,
  onClose,
  onClosed,
}: {
  restaurantId: string
  session: CashSession
  expected: number
  onClose: () => void
  onClosed: (s: CashSession) => Promise<void>
}) {
  const [counted, setCounted] = useState('')
  const [notes, setNotes] = useState('')
  const [openOrders, setOpenOrders] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const value = parseAmount(counted)
  const diff = Number.isFinite(value) && counted.trim() ? value - expected : null

  useEffect(() => {
    void supabase
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('restaurant_id', restaurantId)
      .eq('status', 'open')
      .then(({ count }) => setOpenOrders(count ?? 0))
  }, [restaurantId])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (!Number.isFinite(value) || value < 0) return setError('Ingresá el efectivo que contaste.')
    setBusy(true)
    const { data, error } = await supabase.rpc('close_cash_session', {
      p_session: session.id,
      p_counted: value,
      ...(notes.trim() ? { p_notes: notes.trim() } : {}),
    })
    if (error || !data) {
      setError(errorMessage(error))
      setBusy(false)
      return
    }
    await onClosed(data)
  }

  return (
    <Sheet title="Cerrar caja" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        {openOrders > 0 && (
          <div className="notice notice-info">
            Hay {openOrders} comanda{openOrders > 1 ? 's' : ''} abierta{openOrders > 1 ? 's' : ''}. Podés cerrar la caja igual; lo que se cobre después va al próximo turno.
          </div>
        )}
        <div className="field">
          <label htmlFor="counted">Efectivo contado</label>
          <input id="counted" inputMode="decimal" required value={counted} onChange={(e) => setCounted(e.target.value)} />
          <span className="hint muted">La diferencia con lo esperado se calcula sola.</span>
        </div>
        {diff !== null && (
          <div className={`notice ${diff === 0 ? 'notice-info' : 'notice-error'}`} aria-live="polite">
            {diff === 0 ? 'Coincide con lo esperado.' : diff < 0 ? `Faltan ${formatMoney(-diff)}.` : `Sobran ${formatMoney(diff)}.`}
          </div>
        )}
        <div className="field">
          <label htmlFor="close-notes">Observaciones</label>
          <input id="close-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" disabled={busy}>Cerrar caja</button>
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Sheet>
  )
}

function CloseResult({ session, onDismiss }: { session: CashSession; onDismiss: () => void }) {
  const diff = (session.counted_cash ?? 0) - (session.expected_cash ?? 0)
  return (
    <div className={`notice ${diff === 0 ? 'notice-info' : 'notice-error'}`} role="status" style={{ marginBottom: 16 }}>
      Caja cerrada. Esperado {formatMoney(session.expected_cash)}, contado {formatMoney(session.counted_cash)}
      {diff === 0 ? ': sin diferencia.' : `: diferencia de ${formatMoney(diff)}.`}{' '}
      <button className="link-btn" onClick={onDismiss}>Listo</button>
    </div>
  )
}
