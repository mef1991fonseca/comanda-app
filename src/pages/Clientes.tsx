import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { formatMoney } from '../lib/format'
import { parseAmount, type PaymentMethod, deviceSessionId } from '../lib/cash'
import { balanceText, movementLabel, useCustomers, type Customer, type CustomerMovement } from '../lib/customers'
import { docTypeLabel, formatCuit } from '../lib/invoices'
import { TopBar } from '../components/AppShell'
import { Sheet } from '../components/Sheet'
import { CustomerForm } from '../components/CustomerForm'

/** Clientes y saldos de cuenta corriente. */
export function Clientes() {
  const { restaurant } = useCurrentRestaurant()
  const navigate = useNavigate()
  const { customers, loading, error, reload } = useCustomers(restaurant.id)
  const [query, setQuery] = useState('')
  const [onlyDebt, setOnlyDebt] = useState(false)
  const [creating, setCreating] = useState(false)

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('es')
    return customers
      .filter((c) => c.active)
      .filter((c) => !onlyDebt || c.balance > 0.009)
      .filter((c) => !q || c.name.toLocaleLowerCase('es').includes(q) || (c.doc_number ?? '').includes(q.replace(/\D/g, '') || '¬'))
  }, [customers, query, onlyDebt])

  const totalDebt = customers.reduce((s, c) => s + Math.max(c.balance, 0), 0)

  return (
    <>
      <TopBar title="Clientes" />
      <div className="content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        <div className="kpis" style={{ marginBottom: 16 }}>
          <div className="kpi kpi-main">
            <span className="kpi-label">Te deben en cuentas corrientes</span>
            <span className="kpi-value">{formatMoney(totalDebt)}</span>
          </div>
        </div>

        <div className="toolbar">
          <input
            style={{ width: '100%' }}
            className="search"
            type="search"
            placeholder="Buscar por nombre o documento"
            aria-label="Buscar cliente"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="switcher compact-wide" role="group" aria-label="Qué clientes ver">
          <button type="button" aria-pressed={!onlyDebt} onClick={() => setOnlyDebt(false)}>Todos</button>
          <button type="button" aria-pressed={onlyDebt} onClick={() => setOnlyDebt(true)}>Con deuda</button>
        </div>

        <button className="btn btn-primary btn-block" onClick={() => setCreating(true)} style={{ margin: '4px 0 16px' }}>
          Nuevo cliente
        </button>

        {loading ? (
          <p className="muted">Cargando clientes…</p>
        ) : shown.length === 0 ? (
          <p className="muted">{customers.length ? 'No hay clientes que coincidan.' : 'Todavía no cargaste clientes.'}</p>
        ) : (
          <div className="list">
            {shown.map((c) => (
              <button key={c.id} className="list-row" onClick={() => navigate(`/clientes/${c.id}`)}>
                <span className="product-line">
                  <span>{c.name}</span>
                  <span className="product-sub">
                    {c.doc_type ? `${docTypeLabel[c.doc_type]} ${c.doc_type === 80 ? formatCuit(c.doc_number ?? '') : c.doc_number}` : c.phone ?? 'Sin documento'}
                  </span>
                </span>
                <span className={`balance${c.balance > 0.009 ? ' owes' : ''}`}>{balanceText(c.balance)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <Sheet title="Nuevo cliente" onClose={() => setCreating(false)}>
          <CustomerForm
            restaurantId={restaurant.id}
            onCancel={() => setCreating(false)}
            onSaved={(c) => {
              setCreating(false)
              void reload()
              navigate(`/clientes/${c.id}`)
            }}
          />
        </Sheet>
      )}
    </>
  )
}

/** Ficha del cliente: saldo, movimientos y cobro de la deuda. */
export function Cliente() {
  const { customerId = '' } = useParams()
  const { restaurant } = useCurrentRestaurant()
  const navigate = useNavigate()
  const [customer, setCustomer] = useState<Customer | null>(null)
  const [moves, setMoves] = useState<CustomerMovement[]>([])
  const [orders, setOrders] = useState<Map<string, number | null>>(new Map())
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [editing, setEditing] = useState(false)
  const [paying, setPaying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const [c, m, pm] = await Promise.all([
      supabase.from('customers').select('*').eq('id', customerId).maybeSingle(),
      supabase.from('customer_movements').select('*').eq('customer_id', customerId).order('created_at', { ascending: false }),
      supabase.from('payment_methods').select('*').eq('restaurant_id', restaurant.id).eq('active', true).order('sort_order'),
    ])
    if (c.error || m.error) return setError(errorMessage(c.error ?? m.error))
    setCustomer(c.data)
    setMoves(m.data)
    setMethods((pm.data ?? []).filter((x) => x.kind !== 'account'))
    const ids = [...new Set(m.data.map((x) => x.order_id).filter((x): x is string => !!x))]
    if (ids.length) {
      const { data } = await supabase.from('orders').select('id, number').in('id', ids)
      setOrders(new Map((data ?? []).map((o) => [o.id, o.number])))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId])

  if (!customer) return <div className="center-screen">{error ?? 'Cargando el cliente…'}</div>

  const balance = moves.reduce((s, m) => s + Number(m.amount), 0)
  const when = (iso: string) => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

  return (
    <>
      <TopBar title={customer.name} />
      <div className="content">
        <button className="link-btn" onClick={() => navigate('/clientes')} style={{ marginBottom: 8 }}>← Clientes</button>
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        <div className="ticket" style={{ marginBottom: 16 }}>
          <div className="ticket-row ticket-total">
            <span>{balance > 0.009 ? 'Debe' : balance < -0.009 ? 'Saldo a favor' : 'Saldo'}</span>
            <span className={`amount${balance > 0.009 ? ' owes' : ''}`}>{formatMoney(Math.abs(balance))}</span>
          </div>
          {customer.credit_limit != null && (
            <div className="ticket-row"><span>Límite de cuenta</span><span>{formatMoney(customer.credit_limit)}</span></div>
          )}
          {customer.doc_type && (
            <div className="ticket-row">
              <span>{docTypeLabel[customer.doc_type]}</span>
              <span>{customer.doc_type === 80 ? formatCuit(customer.doc_number ?? '') : customer.doc_number}</span>
            </div>
          )}
          {customer.phone && <div className="ticket-row"><span>Teléfono</span><span>{customer.phone}</span></div>}
          {customer.notes && <p className="muted">{customer.notes}</p>}
        </div>

        <div className="sheet-actions" style={{ marginBottom: 20 }}>
          {balance > 0.009 && <button className="btn btn-primary" onClick={() => setPaying(true)}>Cobrar deuda</button>}
          <button className="btn btn-quiet" onClick={() => setEditing(true)}>Editar datos</button>
        </div>

        <section className="section">
          <h2>Movimientos</h2>
          {moves.length === 0 ? (
            <p className="muted">Sin movimientos. Para cargarle un consumo, asignalo a una comanda y cobrá con "Cuenta corriente".</p>
          ) : (
            <div className="list">
              {moves.map((m) => (
                <div key={m.id} className="list-row">
                  <span className="product-line">
                    <span>
                      {movementLabel[m.kind]}
                      {m.order_id && orders.get(m.order_id) ? ` · Comanda #${orders.get(m.order_id)}` : ''}
                      {m.kind === 'payment' && m.payment_method_id ? ` · ${methodsName(methods, m.payment_method_id)}` : ''}
                    </span>
                    <span className="product-sub">{when(m.created_at)}{m.note ? ` · ${m.note}` : ''}</span>
                  </span>
                  <span className={`nowrap${m.amount > 0 ? ' owes' : ''}`}>
                    {m.amount > 0 ? '+' : '−'}{formatMoney(Math.abs(m.amount))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {editing && (
        <Sheet title="Editar cliente" onClose={() => setEditing(false)}>
          <CustomerForm
            restaurantId={restaurant.id}
            customer={customer}
            onCancel={() => setEditing(false)}
            onSaved={(c) => {
              setCustomer(c)
              setEditing(false)
            }}
          />
        </Sheet>
      )}

      {paying && (
        <DebtPaymentSheet
          customer={customer}
          balance={balance}
          methods={methods}
          onClose={() => setPaying(false)}
          onPaid={() => {
            setPaying(false)
            void load()
          }}
        />
      )}
    </>
  )
}

const methodsName = (methods: PaymentMethod[], id: string) => methods.find((m) => m.id === id)?.name ?? 'Pago'

function DebtPaymentSheet({
  customer,
  balance,
  methods,
  onClose,
  onPaid,
}: {
  customer: Customer
  balance: number
  methods: PaymentMethod[]
  onClose: () => void
  onPaid: () => void
}) {
  const [amount, setAmount] = useState(String(Math.round(balance * 100) / 100))
  const [methodId, setMethodId] = useState(methods.find((m) => m.kind === 'cash')?.id ?? methods[0]?.id ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const value = parseAmount(amount)

  async function pay() {
    if (!Number.isFinite(value) || value <= 0) return setError('Ingresá el monto que paga.')
    if (value > balance + 0.009) return setError(`El pago supera la deuda (${formatMoney(balance)}).`)
    setBusy(true)
    setError(null)
    const session = await deviceSessionId(customer.restaurant_id)
    const { error } = await supabase.rpc('customer_payment', { p_customer: customer.id, p_amount: value, p_method: methodId, p_note: note.trim() || undefined, p_session: session })
    setBusy(false)
    if (error) return setError(errorMessage(error))
    onPaid()
  }

  return (
    <Sheet title={`Cobrar a ${customer.name}`} aside={<span className="price">{formatMoney(balance)}</span>} onClose={onClose}>
      <div className="form">
        <div className="method-chips" role="radiogroup" aria-label="Medio de pago">
          {methods.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={m.id === methodId} onClick={() => setMethodId(m.id)}>
              {m.name}
            </button>
          ))}
        </div>
        <div className="field">
          <label htmlFor="d-amount">Monto</label>
          <input id="d-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="d-note">Nota</label>
          <input id="d-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opcional" />
        </div>
        {methods.find((m) => m.id === methodId)?.kind === 'cash' && (
          <p className="muted">El efectivo entra en la caja abierta como ingreso.</p>
        )}
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => void pay()}>
            Registrar pago{Number.isFinite(value) && value > 0 ? ` · ${formatMoney(value)}` : ''}
          </button>
          <button className="btn btn-quiet" onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </Sheet>
  )
}
