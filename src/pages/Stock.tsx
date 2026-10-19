import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { parseAmount } from '../lib/cash'
import { formatMoney } from '../lib/format'
import {
  formatQty,
  isLow,
  reasonLabel,
  unitOptions,
  unitShort,
  useIngredients,
  type Ingredient,
  type StockMovement,
  type StockUnit,
} from '../lib/stock'
import { TopBar } from '../components/AppShell'
import { Sheet } from '../components/Sheet'

const when = new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })

export function Stock() {
  const { restaurant } = useCurrentRestaurant()
  const { ingredients, loading, error, reload } = useIngredients(restaurant.id)
  const [query, setQuery] = useState('')
  const [onlyLow, setOnlyLow] = useState(false)
  const [selected, setSelected] = useState<Ingredient | 'new' | null>(null)

  const low = ingredients.filter((i) => i.active && isLow(i))
  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('es')
    return ingredients.filter(
      (i) => (!onlyLow || isLow(i)) && (!q || i.name.toLocaleLowerCase('es').includes(q)),
    )
  }, [ingredients, query, onlyLow])

  const current = selected && selected !== 'new' ? ingredients.find((i) => i.id === selected.id) ?? selected : selected

  return (
    <>
      <TopBar title="Stock" />
      <div className="content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => setSelected('new')}>Nuevo insumo</button>
        </div>

        {low.length > 0 && (
          <button className="stock-alert" onClick={() => setOnlyLow(true)} aria-label="Ver insumos con faltante">
            <strong>{low.length} {low.length === 1 ? 'insumo está' : 'insumos están'} en el mínimo o por debajo</strong>
            <span>{low.slice(0, 4).map((i) => i.name).join(', ')}{low.length > 4 ? '…' : ''}</span>
          </button>
        )}

        {ingredients.length > 0 && (
          <div className="stock-filters">
            <input
              className="search"
              type="search"
              placeholder="Buscar insumo"
              aria-label="Buscar insumo"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <label className="check">
              <input type="checkbox" checked={onlyLow} onChange={(e) => setOnlyLow(e.target.checked)} />
              Solo faltantes
            </label>
          </div>
        )}

        {loading ? (
          <p className="muted">Cargando insumos…</p>
        ) : ingredients.length === 0 ? (
          <div className="empty">
            <h2>Todavía no cargaste insumos</h2>
            <p className="muted">
              Cargá lo que comprás (muzzarella, harina, gaseosas) y armá la receta de cada plato: el stock se descuenta solo con cada venta.
            </p>
          </div>
        ) : shown.length === 0 ? (
          <p className="muted">No hay insumos que coincidan.</p>
        ) : (
          <div className="list">
            {shown.map((i) => (
              <button key={i.id} className="list-row" onClick={() => setSelected(i)}>
                <span className="product-line">
                  <span className={i.active ? undefined : 'muted'}>{i.name}</span>
                  <span className="product-sub">
                    {i.min_stock > 0 ? `Mínimo ${formatQty(i.min_stock, i.unit)}` : 'Sin mínimo'}
                    {i.cost_per_unit > 0 && ` · ${formatMoney(i.cost_per_unit)} por ${unitShort(i.unit)}`}
                  </span>
                </span>
                <span className={`price${isLow(i) ? ' neg' : ''}`}>{formatQty(i.stock_qty, i.unit)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {current === 'new' && (
        <IngredientForm
          restaurantId={restaurant.id}
          ingredient={null}
          onClose={() => setSelected(null)}
          onSaved={async () => {
            await reload()
            setSelected(null)
          }}
        />
      )}
      {current && current !== 'new' && (
        <IngredientSheet ingredient={current} onClose={() => setSelected(null)} onChanged={reload} />
      )}
    </>
  )
}

function IngredientForm({
  restaurantId,
  ingredient,
  onClose,
  onSaved,
}: {
  restaurantId: string
  ingredient: Ingredient | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(ingredient?.name ?? '')
  const [unit, setUnit] = useState<StockUnit>(ingredient?.unit ?? 'g')
  const [initial, setInitial] = useState('')
  const [min, setMin] = useState(ingredient?.min_stock ? String(ingredient.min_stock) : '')
  const [cost, setCost] = useState(ingredient?.cost_per_unit ? String(ingredient.cost_per_unit) : '')
  const [active, setActive] = useState(ingredient?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const minV = min.trim() ? parseAmount(min) : 0
    const costV = cost.trim() ? parseAmount(cost) : 0
    const initialV = initial.trim() ? parseAmount(initial) : 0
    if ([minV, costV, initialV].some((v) => !Number.isFinite(v) || v < 0)) return setError('Revisá los números: tienen que ser 0 o más.')
    setBusy(true)
    setError(null)
    const values = { name: name.trim(), unit, min_stock: minV, cost_per_unit: costV, active }
    const res = ingredient
      ? await supabase.from('ingredients').update(values).eq('id', ingredient.id).select('id').single()
      : await supabase.from('ingredients').insert({ ...values, restaurant_id: restaurantId }).select('id').single()
    if (res.error) {
      setError(errorMessage(res.error))
      setBusy(false)
      return
    }
    if (!ingredient && initialV > 0) {
      const { error } = await supabase.from('stock_movements').insert({
        restaurant_id: restaurantId,
        ingredient_id: res.data.id,
        qty_delta: initialV,
        reason: 'adjustment',
        note: 'Stock inicial',
      })
      if (error) {
        setError(errorMessage(error))
        setBusy(false)
        return
      }
    }
    await onSaved()
  }

  return (
    <Sheet title={ingredient ? 'Editar insumo' : 'Nuevo insumo'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="ing-name">Nombre</label>
          <input id="ing-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Muzzarella" />
        </div>
        <div className="field">
          <label htmlFor="ing-unit">Se mide en</label>
          <select id="ing-unit" value={unit} onChange={(e) => setUnit(e.target.value as StockUnit)} disabled={!!ingredient}>
            {unitOptions.map((u) => (
              <option key={u.value} value={u.value}>{u.label}</option>
            ))}
          </select>
          {ingredient && <span className="hint muted">La unidad no se cambia después de crear el insumo.</span>}
        </div>
        <div className="field-row">
          {!ingredient && (
            <div className="field">
              <label htmlFor="ing-initial">Stock actual ({unitShort(unit)})</label>
              <input id="ing-initial" inputMode="decimal" value={initial} onChange={(e) => setInitial(e.target.value)} placeholder="0" />
            </div>
          )}
          <div className="field">
            <label htmlFor="ing-min">Mínimo ({unitShort(unit)})</label>
            <input id="ing-min" inputMode="decimal" value={min} onChange={(e) => setMin(e.target.value)} placeholder="0" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="ing-cost">Costo por {unitShort(unit)}</label>
          <input id="ing-cost" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0" />
          <span className="hint muted">Se actualiza solo cada vez que registrás una compra.</span>
        </div>
        {ingredient && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Activo
          </label>
        )}
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" disabled={busy}>Guardar insumo</button>
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Sheet>
  )
}

type Action = 'purchase' | 'waste' | 'adjustment' | 'count'
const actionLabel: Record<Action, string> = { purchase: 'Compra', waste: 'Merma', adjustment: 'Ajuste', count: 'Conteo' }

function IngredientSheet({
  ingredient,
  onClose,
  onChanged,
}: {
  ingredient: Ingredient
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [action, setAction] = useState<Action>('purchase')
  const [qty, setQty] = useState('')
  const [total, setTotal] = useState('')
  const [note, setNote] = useState('')
  const [history, setHistory] = useState<StockMovement[]>([])
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const u = unitShort(ingredient.unit)

  const loadHistory = async () => {
    const { data } = await supabase
      .from('stock_movements')
      .select('*')
      .eq('ingredient_id', ingredient.id)
      .order('created_at', { ascending: false })
      .limit(15)
    setHistory(data ?? [])
  }

  useEffect(() => {
    void loadHistory()
  }, [ingredient.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: FormEvent) {
    e.preventDefault()
    const value = parseAmount(qty)
    if (!Number.isFinite(value) || (action !== 'adjustment' && value < 0) || (action !== 'count' && value === 0)) {
      return setError(action === 'adjustment' ? 'Ingresá cuánto sumar (o restar con un signo menos).' : 'Ingresá una cantidad mayor a cero.')
    }
    setBusy(true)
    setError(null)
    let res: { error: unknown }
    if (action === 'count') {
      res = await supabase.rpc('stock_count', { p_ingredient: ingredient.id, p_counted: value, ...(note.trim() ? { p_note: note.trim() } : {}) })
    } else {
      const totalV = total.trim() ? parseAmount(total) : NaN
      res = await supabase.from('stock_movements').insert({
        restaurant_id: ingredient.restaurant_id,
        ingredient_id: ingredient.id,
        qty_delta: action === 'waste' ? -value : value,
        reason: action,
        unit_cost: action === 'purchase' && Number.isFinite(totalV) && totalV > 0 ? Math.round((totalV / value) * 10000) / 10000 : null,
        note: note.trim() || null,
      })
    }
    if (res.error) {
      setError(errorMessage(res.error))
      setBusy(false)
      return
    }
    setDone(`${actionLabel[action]} ${action === 'purchase' || action === 'waste' ? 'registrada' : 'registrado'}.`)
    setQty('')
    setTotal('')
    setNote('')
    await Promise.all([onChanged(), loadHistory()])
    setBusy(false)
  }

  if (editing) {
    return (
      <IngredientForm
        restaurantId={ingredient.restaurant_id}
        ingredient={ingredient}
        onClose={() => setEditing(false)}
        onSaved={async () => {
          await onChanged()
          setEditing(false)
        }}
      />
    )
  }

  return (
    <Sheet
      title={ingredient.name}
      aside={<span className={`price${isLow(ingredient) ? ' neg' : ''}`}>{formatQty(ingredient.stock_qty, ingredient.unit)}</span>}
      onClose={onClose}
    >
      <p className="muted">
        {ingredient.min_stock > 0 ? `Mínimo ${formatQty(ingredient.min_stock, ingredient.unit)}` : 'Sin mínimo'}
        {' · '}
        {ingredient.cost_per_unit > 0 ? `${formatMoney(ingredient.cost_per_unit)} por ${u}` : 'sin costo cargado'}
        {' · '}
        <button className="link-btn inline" onClick={() => setEditing(true)}>Editar datos</button>
      </p>

      <div className="switcher four" role="group" aria-label="Movimiento">
        {(Object.keys(actionLabel) as Action[]).map((a) => (
          <button key={a} type="button" aria-pressed={action === a} onClick={() => { setAction(a); setError(null); setDone(null) }}>
            {actionLabel[a]}
          </button>
        ))}
      </div>

      <form className="form" onSubmit={submit}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="mv-qty">
              {action === 'count' ? `Cantidad contada (${u})` : action === 'adjustment' ? `Sumar o restar (${u})` : `Cantidad (${u})`}
            </label>
            <input id="mv-qty" inputMode="decimal" required value={qty} onChange={(e) => setQty(e.target.value)} placeholder={action === 'adjustment' ? 'Ej.: -250' : '0'} />
          </div>
          {action === 'purchase' && (
            <div className="field">
              <label htmlFor="mv-total">Costo total</label>
              <input id="mv-total" inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} placeholder="Opcional" />
            </div>
          )}
        </div>
        <div className="field">
          <label htmlFor="mv-note">{action === 'waste' ? 'Motivo' : 'Nota'}</label>
          <input id="mv-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder={action === 'purchase' ? 'Ej.: proveedor, factura' : action === 'waste' ? 'Ej.: vencido' : 'Opcional'} />
        </div>
        {action === 'count' && (
          <span className="hint muted">Se registra la diferencia con lo que figura en el sistema.</span>
        )}
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {done && <div className="notice notice-info" role="status">{done}</div>}
        <button className="btn btn-primary" disabled={busy}>Registrar {actionLabel[action].toLowerCase()}</button>
      </form>

      {history.length > 0 && (
        <section className="section">
          <h2>Últimos movimientos</h2>
          <div className="ticket">
            {history.map((m) => (
              <div key={m.id} className="ticket-row">
                <span>
                  {reasonLabel[m.reason]}
                  <span className="muted"> · {when.format(new Date(m.created_at))}{m.note ? ` · ${m.note}` : ''}</span>
                </span>
                <span className={`nowrap${m.qty_delta < 0 ? ' neg' : ''}`}>
                  {m.qty_delta > 0 ? '+' : ''}{formatQty(m.qty_delta, ingredient.unit)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      <button className="btn btn-quiet" onClick={onClose}>Cerrar</button>
    </Sheet>
  )
}
