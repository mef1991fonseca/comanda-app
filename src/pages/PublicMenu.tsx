import { useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatMoney } from '../lib/format'

type PublicProduct = {
  id: string
  name: string
  description: string | null
  price: number
  category_id: string | null
  favorite: boolean
  image_url: string | null
  options: { group: string; choices: { name: string; price_delta: number }[] }[]
}
type PublicMenuData = {
  restaurant: { name: string; address: string | null; phone: string | null; note: string | null }
  categories: { id: string; name: string }[]
  products: PublicProduct[]
}

/** Carta pública del local (/m/<slug>), para ver desde el celular escaneando el QR de la mesa. */
export function PublicMenu() {
  const { slug = '' } = useParams()
  const [params] = useSearchParams()
  const table = params.get('mesa')
  const [menu, setMenu] = useState<PublicMenuData | null>(null)
  const [state, setState] = useState<'loading' | 'ok' | 'missing' | 'error'>('loading')
  const [query, setQuery] = useState('')

  useEffect(() => {
    void supabase.rpc('public_menu', { p_slug: slug }).then(({ data, error }) => {
      if (error) return setState('error')
      if (!data) return setState('missing')
      setMenu(data as unknown as PublicMenuData)
      setState('ok')
    })
  }, [slug])

  useEffect(() => {
    if (menu) document.title = `${menu.restaurant.name} · Carta`
  }, [menu])

  const sections = useMemo(() => {
    if (!menu) return []
    const q = query.trim().toLocaleLowerCase('es')
    const match = (p: PublicProduct) => !q || p.name.toLocaleLowerCase('es').includes(q) || (p.description ?? '').toLocaleLowerCase('es').includes(q)
    const list = menu.categories.map((c) => ({ id: c.id, name: c.name, products: menu.products.filter((p) => p.category_id === c.id && match(p)) }))
    const loose = menu.products.filter((p) => (!p.category_id || !menu.categories.some((c) => c.id === p.category_id)) && match(p))
    if (loose.length) list.push({ id: 'otros', name: 'Otros', products: loose })
    return list.filter((s) => s.products.length > 0)
  }, [menu, query])

  if (state === 'loading') return <div className="center-screen">Cargando la carta…</div>
  if (state !== 'ok' || !menu)
    return (
      <div className="center-screen" style={{ padding: 24, textAlign: 'center' }}>
        {state === 'missing' ? 'Esta carta no está disponible. Pedile la carta al mozo.' : 'No pudimos cargar la carta. Revisá la conexión y probá de nuevo.'}
      </div>
    )

  return (
    <div className="pmenu">
      <header className="pmenu-head">
        <div className="pmenu-name">{menu.restaurant.name}</div>
        {table && <div className="pmenu-table">Mesa {table}</div>}
        {menu.restaurant.note && <p className="pmenu-note">{menu.restaurant.note}</p>}
      </header>

      <nav className="pmenu-nav" aria-label="Categorías">
        {sections.map((s) => (
          <a key={s.id} href={`#cat-${s.id}`}>{s.name}</a>
        ))}
      </nav>

      <div className="pmenu-body">
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
            {s.products.map((p) => (
              <article key={p.id} className="pmenu-item">
                <div className="pmenu-item-text">
                  <h3>
                    {p.name}
                    {p.favorite && <span className="pmenu-fav">Recomendado</span>}
                  </h3>
                  {p.description && <p>{p.description}</p>}
                  {p.options.filter((o) => o.choices.length > 0).map((o) => (
                    <p key={o.group} className="pmenu-options">
                      <strong>{o.group}:</strong>{' '}
                      {o.choices.map((c) => (c.price_delta > 0 ? `${c.name} (+${formatMoney(c.price_delta)})` : c.name)).join(' · ')}
                    </p>
                  ))}
                </div>
                <div className="pmenu-price">{formatMoney(p.price)}</div>
              </article>
            ))}
          </section>
        ))}
      </div>

      <footer className="pmenu-foot">
        {menu.restaurant.address && <div>{menu.restaurant.address}</div>}
        {menu.restaurant.phone && <div>{menu.restaurant.phone}</div>}
        <div className="muted">Precios en pesos, IVA incluido.</div>
      </footer>
    </div>
  )
}
