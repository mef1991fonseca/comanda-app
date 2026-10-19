import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { useMenu, useProductsByCategory, type Category, type Menu, type ProductWithGroups } from '../lib/menu'
import { formatMoney } from '../lib/format'
import { TopBar } from '../components/AppShell'
import { Sheet } from '../components/Sheet'

type Editing =
  | { kind: 'product'; product: ProductWithGroups | null; categoryId: string | null }
  | { kind: 'category'; category: Category | null }
  | null

export function Carta() {
  const { restaurant } = useCurrentRestaurant()
  const { menu, loading, error, reload } = useMenu(restaurant.id, true)
  const sections = useProductsByCategory(menu)
  const [editing, setEditing] = useState<Editing>(null)

  const close = () => setEditing(null)
  const saved = async () => {
    await reload()
    setEditing(null)
  }

  return (
    <>
      <TopBar title="Carta" />
      <div className="content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => setEditing({ kind: 'product', product: null, categoryId: null })}>
            Nuevo producto
          </button>
          <button className="btn btn-quiet" onClick={() => setEditing({ kind: 'category', category: null })}>
            Nueva categoría
          </button>
          <Link className="btn btn-quiet" to="/carta/modificadores">
            Modificadores ({menu.groups.length})
          </Link>
        </div>

        {loading ? (
          <p className="muted">Cargando la carta…</p>
        ) : menu.products.length === 0 && menu.categories.length === 0 ? (
          <div className="empty">
            <h2>Tu carta está vacía</h2>
            <p className="muted">
              Empezá por las categorías (Entradas, Principales, Bebidas) y después cargá los productos con su precio.
            </p>
          </div>
        ) : (
          sections.map(({ category, products }) => (
            <section key={category?.id ?? 'sin-categoria'} className="section">
              <div className="section-head">
                <h2>
                  {category?.name ?? 'Sin categoría'}
                  {category && !category.active && <span className="muted"> · oculta</span>}
                </h2>
                {category && (
                  <button className="link-btn" onClick={() => setEditing({ kind: 'category', category })}>
                    Editar
                  </button>
                )}
              </div>
              <div className="list">
                {products.map((p) => (
                  <button
                    key={p.id}
                    className="list-row"
                    onClick={() => setEditing({ kind: 'product', product: p, categoryId: p.category_id })}
                  >
                    <span className="product-line">
                      <span className={p.active ? undefined : 'muted'}>{p.name}</span>
                      <span className="product-sub">
                        {[
                          !p.active && 'No disponible',
                          p.is_favorite && 'Favorito',
                          p.groups.length > 0 && p.groups.map((g) => g.name).join(', '),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                    <span className="price">{formatMoney(p.price)}</span>
                  </button>
                ))}
                {category && (
                  <button
                    className="list-row add-row"
                    onClick={() => setEditing({ kind: 'product', product: null, categoryId: category.id })}
                  >
                    Agregar producto en {category.name}
                  </button>
                )}
              </div>
            </section>
          ))
        )}
      </div>

      {editing?.kind === 'product' && (
        <ProductSheet
          restaurantId={restaurant.id}
          menu={menu}
          product={editing.product}
          defaultCategoryId={editing.categoryId}
          onClose={close}
          onSaved={saved}
        />
      )}
      {editing?.kind === 'category' && (
        <CategorySheet
          restaurantId={restaurant.id}
          category={editing.category}
          nextOrder={menu.categories.length}
          onClose={close}
          onSaved={saved}
        />
      )}
    </>
  )
}

function CategorySheet({
  restaurantId,
  category,
  nextOrder,
  onClose,
  onSaved,
}: {
  restaurantId: string
  category: Category | null
  nextOrder: number
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(category?.name ?? '')
  const [active, setActive] = useState(category?.active ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    const { error } = category
      ? await supabase.from('categories').update({ name: name.trim(), active }).eq('id', category.id)
      : await supabase.from('categories').insert({ restaurant_id: restaurantId, name: name.trim(), sort_order: nextOrder })
    if (error) {
      setError(errorMessage(error))
      setBusy(false)
      return
    }
    await onSaved()
  }

  return (
    <Sheet title={category ? 'Editar categoría' : 'Nueva categoría'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="cat-name">Nombre</label>
          <input id="cat-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Principales" />
        </div>
        {category && (
          <label className="check">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Mostrar en la carta
          </label>
        )}
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" disabled={busy}>Guardar categoría</button>
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Sheet>
  )
}

function ProductSheet({
  restaurantId,
  menu,
  product,
  defaultCategoryId,
  onClose,
  onSaved,
}: {
  restaurantId: string
  menu: Menu
  product: ProductWithGroups | null
  defaultCategoryId: string | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const kitchen = menu.stations.find((s) => s.name === 'Cocina') ?? menu.stations[0]
  const [name, setName] = useState(product?.name ?? '')
  const [price, setPrice] = useState(product ? String(product.price) : '')
  const [description, setDescription] = useState(product?.description ?? '')
  const [categoryId, setCategoryId] = useState(product?.category_id ?? defaultCategoryId ?? '')
  const [stationId, setStationId] = useState(product?.station_id ?? kitchen?.id ?? '')
  const [favorite, setFavorite] = useState(product?.is_favorite ?? false)
  const [active, setActive] = useState(product?.active ?? true)
  const [groupIds, setGroupIds] = useState<Set<string>>(new Set(product?.groups.map((g) => g.id)))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function toggleGroup(id: string) {
    setGroupIds((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const amount = Number(price.replace(/\./g, '').replace(',', '.'))
    if (!Number.isFinite(amount) || amount < 0) {
      setError('Ingresá un precio válido, por ejemplo 12500.')
      return
    }
    setBusy(true)
    setError(null)
    const values = {
      name: name.trim(),
      price: amount,
      description: description.trim() || null,
      category_id: categoryId || null,
      station_id: stationId || null,
      is_favorite: favorite,
      active,
    }
    const res = product
      ? await supabase.from('products').update(values).eq('id', product.id).select('id').single()
      : await supabase.from('products').insert({ ...values, restaurant_id: restaurantId }).select('id').single()
    if (res.error) {
      setError(errorMessage(res.error))
      setBusy(false)
      return
    }
    const productId = res.data.id

    // Sincroniza los grupos de modificadores del producto
    const before = new Set(product?.groups.map((g) => g.id))
    const toRemove = [...before].filter((id) => !groupIds.has(id))
    const toAdd = [...groupIds].filter((id) => !before.has(id))
    if (toRemove.length) {
      const { error } = await supabase
        .from('product_modifier_groups')
        .delete()
        .eq('product_id', productId)
        .in('group_id', toRemove)
      if (error) return fail(error)
    }
    if (toAdd.length) {
      const { error } = await supabase
        .from('product_modifier_groups')
        .insert(toAdd.map((group_id, i) => ({ restaurant_id: restaurantId, product_id: productId, group_id, sort_order: i })))
      if (error) return fail(error)
    }
    await onSaved()
  }

  function fail(err: unknown) {
    setError(errorMessage(err))
    setBusy(false)
  }

  return (
    <Sheet title={product ? 'Editar producto' : 'Nuevo producto'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="p-name">Nombre</label>
          <input id="p-name" required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Milanesa napolitana" />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="p-price">Precio</label>
            <input id="p-price" required inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="12500" />
          </div>
          <div className="field">
            <label htmlFor="p-station">Se prepara en</label>
            <select id="p-station" value={stationId} onChange={(e) => setStationId(e.target.value)}>
              <option value="">No va a cocina</option>
              {menu.stations.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="p-cat">Categoría</label>
          <select id="p-cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            <option value="">Sin categoría</option>
            {menu.categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="p-desc">Descripción</label>
          <textarea id="p-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        {menu.groups.length > 0 && (
          <fieldset className="fieldset">
            <legend>Modificadores</legend>
            {menu.groups.map((g) => (
              <label key={g.id} className="check">
                <input type="checkbox" checked={groupIds.has(g.id)} onChange={() => toggleGroup(g.id)} />
                {g.name}
                <span className="muted"> · {g.modifiers.map((m) => m.name).join(', ') || 'sin opciones'}</span>
              </label>
            ))}
          </fieldset>
        )}

        <label className="check">
          <input type="checkbox" checked={favorite} onChange={(e) => setFavorite(e.target.checked)} />
          Favorito (aparece primero al tomar pedidos)
        </label>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Disponible para vender
        </label>

        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" disabled={busy}>Guardar producto</button>
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Sheet>
  )
}
