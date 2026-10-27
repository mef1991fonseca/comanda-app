import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { formatMoney } from '../lib/format'
import { Sheet } from '../components/Sheet'

type Choice = { id: string; name: string; price_delta: number }
type Option = { id: string; group: string; min: number; max: number; choices: Choice[] }
type PublicProduct = {
  id: string
  name: string
  description: string | null
  price: number
  category_id: string | null
  favorite: boolean
  image_url: string | null
  options: Option[]
}
type PublicMenuData = {
  restaurant: { name: string; address: string | null; phone: string | null; note: string | null }
  ordering: boolean
  categories: { id: string; name: string }[]
  products: PublicProduct[]
}
type CartLine = { key: string; product_id: string; name: string; unit_price: number; quantity: number; modifiers: Choice[]; notes: string | null }
type Sent = { id: string; at: number; total: number }
type SentStatus = { status: 'pending' | 'accepted' | 'rejected'; reject_reason: string | null }

const TRACK_HOURS = 4

// Lo que el cliente va armando queda en este celular (si el navegador lo permite)
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* sin almacenamiento: vale mientras la página esté abierta */
  }
}

/** Misma regla que el servidor: un grupo con menos opciones que su mínimo exige solo las que hay. */
function checkOptions(options: Option[], selected: Set<string>): string | null {
  for (const o of options) {
    const count = o.choices.filter((c) => selected.has(c.id)).length
    const min = Math.min(o.min, o.choices.length)
    if (count < min) return min === 1 ? `Elegí una opción de ${o.group}.` : `Elegí al menos ${min} en ${o.group}.`
    if (count > o.max) return `En ${o.group} se pueden elegir hasta ${o.max}.`
  }
  return null
}

