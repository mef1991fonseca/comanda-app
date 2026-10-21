import { useEffect, useState, type FormEvent } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { isBlindFor, parseAmount, summarize, useCash, type CashSession, type Register } from '../lib/cash'
import { formatMoney } from '../lib/format'
import { TopBar } from '../components/AppShell'
import { Sheet } from '../components/Sheet'

const time = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' })
const dateTime = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

type Dialog = 'in' | 'out' | 'close' | null

export function Caja() {
  const { restaurant, role } = useCurrentRestaurant()
  const { registers, openSessions, register, session, chooseRegister, payments, moves, methods, history, loading, error, reload } =
    useCash(restaurant.id)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [closed, setClosed] = useState<CashSession | null>(null)
  const [managing, setManaging] = useState(false)
  const canOperate = ['owner', 'manager', 'cashier'].includes(role)
  const canManage = ['owner', 'manager'].includes(role)
  const blind = isBlindFor(register, role)
  const active = registers.filter((r) => r.active)

  return (
    <>
      <TopBar title="Caja" />
      <div className="content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        {closed && <CloseResult session={closed} onDismiss={() => setClosed(null)} />}

        {active.length > 1 && (
          <div className="areas register-picker" role="group" aria-label="Caja de este equipo">
            {active.map((r) => {
              const open = openSessions.some((s) => s.register_id === r.id)
              return (
                <button key={r.id} aria-pressed={r.id === register?.id} onClick={() => chooseRegister(r.id)}>
                  {r.name}
                  <span className={`register-state ${open ? 'is-open' : ''}`}>{open ? 'Abierta' : 'Cerrada'}</span>
                </button>
              )
            })}
          </div>
        )}

        {loading ? (
          <p className="muted">Cargando la caja…</p>
        ) : !register ? (
          <div className="empty">
            <h2>Este local no tiene una caja configurada</h2>
            {canManage && <button className="btn btn-primary" onClick={() => setManaging(true)}>Agregar una caja</button>}
          </div>
        ) : session ? (
          <OpenSession
            register={register}
            session={session}
            summary={summarize(session, payments, methods, moves)}
            moves={moves}
            blind={blind}
            showName={active.length > 1}
            canOperate={canOperate}
            onDialog={setDialog}
          />
        ) : (
          <OpenForm
            restaurantId={restaurant.id}
            register={register}
            showName={active.length > 1}
            canOperate={canOperate}
            onOpened={async () => {
              chooseRegister(register.id)
              await reload()
            }}
          />
        )}

        {history.length > 0 && (
          <section className="section" style={{ marginTop: 28 }}>
            <h2>Cierres anteriores{active.length > 1 && register ? ` · ${register.name}` : ''}</h2>
            <div className="list">
              {history.map((h) => {
                const diff = (h.counted_cash ?? 0) - (h.expected_cash ?? 0)
                return (
                  <div key={h.id} className="list-row">
                    <span className="product-line">
                      <span>{dateTime.format(new Date(h.closed_at ?? h.opened_at))}</span>
                      <span className="product-sub">
                        {blind ? `Contado ${formatMoney(h.counted_cash)}` : `Esperado ${formatMoney(h.expected_cash)} · contado ${formatMoney(h.counted_cash)}`}
                      </span>
                    </span>
                    {!blind && (
                      <span className={`price ${diff < 0 ? 'neg' : diff > 0 ? 'pos' : ''}`}>
                        {diff === 0 ? 'Sin diferencia' : `${diff > 0 ? '+' : ''}${formatMoney(diff)}`}
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {canManage && register && (
          <div className="toolbar" style={{ marginTop: 20 }}>
            <button className="btn btn-quiet" onClick={() => setManaging(true)}>Administrar cajas</button>
          </div>
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
          expected={blind ? null : summarize(session, payments, methods, moves).expectedCash}
          onClose={() => setDialog(null)}
          onClosed={async (s) => {
            setClosed(s)
            setDialog(null)
            await reload()
          }}
        />
      )}
      {managing && (
        <RegistersSheet
          restaurantId={restaurant.id}
          registers={registers}
          openIds={new Set(openSessions.map((s) => s.register_id))}
          onClose={() => setManaging(false)}
          onChanged={reload}
        />
      )}
    </>
  )
}

function OpenForm({
  restaurantId,
  register,
  showName,
  canOperate,
  onOpened,
}: {
  restaurantId: string
  register: Register
  showName: boolean
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
      .insert({ restaurant_id: restaurantId, register_id: register.id, opening_amount: value })
    if (error) {
      setError(errorMessage(error))
      setBusy(false)
      return
    }
    await onOpened()
  }

  return (
    <div className="empty">
      <h2>{showName ? `${register.name} está cerrada` : 'La caja está cerrada'}</h2>
      {canOperate ? (
        <form className="form" onSubmit={submit}>
          <p className="muted">Contá el efectivo con el que arranca el turno y abrí la caja para empezar a cobrar.</p>
          <div className="field">
            <label htmlFor="opening">Efectivo inicial</label>
            <input id="opening" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </div>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <button className="btn btn-primary" disabled={busy}>{showName ? `Abrir ${register.name}` : 'Abrir caja'}</button>
        </form>
      ) : (
        <p className="muted">Pedile a un cajero o al encargado que abra la caja. Mientras tanto se puede cobrar con tarjeta o transferencia.</p>
      )}
    </div>
  )
}

function OpenSession({
  register,
  session,
  summary,
  moves,
  blind,
  showName,
  canOperate,
  onDialog,
}: {
  register: Register
  session: CashSession
  blind: boolean
  showName: boolean
  summary: ReturnType<typeof summarize>
  moves: { id: string; kind: string; amount: number; reason: string | null; created_at: string }[]
  canOperate: boolean
  onDialog: (d: Dialog) => void
}) {
  return (
    <>
      <p className="muted" style={{ marginBottom: 12 }}>
        {showName ? `${register.name} · ` : ''}Abierta desde las {time.format(new Date(session.opened_at))}
      </p>

      <div className="cash-grid">
        {blind ? (
          <div className="ticket cash-expected">
            <span className="muted">Arqueo ciego</span>
            <p style={{ margin: 0 }}>Al cerrar, contá el efectivo y cargalo. El encargado ve si hay diferencia.</p>
            <div className="ticket-row"><span>Apertura</span><span>{formatMoney(session.opening_amount)}</span></div>
          </div>
        ) : (
        <div className="ticket cash-expected">
          <span className="muted">Efectivo que debería haber</span>
          <span className="cash-big">{formatMoney(summary.expectedCash)}</span>
          <div className="ticket-row"><span>Apertura</span><span>{formatMoney(session.opening_amount)}</span></div>
          <div className="ticket-row"><span>Cobros en efectivo</span><span>{formatMoney(summary.cashSales)}</span></div>
          {summary.cashTips > 0 && <div className="ticket-row"><span>Propinas en efectivo</span><span>{formatMoney(summary.cashTips)}</span></div>}
          {summary.movesIn > 0 && <div className="ticket-row"><span>Ingresos</span><span>+{formatMoney(summary.movesIn)}</span></div>}
          {summary.movesOut > 0 && <div className="ticket-row"><span>Retiros</span><span>−{formatMoney(summary.movesOut)}</span></div>}
        </div>
        )}

        <div className="cash-side">
          <section className="section">
            <h2>{blind ? 'Cobros del turno sin efectivo' : `Ventas del turno · ${formatMoney(summary.totalSales)}`}</h2>
            {(blind ? summary.byMethod.filter((m) => m.method.kind !== 'cash') : summary.byMethod).length === 0 ? (
              <p className="muted">Todavía no hay cobros en este turno.</p>
            ) : (
              <div className="list">
                {(blind ? summary.byMethod.filter((m) => m.method.kind !== 'cash') : summary.byMethod).map((m) => (
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
  /** null = arqueo ciego */
  expected: number | null
  onClose: () => void
  onClosed: (s: CashSession) => Promise<void>
}) {
  const [counted, setCounted] = useState('')
  const [notes, setNotes] = useState('')
  const [openOrders, setOpenOrders] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const value = parseAmount(counted)
  const diff = expected !== null && Number.isFinite(value) && counted.trim() ? value - expected : null

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
          <span className="hint muted">
            {expected === null ? 'Contá billetes y monedas. Una vez cerrada, la caja no se puede reabrir.' : 'La diferencia con lo esperado se calcula sola.'}
          </span>
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
  if (session.expected_cash === null) {
    return (
      <div className="notice notice-info" role="status" style={{ marginBottom: 16 }}>
        Caja cerrada. Contado {formatMoney(session.counted_cash)}. El encargado ve si hay diferencia.{' '}
        <button className="link-btn" onClick={onDismiss}>Listo</button>
      </div>
    )
  }
  const diff = (session.counted_cash ?? 0) - session.expected_cash
  return (
    <div className={`notice ${diff === 0 ? 'notice-info' : 'notice-error'}`} role="status" style={{ marginBottom: 16 }}>
      Caja cerrada. Esperado {formatMoney(session.expected_cash)}, contado {formatMoney(session.counted_cash)}
      {diff === 0 ? ': sin diferencia.' : `: diferencia de ${formatMoney(diff)}.`}{' '}
      <button className="link-btn" onClick={onDismiss}>Listo</button>
    </div>
  )
}

/** Alta, nombre, arqueo ciego y baja de las cajas del local (dueño o encargado). */
function RegistersSheet({
  restaurantId,
  registers,
  openIds,
  onClose,
  onChanged,
}: {
  restaurantId: string
  registers: Register[]
  openIds: Set<string>
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(fn: () => PromiseLike<{ error: unknown }>) {
    setBusy(true)
    setError(null)
    const { error } = await fn()
    if (error) setError(errorMessage(error))
    await onChanged()
    setBusy(false)
    return !error
  }

  async function add(e: FormEvent) {
    e.preventDefault()
    if (!name.trim()) return setError('Poné un nombre, por ejemplo Barra.')
    if (await run(() => supabase.from('registers').insert({ restaurant_id: restaurantId, name: name.trim() }))) setName('')
  }

  return (
    <Sheet title="Cajas del local" onClose={onClose}>
      <div className="form">
        <div className="list">
          {registers.map((r) => (
            <RegisterRow key={r.id} register={r} open={openIds.has(r.id)} busy={busy} run={run} />
          ))}
        </div>
        <form className="form" onSubmit={add}>
          <div className="field">
            <label htmlFor="new-register">Nueva caja</label>
            <input id="new-register" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Barra, Delivery" />
          </div>
          <button className="btn btn-quiet" disabled={busy}>Agregar caja</button>
        </form>
        <p className="hint muted">
          Cada equipo elige con qué caja cobra arriba de la pantalla Caja. Con arqueo ciego, el cajero cierra sin ver cuánto
          debería haber; vos ves la diferencia.
        </p>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>Listo</button>
        </div>
      </div>
    </Sheet>
  )
}

function RegisterRow({
  register: r,
  open,
  busy,
  run,
}: {
  register: Register
  open: boolean
  busy: boolean
  run: (fn: () => PromiseLike<{ error: unknown }>) => Promise<boolean>
}) {
  const [name, setName] = useState(r.name)
  const update = (patch: Partial<Register>) => run(() => supabase.from('registers').update(patch).eq('id', r.id))
  return (
    <div className={`register-row ${r.active ? '' : 'is-off'}`}>
      <div className="field">
        <label htmlFor={`reg-${r.id}`}>Nombre{open ? ' · abierta' : ''}{r.active ? '' : ' · desactivada'}</label>
        <input
          id={`reg-${r.id}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (name.trim() && name.trim() !== r.name) void update({ name: name.trim() })
          }}
        />
      </div>
      <label className="check">
        <input type="checkbox" checked={r.blind_close} disabled={busy} onChange={(e) => void update({ blind_close: e.target.checked })} />
        <span>Arqueo ciego en {r.name}</span>
      </label>
      <button className="btn btn-quiet" disabled={busy} onClick={() => void update({ active: !r.active })}>
        {r.active ? `Desactivar ${r.name}` : `Activar ${r.name}`}
      </button>
    </div>
  )
}
