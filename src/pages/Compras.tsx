import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { formatMoney } from '../lib/format'
import { parseAmount, type PaymentMethod } from '../lib/cash'
import { formatCuit } from '../lib/invoices'
import { formatQty, unitOptions, useIngredients } from '../lib/stock'
import {
  categoryLabel,
  docKindLabel,
  supplierBalanceText,
  supplierMovementLabel,
  useSuppliers,
  type ExpenseCategory,
  type Purchase,
  type PurchaseItem,
  type Supplier,
  type SupplierMovement,
} from '../lib/purchases'
import { TopBar } from '../components/AppShell'
import { Sheet } from '../components/Sheet'
import { ShareBars } from '../components/BarChart'

const today = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('es-AR')
const monthStart = () => `${today().slice(0, 7)}-01`

function usePaymentMethods(restaurantId: string) {
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  useEffect(() => {
    void supabase
      .from('payment_methods')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .eq('active', true)
      .order('sort_order')
      .then(({ data }) => setMethods((data ?? []).filter((m) => m.kind !== 'account')))
  }, [restaurantId])
  return methods
}

// ---------------------------------------------------------------------------
// Compras y gastos del mes + proveedores
// ---------------------------------------------------------------------------
export function Compras() {
  const { restaurant } = useCurrentRestaurant()
  const navigate = useNavigate()
  const [tab, setTab] = useState<'compras' | 'proveedores'>('compras')
  const [purchases, setPurchases] = useState<Purchase[]>([])
  const { suppliers, reload: reloadSuppliers } = useSuppliers(restaurant.id)
  const [creating, setCreating] = useState(false)
  const [open, setOpen] = useState<Purchase | null>(null)
  const [from, setFrom] = useState(monthStart())
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const { data, error } = await supabase
      .from('purchases')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .gte('issued_on', from)
      .order('issued_on', { ascending: false })
      .order('created_at', { ascending: false })
    if (error) setError(errorMessage(error))
    else setPurchases(data)
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restaurant.id, from])

  const live = purchases.filter((p) => !p.cancelled_at)
  const total = live.reduce((s, p) => s + Number(p.total), 0)
  const byCategory = useMemo(() => {
    const map = new Map<ExpenseCategory, number>()
    for (const p of live) map.set(p.category, (map.get(p.category) ?? 0) + Number(p.total))
    return [...map.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ key: k, label: categoryLabel[k], value: v }))
  }, [live])
  const supplierName = (id: string) => suppliers.find((s) => s.id === id)?.name ?? 'Proveedor'
  const owed = suppliers.reduce((s, x) => s + Math.max(x.balance, 0), 0)

  return (
    <>
      <TopBar title="Compras y gastos" />
      <div className="content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        <div className="switcher" role="group" aria-label="Sección" style={{ marginBottom: 16 }}>
          <button type="button" aria-pressed={tab === 'compras'} onClick={() => setTab('compras')}>Compras</button>
          <button type="button" aria-pressed={tab === 'proveedores'} onClick={() => setTab('proveedores')}>Proveedores</button>
        </div>

        {tab === 'compras' ? (
          <>
            <button className="btn btn-primary btn-block" onClick={() => navigate('/compras/nueva')} style={{ marginBottom: 16 }}>
              Cargar compra o gasto
            </button>
            <div className="kpis" style={{ marginBottom: 16 }}>
              <div className="kpi kpi-main">
                <span className="kpi-label">{from === monthStart() ? 'Compras y gastos del mes' : `Desde el ${day(from)}`}</span>
                <span className="kpi-value">{formatMoney(total)}</span>
              </div>
              <div className="kpi">
                <span className="kpi-label">Le debés a proveedores</span>
                <span className="kpi-value">{formatMoney(owed)}</span>
              </div>
            </div>
            <section className="section">
              <h2>Por categoría</h2>
              <ShareBars rows={byCategory} />
            </section>
            <section className="section">
              <div className="section-head">
                <h2>Comprobantes</h2>
                <label className="date-filter">
                  <span className="muted">Desde</span>
                  <input type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
                </label>
              </div>
              {purchases.length === 0 ? (
                <p className="muted">No hay compras cargadas en este período.</p>
              ) : (
                <div className="list">
                  {purchases.map((p) => (
                    <button key={p.id} className="list-row" onClick={() => setOpen(p)}>
                      <span className="product-line">
                        <span>
                          {supplierName(p.supplier_id)}
                          {p.cancelled_at && <span className="badge badge-muted">Anulada</span>}
                        </span>
                        <span className="product-sub">
                          {day(p.issued_on)} · {docKindLabel[p.doc_kind]}{p.doc_number ? ` ${p.doc_number}` : ''} · {categoryLabel[p.category]}
                        </span>
                      </span>
                      <span className="nowrap">{formatMoney(p.total)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </>
        ) : (
          <>
            <button className="btn btn-primary btn-block" onClick={() => setCreating(true)} style={{ marginBottom: 16 }}>
              Nuevo proveedor
            </button>
            {suppliers.length === 0 ? (
              <p className="muted">Todavía no cargaste proveedores.</p>
            ) : (
              <div className="list">
                {suppliers.filter((s) => s.active).map((s) => (
                  <button key={s.id} className="list-row" onClick={() => navigate(`/proveedores/${s.id}`)}>
                    <span className="product-line">
                      <span>{s.name}</span>
                      <span className="product-sub">{s.cuit ? `CUIT ${formatCuit(s.cuit)}` : s.phone ?? 'Sin CUIT'}</span>
                    </span>
                    <span className={`balance${s.balance > 0.009 ? ' owes' : ''}`}>{supplierBalanceText(s.balance)}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {creating && (
        <Sheet title="Nuevo proveedor" onClose={() => setCreating(false)}>
          <SupplierForm
            restaurantId={restaurant.id}
            onCancel={() => setCreating(false)}
            onSaved={() => {
              setCreating(false)
              void reloadSuppliers()
            }}
          />
        </Sheet>
      )}
      {open && (
        <PurchaseSheet
          purchase={open}
          supplierName={supplierName(open.supplier_id)}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null)
            void load()
            void reloadSuppliers()
          }}
        />
      )}
    </>
  )
}

function SupplierForm({
  restaurantId,
  supplier,
  onSaved,
  onCancel,
}: {
  restaurantId: string
  supplier?: Supplier
  onSaved: (s: Supplier) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(supplier?.name ?? '')
  const [cuit, setCuit] = useState(supplier?.cuit ?? '')
  const [phone, setPhone] = useState(supplier?.phone ?? '')
  const [email, setEmail] = useState(supplier?.email ?? '')
  const [notes, setNotes] = useState(supplier?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    const digits = cuit.replace(/\D/g, '')
    if (digits && digits.length !== 11) return setError('El CUIT tiene que tener 11 dígitos.')
    setBusy(true)
    const row = { restaurant_id: restaurantId, name: name.trim(), cuit: digits || null, phone: phone.trim() || null, email: email.trim() || null, notes: notes.trim() || null }
    const { data, error } = supplier
      ? await supabase.from('suppliers').update(row).eq('id', supplier.id).select('*').single()
      : await supabase.from('suppliers').insert(row).select('*').single()
    setBusy(false)
    if (error) return setError(errorMessage(error))
    onSaved(data)
  }

  return (
    <form className="form" onSubmit={save}>
      <div className="field">
        <label htmlFor="s-name">Nombre o razón social</label>
        <input id="s-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="s-cuit">CUIT</label>
          <input id="s-cuit" inputMode="numeric" value={cuit} onChange={(e) => setCuit(e.target.value)} placeholder="Opcional" />
        </div>
        <div className="field">
          <label htmlFor="s-phone">Teléfono</label>
          <input id="s-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="s-email">Email</label>
        <input id="s-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="s-notes">Notas</label>
        <input id="s-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Ej.: entrega martes y viernes" />
      </div>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="sheet-actions">
        <button className="btn btn-primary" disabled={busy}>{supplier ? 'Guardar cambios' : 'Crear proveedor'}</button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  )
}

function PurchaseSheet({
  purchase,
  supplierName,
  onClose,
  onChanged,
}: {
  purchase: Purchase
  supplierName: string
  onClose: () => void
  onChanged: () => void
}) {
  const [items, setItems] = useState<PurchaseItem[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void supabase.from('purchase_items').select('*').eq('purchase_id', purchase.id).then(({ data }) => setItems(data ?? []))
  }, [purchase.id])

  async function cancel() {
    if (!window.confirm('Se devuelve el stock de los insumos y se descuenta la deuda con el proveedor. ¿Anular la compra?')) return
    setBusy(true)
    const { error } = await supabase.rpc('cancel_purchase', { p_purchase: purchase.id })
    setBusy(false)
    if (error) return setError(errorMessage(error))
    onChanged()
  }

  return (
    <Sheet title={supplierName} aside={<span className="price">{formatMoney(purchase.total)}</span>} onClose={onClose}>
      <p className="muted">
        {day(purchase.issued_on)} · {docKindLabel[purchase.doc_kind]}{purchase.doc_number ? ` ${purchase.doc_number}` : ''} · {categoryLabel[purchase.category]}
        {purchase.due_on ? ` · vence el ${day(purchase.due_on)}` : ''}
      </p>
      <div className="ticket">
        {items.map((i) => (
          <div key={i.id} className="ticket-row">
            <span>{Number(i.quantity)} × {i.description}</span>
            <span>{formatMoney(i.line_total)}</span>
          </div>
        ))}
        {items.reduce((s, i) => s + Number(i.line_total), 0) < Number(purchase.total) - 0.009 && (
          <div className="ticket-row">
            <span>Impuestos y otros cargos</span>
            <span>{formatMoney(Number(purchase.total) - items.reduce((s, i) => s + Number(i.line_total), 0))}</span>
          </div>
        )}
        <div className="ticket-row ticket-total"><span>Total</span><span className="amount">{formatMoney(purchase.total)}</span></div>
      </div>
      {purchase.notes && <p className="muted">{purchase.notes}</p>}
      {purchase.cancelled_at && <div className="notice notice-info">Compra anulada el {new Date(purchase.cancelled_at).toLocaleDateString('es-AR')}.</div>}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="sheet-actions">
        {!purchase.cancelled_at && (
          <button className="btn btn-danger" disabled={busy} onClick={() => void cancel()}>Anular compra</button>
        )}
        <button className="btn btn-quiet" onClick={onClose}>Cerrar</button>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Cargar una compra o gasto
// ---------------------------------------------------------------------------
type Line = { key: string; ingredientId: string; description: string; quantity: string; total: string }
const newLine = (): Line => ({ key: crypto.randomUUID(), ingredientId: '', description: '', quantity: '1', total: '' })

export function CompraNueva() {
  const { restaurant } = useCurrentRestaurant()
  const navigate = useNavigate()
  const { suppliers, reload: reloadSuppliers } = useSuppliers(restaurant.id)
  const { ingredients } = useIngredients(restaurant.id)
  const methods = usePaymentMethods(restaurant.id)
  const [supplierId, setSupplierId] = useState('')
  const [issuedOn, setIssuedOn] = useState(today())
  const [dueOn, setDueOn] = useState('')
  const [docKind, setDocKind] = useState('factura')
  const [docNumber, setDocNumber] = useState('')
  const [category, setCategory] = useState<ExpenseCategory>('mercaderia')
  const [lines, setLines] = useState<Line[]>([newLine()])
  const [extra, setExtra] = useState('')
  const [payNow, setPayNow] = useState<'no' | 'all'>('no')
  const [methodId, setMethodId] = useState('')
  const [notes, setNotes] = useState('')
  const [newSupplier, setNewSupplier] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!methodId && methods.length) setMethodId(methods.find((m) => m.kind === 'transfer')?.id ?? methods[0]!.id)
  }, [methods, methodId])

  const linesTotal = lines.reduce((s, l) => s + (l.total.trim() ? parseAmount(l.total) || 0 : 0), 0)
  const extraValue = extra.trim() ? parseAmount(extra) : 0
  const total = linesTotal + (Number.isFinite(extraValue) ? extraValue : 0)
  const setLine = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  async function save() {
    if (!supplierId) return setError('Elegí el proveedor.')
    const items = []
    for (const l of lines) {
      const qty = parseAmount(l.quantity)
      const lt = l.total.trim() ? parseAmount(l.total) : 0
      if (!l.ingredientId && !l.description.trim()) continue
      if (!Number.isFinite(qty) || qty <= 0) return setError('Revisá las cantidades.')
      if (!Number.isFinite(lt) || lt < 0) return setError('Revisá los importes.')
      items.push({ ingredient_id: l.ingredientId || null, description: l.description.trim() || null, quantity: qty, line_total: lt })
    }
    if (items.length === 0) return setError('Cargá al menos un renglón.')
    if (!(total > 0)) return setError('El total tiene que ser mayor a cero.')
    setBusy(true)
    setError(null)
    const { error } = await supabase.rpc('register_purchase', {
      p_purchase: {
        supplier_id: supplierId,
        issued_on: issuedOn,
        due_on: dueOn || null,
        doc_kind: docKind,
        doc_number: docNumber,
        category,
        notes,
        total: Math.round(total * 100) / 100,
        items,
        paid: payNow === 'all' ? { method_id: methodId, amount: Math.round(total * 100) / 100 } : null,
      },
    })
    setBusy(false)
    if (error) return setError(errorMessage(error))
    navigate('/compras', { replace: true })
  }

  const unitShort = (id: string) => {
    const ing = ingredients.find((i) => i.id === id)
    return ing ? unitOptions.find((u) => u.value === ing.unit)?.short ?? '' : ''
  }

  return (
    <>
      <TopBar title="Cargar compra" />
      <div className="content form purchase-form">
        <div className="field">
          <label htmlFor="p-supplier">Proveedor</label>
          <div className="field-inline">
            <select id="p-supplier" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              <option value="">Elegí…</option>
              {suppliers.filter((s) => s.active).map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
            <button type="button" className="btn btn-quiet" onClick={() => setNewSupplier(true)}>Nuevo</button>
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="p-kind">Comprobante</label>
            <select id="p-kind" value={docKind} onChange={(e) => setDocKind(e.target.value)}>
              {Object.entries(docKindLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="p-number">Número</label>
            <input id="p-number" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} placeholder="0001-00001234" />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="p-date">Fecha</label>
            <input id="p-date" type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="p-due">Vence</label>
            <input id="p-due" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="p-cat">Categoría</label>
          <select id="p-cat" value={category} onChange={(e) => setCategory(e.target.value as ExpenseCategory)}>
            {Object.entries(categoryLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>

        <fieldset className="fieldset">
          <legend>Renglones</legend>
          <p className="hint muted">Si elegís un insumo, suma al stock y actualiza su costo. Para gastos (luz, alquiler) escribí la descripción.</p>
          {lines.map((l, i) => (
            <div key={l.key} className="purchase-line">
              <div className="field">
                <label htmlFor={`l-ing-${i}`}>Insumo</label>
                <select id={`l-ing-${i}`} value={l.ingredientId} onChange={(e) => setLine(l.key, { ingredientId: e.target.value })}>
                  <option value="">Sin insumo (gasto)</option>
                  {ingredients.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </div>
              {!l.ingredientId && (
                <div className="field">
                  <label htmlFor={`l-desc-${i}`}>Descripción</label>
                  <input id={`l-desc-${i}`} value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} />
                </div>
              )}
              <div className="field-row">
                <div className="field">
                  <label htmlFor={`l-qty-${i}`}>Cantidad{l.ingredientId ? ` (${unitShort(l.ingredientId)})` : ''}</label>
                  <input id={`l-qty-${i}`} inputMode="decimal" value={l.quantity} onChange={(e) => setLine(l.key, { quantity: e.target.value })} />
                </div>
                <div className="field">
                  <label htmlFor={`l-total-${i}`}>Importe</label>
                  <input id={`l-total-${i}`} inputMode="decimal" value={l.total} onChange={(e) => setLine(l.key, { total: e.target.value })} />
                </div>
              </div>
              {l.ingredientId && parseAmount(l.quantity) > 0 && parseAmount(l.total) > 0 && (
                <p className="hint muted">
                  Costo nuevo: {formatMoney(parseAmount(l.total) / parseAmount(l.quantity))} por {unitShort(l.ingredientId)}
                  {(() => {
                    const ing = ingredients.find((x) => x.id === l.ingredientId)
                    return ing ? ` · hoy hay ${formatQty(ing.stock_qty, ing.unit)}` : ''
                  })()}
                </p>
              )}
              {lines.length > 1 && (
                <button type="button" className="link-btn" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>Quitar renglón</button>
              )}
            </div>
          ))}
          <button type="button" className="btn btn-quiet" onClick={() => setLines((ls) => [...ls, newLine()])}>Agregar renglón</button>
        </fieldset>

        <div className="field">
          <label htmlFor="p-extra">Impuestos y otros cargos</label>
          <input id="p-extra" inputMode="decimal" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="IVA, percepciones, flete" />
        </div>

        <div className="ticket">
          <div className="ticket-row ticket-total"><span>Total</span><span className="amount">{formatMoney(total)}</span></div>
        </div>

        <div className="switcher" role="group" aria-label="Pago">
          <button type="button" aria-pressed={payNow === 'no'} onClick={() => setPayNow('no')}>Queda a pagar</button>
          <button type="button" aria-pressed={payNow === 'all'} onClick={() => setPayNow('all')}>Ya está pagada</button>
        </div>
        {payNow === 'all' && (
          <div className="method-chips" role="radiogroup" aria-label="Medio de pago">
            {methods.map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={m.id === methodId} onClick={() => setMethodId(m.id)}>{m.name}</button>
            ))}
          </div>
        )}
        <div className="field">
          <label htmlFor="p-notes">Notas</label>
          <input id="p-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
        </div>

        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>Registrar compra · {formatMoney(total)}</button>
          <button className="btn btn-quiet" onClick={() => navigate(-1)}>Cancelar</button>
        </div>
      </div>

      {newSupplier && (
        <Sheet title="Nuevo proveedor" onClose={() => setNewSupplier(false)}>
          <SupplierForm
            restaurantId={restaurant.id}
            onCancel={() => setNewSupplier(false)}
            onSaved={(s) => {
              setNewSupplier(false)
              void reloadSuppliers().then(() => setSupplierId(s.id))
            }}
          />
        </Sheet>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Ficha del proveedor
// ---------------------------------------------------------------------------
export function Proveedor() {
  const { supplierId = '' } = useParams()
  const { restaurant } = useCurrentRestaurant()
  const navigate = useNavigate()
  const methods = usePaymentMethods(restaurant.id)
  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [moves, setMoves] = useState<SupplierMovement[]>([])
  const [paying, setPaying] = useState(false)
  const [editing, setEditing] = useState(false)
  const [amount, setAmount] = useState('')
  const [methodId, setMethodId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    const [s, m] = await Promise.all([
      supabase.from('suppliers').select('*').eq('id', supplierId).maybeSingle(),
      supabase.from('supplier_movements').select('*').eq('supplier_id', supplierId).order('created_at', { ascending: false }),
    ])
    setSupplier(s.data)
    setMoves(m.data ?? [])
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supplierId])

  if (!supplier) return <div className="center-screen">Cargando el proveedor…</div>
  const balance = moves.reduce((s, m) => s + Number(m.amount), 0)
  const when = (iso: string) => new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' })
  const methodName = (id: string | null) => methods.find((m) => m.id === id)?.name

  async function pay() {
    const v = parseAmount(amount)
    if (!Number.isFinite(v) || v <= 0) return setError('Ingresá el monto a pagar.')
    setBusy(true)
    setError(null)
    const { error } = await supabase.rpc('supplier_payment', { p_supplier: supplierId, p_amount: v, p_method: methodId, p_note: note.trim() || undefined })
    setBusy(false)
    if (error) return setError(errorMessage(error))
    setPaying(false)
    setNote('')
    void load()
  }

  return (
    <>
      <TopBar title={supplier.name} />
      <div className="content">
        <button className="link-btn" onClick={() => navigate('/compras')} style={{ marginBottom: 8 }}>← Compras</button>
        <div className="ticket" style={{ marginBottom: 16 }}>
          <div className="ticket-row ticket-total">
            <span>{balance > 0.009 ? 'Le debés' : balance < -0.009 ? 'Saldo a favor' : 'Saldo'}</span>
            <span className={`amount${balance > 0.009 ? ' owes' : ''}`}>{formatMoney(Math.abs(balance))}</span>
          </div>
          {supplier.cuit && <div className="ticket-row"><span>CUIT</span><span>{formatCuit(supplier.cuit)}</span></div>}
          {supplier.phone && <div className="ticket-row"><span>Teléfono</span><span>{supplier.phone}</span></div>}
          {supplier.notes && <p className="muted">{supplier.notes}</p>}
        </div>
        <div className="sheet-actions" style={{ marginBottom: 20 }}>
          {balance > 0.009 && (
            <button
              className="btn btn-primary"
              onClick={() => {
                setAmount(String(Math.round(balance * 100) / 100))
                setMethodId(methods.find((m) => m.kind === 'transfer')?.id ?? methods[0]?.id ?? '')
                setPaying(true)
              }}
            >
              Registrar pago
            </button>
          )}
          <button className="btn btn-quiet" onClick={() => setEditing(true)}>Editar datos</button>
        </div>
        <section className="section">
          <h2>Movimientos</h2>
          {moves.length === 0 ? (
            <p className="muted">Sin movimientos.</p>
          ) : (
            <div className="list">
              {moves.map((m) => (
                <div key={m.id} className="list-row">
                  <span className="product-line">
                    <span>
                      {supplierMovementLabel[m.kind]}
                      {m.kind === 'payment' && methodName(m.payment_method_id) ? ` · ${methodName(m.payment_method_id)}` : ''}
                      {m.kind === 'purchase' && m.note ? ` · ${m.note}` : ''}
                    </span>
                    <span className="product-sub">{when(m.created_at)}{m.kind !== 'purchase' && m.note ? ` · ${m.note}` : ''}</span>
                  </span>
                  <span className={`nowrap${m.amount > 0 ? ' owes' : ''}`}>{m.amount > 0 ? '+' : '−'}{formatMoney(Math.abs(m.amount))}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {paying && (
        <Sheet title={`Pagar a ${supplier.name}`} aside={<span className="price">{formatMoney(balance)}</span>} onClose={() => setPaying(false)}>
          <div className="form">
            <div className="method-chips" role="radiogroup" aria-label="Medio de pago">
              {methods.map((m) => (
                <button key={m.id} type="button" role="radio" aria-checked={m.id === methodId} onClick={() => setMethodId(m.id)}>{m.name}</button>
              ))}
            </div>
            <div className="field">
              <label htmlFor="sp-amount">Monto</label>
              <input id="sp-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="sp-note">Nota</label>
              <input id="sp-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Opcional" />
            </div>
            {methods.find((m) => m.id === methodId)?.kind === 'cash' && <p className="muted">El efectivo sale de la caja abierta como retiro.</p>}
            {error && <div className="notice notice-error" role="alert">{error}</div>}
            <div className="sheet-actions">
              <button className="btn btn-primary" disabled={busy} onClick={() => void pay()}>
                Pagar{parseAmount(amount) > 0 ? ` · ${formatMoney(parseAmount(amount))}` : ''}
              </button>
              <button className="btn btn-quiet" onClick={() => setPaying(false)}>Cancelar</button>
            </div>
          </div>
        </Sheet>
      )}
      {editing && (
        <Sheet title="Editar proveedor" onClose={() => setEditing(false)}>
          <SupplierForm
            restaurantId={restaurant.id}
            supplier={supplier}
            onCancel={() => setEditing(false)}
            onSaved={(s) => {
              setSupplier(s)
              setEditing(false)
            }}
          />
        </Sheet>
      )}
    </>
  )
}