/** Carta pública del local (/m/<slug>). Con el QR de una mesa y los pedidos activos, el cliente puede pedir. */
export function PublicMenu() {
  const { slug = '' } = useParams()
  const [params] = useSearchParams()
  const table = params.get('mesa')
  const [menu, setMenu] = useState<PublicMenuData | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading')
  const [query, setQuery] = useState('')

  const cartKey = `comanda.cart.${slug}.${table ?? ''}`
  const sentKey = `comanda.sent.${slug}.${table ?? ''}`
  const [cart, setCart] = useState<CartLine[]>(() => load<CartLine[]>(cartKey, []))
  const [sent, setSent] = useState<Sent[]>(() =>
    load<Sent[]>(sentKey, []).filter((s) => Date.now() - s.at < TRACK_HOURS * 3_600_000),
  )
  const [picking, setPicking] = useState<PublicProduct | null>(null)
  const [cartOpen, setCartOpen] = useState(false)

  const fetchMenu = useCallback(async () => {
    const { data, error } = await supabase.rpc('public_menu', { p_slug: slug })
    if (error) return setState('error')
    if (!data) return setState('missing')
    setMenu(data as unknown as PublicMenuData)
    setState('ok')
  }, [slug])

  useEffect(() => {
    void fetchMenu()
  }, [fetchMenu])

  useEffect(() => {
    if (menu) document.title = `${menu.restaurant.name} · Carta`
  }, [menu])

  useEffect(() => save(cartKey, cart), [cartKey, cart])
  useEffect(() => save(sentKey, sent), [sentKey, sent])

  const canOrder = Boolean(menu?.ordering && table)

  const sections = useMemo(() => {
    if (!menu) return []
    const q = query.trim().toLocaleLowerCase('es')
    const match = (p: PublicProduct) => !q || p.name.toLocaleLowerCase('es').includes(q) || (p.description ?? '').toLocaleLowerCase('es').includes(q)
    const list = menu.categories.map((c) => ({ id: c.id, name: c.name, products: menu.products.filter((p) => p.category_id === c.id && match(p)) }))
    const loose = menu.products.filter((p) => (!p.category_id || !menu.categories.some((c) => c.id === p.category_id)) && match(p))
    if (loose.length) list.push({ id: 'otros', name: 'Otros', products: loose })
    return list.filter((s) => s.products.length > 0)
  }, [menu, query])

  const count = cart.reduce((s, l) => s + l.quantity, 0)
  const total = cart.reduce((s, l) => s + l.unit_price * l.quantity, 0)

  function addLine(p: PublicProduct, mods: Choice[], quantity: number, notes: string | null) {
    const key = [p.id, ...mods.map((m) => m.id).sort(), notes ?? ''].join('|')
    const unit = p.price + mods.reduce((s, m) => s + m.price_delta, 0)
    setCart((cur) => {
      const same = cur.find((l) => l.key === key)
      if (same) return cur.map((l) => (l.key === key ? { ...l, quantity: Math.min(20, l.quantity + quantity) } : l))
      return [...cur, { key, product_id: p.id, name: p.name, unit_price: unit, quantity, modifiers: mods, notes }]
    })
  }

  function quickAdd(p: PublicProduct) {
    const usable = p.options.filter((o) => o.choices.length > 0)
    if (usable.length === 0) addLine(p, [], 1, null)
    else setPicking(p)
  }

  if (state === 'loading') return <div className="center-screen">Cargando la carta…</div>
  if (state !== 'ok' || !menu)
    return (
      <div className="center-screen" style={{ padding: 24, textAlign: 'center' }}>
        {state === 'missing' ? 'Esta carta no está disponible. Pedile la carta al mozo.' : 'No pudimos cargar la carta. Revisá la conexión y probá de nuevo.'}
      </div>
    )

  return (
    <div className={canOrder && count > 0 ? 'pmenu has-cart' : 'pmenu'}>
      <header className="pmenu-head">
        <div className="pmenu-name">{menu.restaurant.name}</div>
        {table && <div className="pmenu-table">Mesa {table}</div>}
        {menu.restaurant.note && <p className="pmenu-note">{menu.restaurant.note}</p>}
        {canOrder && <p className="pmenu-note">Elegí lo que quieras y mandá el pedido. El mozo lo confirma.</p>}
      </header>

      <nav className="pmenu-nav" aria-label="Categorías">
        {sections.map((s) => (
          <a key={s.id} href={`#cat-${s.id}`}>{s.name}</a>
        ))}
      </nav>

      <div className="pmenu-body">
        {sent.length > 0 && <SentOrders sent={sent} onClear={(id) => setSent((cur) => cur.filter((s) => s.id !== id))} />}
        <input
          className="search"
          type="search"
          placeholder="Buscar en la carta"
          aria-label="Buscar en la carta"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {sections.length === 0 && <p className="muted">No hay platos que coincidan.</p>}
        {sections.map((s) => (
          <section key={s.id} id={`cat-${s.id}`} className="pmenu-section">
            <h2>{s.name}</h2>
            {s.products.map((p) => {
              const inCart = cart.filter((l) => l.product_id === p.id).reduce((n, l) => n + l.quantity, 0)
              return (
                <article key={p.id} className="pmenu-item">
                  <div className="pmenu-item-text">
                    <h3>
                      {p.name}
                      {p.favorite && <span className="pmenu-fav">Recomendado</span>}
                    </h3>
                    {p.description && <p>{p.description}</p>}
                    {p.options.filter((o) => o.choices.length > 0).map((o) => (
                      <p key={o.id} className="pmenu-options">
                        <strong>{o.group}:</strong>{' '}
                        {o.choices.map((c) => (c.price_delta > 0 ? `${c.name} (+${formatMoney(c.price_delta)})` : c.name)).join(' · ')}
                      </p>
                    ))}
                  </div>
                  <div className="pmenu-side">
                    <div className="pmenu-price">{formatMoney(p.price)}</div>
                    {canOrder && (
                      <button className="pmenu-add" onClick={() => quickAdd(p)} aria-label={`Agregar ${p.name}`}>
                        {inCart > 0 ? `${inCart} · +` : 'Agregar'}
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </section>
        ))}
      </div>

      <footer className="pmenu-foot">
        {menu.restaurant.address && <div>{menu.restaurant.address}</div>}
        {menu.restaurant.phone && <div>{menu.restaurant.phone}</div>}
        <div className="muted">Precios en pesos, IVA incluido.</div>
      </footer>

      {canOrder && count > 0 && (
        <button className="pmenu-cartbar" onClick={() => setCartOpen(true)}>
          <span>Ver pedido · {count === 1 ? '1 plato' : `${count} platos`}</span>
          <strong>{formatMoney(total)}</strong>
        </button>
      )}

      {picking && (
        <OptionsSheet
          product={picking}
          onClose={() => setPicking(null)}
          onAdd={(mods, qty, notes) => {
            addLine(picking, mods, qty, notes)
            setPicking(null)
          }}
        />
      )}
      {cartOpen && table && (
        <CartSheet
          slug={slug}
          table={table}
          cart={cart}
          total={total}
          setCart={setCart}
          onClose={() => setCartOpen(false)}
          onSent={(s) => {
            setSent((cur) => [s, ...cur])
            setCart([])
            setCartOpen(false)
            window.scrollTo({ top: 0, behavior: 'smooth' })
          }}
          onMenuChanged={() => void fetchMenu()}
        />
      )}
    </div>
  )
}

function OptionsSheet({
  product,
  onClose,
  onAdd,
}: {
  product: PublicProduct
  onClose: () => void
  onAdd: (mods: Choice[], qty: number, notes: string | null) => void
}) {
  const options = product.options.filter((o) => o.choices.length > 0)
  const [selected, setSelected] = useState<Set<string>>(() => {
    const init = new Set<string>()
    for (const o of options) if (o.min === 1 && o.max === 1 && o.choices[0]) init.add(o.choices[0].id)
    return init
  })
  const [qty, setQty] = useState(1)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const chosen = options.flatMap((o) => o.choices).filter((c) => selected.has(c.id))
  const unit = product.price + chosen.reduce((s, c) => s + c.price_delta, 0)

  function toggle(option: Option, id: string) {
    const single = option.max === 1
    setSelected((cur) => {
      const next = new Set(cur)
      if (single) for (const c of option.choices) next.delete(c.id)
      if (cur.has(id) && !single) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function submit() {
    const problem = checkOptions(options, selected)
    if (problem) return setError(problem)
    onAdd(chosen, qty, notes.trim() || null)
  }

  return (
    <Sheet title={product.name} aside={<span className="price">{formatMoney(product.price)}</span>} onClose={onClose}>
      <div className="form">
        {options.map((o) => {
          const single = o.max === 1
          return (
            <fieldset key={o.id} className="fieldset">
              <legend>
                {o.group}
                <span className="muted"> · {o.min > 0 ? 'obligatorio' : 'opcional'}{!single && `, hasta ${o.max}`}</span>
              </legend>
              {o.choices.map((c) => (
                <label key={c.id} className="check">
                  <input type={single ? 'radio' : 'checkbox'} name={`o-${o.id}`} checked={selected.has(c.id)} onChange={() => toggle(o, c.id)} />
                  {c.name}
                  {c.price_delta !== 0 && <span className="muted"> · +{formatMoney(c.price_delta)}</span>}
                </label>
              ))}
            </fieldset>
          )
        })}
        <div className="field">
          <label htmlFor="pm-notes">Aclaración</label>
          <input id="pm-notes" value={notes} maxLength={120} onChange={(e) => setNotes(e.target.value)} placeholder="Ej.: sin sal" />
        </div>
        <div className="qty-line">
          <span>Cantidad</span>
          <div className="stepper">
            <button type="button" onClick={() => setQty((q) => Math.max(1, q - 1))} aria-label="Uno menos">−</button>
            <span>{qty}</span>
            <button type="button" onClick={() => setQty((q) => Math.min(20, q + 1))} aria-label="Uno más">+</button>
          </div>
        </div>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" onClick={submit}>Agregar · {formatMoney(unit * qty)}</button>
          <button className="btn btn-quiet" onClick={onClose}>Cancelar</button>
        </div>
      </div>
    </Sheet>
  )
}

function CartSheet({
  slug,
  table,
  cart,
  total,
  setCart,
  onClose,
  onSent,
  onMenuChanged,
}: {
  slug: string
  table: string
  cart: CartLine[]
  total: number
  setCart: (fn: (cur: CartLine[]) => CartLine[]) => void
  onClose: () => void
  onSent: (s: Sent) => void
  onMenuChanged: () => void
}) {
  const [name, setName] = useState(() => load<string>('comanda.customer-name', ''))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function change(key: string, delta: number) {
    setCart((cur) =>
      cur.flatMap((l) => {
        if (l.key !== key) return [l]
        const q = l.quantity + delta
        return q <= 0 ? [] : [{ ...l, quantity: Math.min(20, q) }]
      }),
    )
  }

  async function send() {
    setBusy(true)
    setError(null)
    save('comanda.customer-name', name.trim())
    const { data, error } = await supabase.rpc('public_menu_order', {
      p_slug: slug,
      p_table: table,
      p_items: cart.map((l) => ({ product_id: l.product_id, quantity: l.quantity, modifiers: l.modifiers.map((m) => ({ id: m.id })), notes: l.notes })),
      p_name: name.trim() || undefined,
      p_note: note.trim() || undefined,
    })
    setBusy(false)
    if (error) {
      const msg = errorMessage(error)
      setError(msg)
      if (/ya no está disponible/.test(msg)) onMenuChanged()
      return
    }
    const res = data as unknown as { id: string; total: number }
    onSent({ id: res.id, at: Date.now(), total: Number(res.total) })
  }

  return (
    <Sheet title={`Tu pedido · Mesa ${table}`} onClose={onClose}>
      <div className="form">
        <div className="cart-lines">
          {cart.length === 0 && <p className="muted">Todavía no agregaste nada.</p>}
          {cart.map((l) => (
            <div key={l.key} className="cart-line">
              <div className="cart-line-text">
                <strong>{l.name}</strong>
                {l.modifiers.length > 0 && <span className="muted">{l.modifiers.map((m) => m.name).join(', ')}</span>}
                {l.notes && <span className="muted">“{l.notes}”</span>}
                <span className="cart-line-price">{formatMoney(l.unit_price * l.quantity)}</span>
              </div>
              <div className="stepper">
                <button type="button" onClick={() => change(l.key, -1)} aria-label={`Uno menos de ${l.name}`}>−</button>
                <span>{l.quantity}</span>
                <button type="button" onClick={() => change(l.key, 1)} aria-label={`Uno más de ${l.name}`}>+</button>
              </div>
            </div>
          ))}
        </div>
        <div className="field">
          <label htmlFor="pm-name">Tu nombre</label>
          <input id="pm-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Opcional" autoComplete="given-name" />
        </div>
        <div className="field">
          <label htmlFor="pm-note">Nota para el mozo</label>
          <input id="pm-note" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: traer todo junto" />
        </div>
        <div className="mo-total">
          <span>Total</span>
          <span className="amount">{formatMoney(total)}</span>
        </div>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" disabled={busy || cart.length === 0} onClick={() => void send()}>
            {busy ? 'Mandando…' : 'Mandar pedido'}
          </button>
          <button className="btn btn-quiet" onClick={onClose}>Seguir mirando</button>
        </div>
        <p className="muted" style={{ fontSize: '0.875rem' }}>Se paga al final, como siempre. El mozo confirma el pedido antes de mandarlo a la cocina.</p>
      </div>
    </Sheet>
  )
}

/** Pedidos que mandó este celular, con su estado (se consulta cada 5 s mientras alguno espera). */
function SentOrders({ sent, onClear }: { sent: Sent[]; onClear: (id: string) => void }) {
  const [status, setStatus] = useState<Record<string, SentStatus>>({})
  const latest = useRef(status)
  latest.current = status

  useEffect(() => {
    let stop = false
    async function poll() {
      const results = await Promise.all(
        sent.map(async (s) => {
          const { data } = await supabase.rpc('public_menu_order_status', { p_id: s.id })
          return [s.id, data as unknown as SentStatus | null] as const
        }),
      )
      if (stop) return
      setStatus((cur) => {
        const next = { ...cur }
        for (const [id, st] of results) if (st) next[id] = st
        return next
      })
    }
    void poll()
    const t = window.setInterval(() => {
      if (sent.some((s) => (latest.current[s.id]?.status ?? 'pending') === 'pending')) void poll()
    }, 5_000)
    return () => {
      stop = true
      window.clearInterval(t)
    }
  }, [sent])

  return (
    <div className="pmenu-sent" aria-live="polite">
      {sent.map((s) => {
        const st = status[s.id]
        const kind = st?.status ?? 'pending'
        return (
          <div key={s.id} className={`pmenu-sent-card is-${kind}`}>
            <div>
              <strong>
                {kind === 'pending' && 'Pedido enviado'}
                {kind === 'accepted' && 'Pedido confirmado'}
                {kind === 'rejected' && 'No pudimos tomar el pedido'}
              </strong>
              <span>
                {kind === 'pending' && `Esperando que el mozo lo confirme · ${formatMoney(s.total)}`}
                {kind === 'accepted' && 'Ya está en la cocina.'}
                {kind === 'rejected' && (st?.reject_reason ? `${st.reject_reason}. Llamá al mozo.` : 'Llamá al mozo.')}
              </span>
            </div>
            {kind !== 'pending' && (
              <button className="link-btn" onClick={() => onClear(s.id)} aria-label="Ocultar aviso">
                Ocultar
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
