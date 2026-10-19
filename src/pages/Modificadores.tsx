import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { useMenu, type ModifierGroup } from '../lib/menu'
import { TopBar } from '../components/AppShell'
import { Sheet } from '../components/Sheet'

function ruleLabel(g: Pick<ModifierGroup, 'min_select' | 'max_select'>) {
  if (g.min_select === 1 && g.max_select === 1) return 'Obligatorio, elegir 1'
  if (g.min_select === 0 && g.max_select === 1) return 'Opcional, hasta 1'
  if (g.min_select === 0) return `Opcional, hasta ${g.max_select}`
  return `Elegir entre ${g.min_select} y ${g.max_select}`
}

export function Modificadores() {
  const { restaurant } = useCurrentRestaurant()
  const { menu, loading, error, reload } = useMenu(restaurant.id, true)
  const [editing, setEditing] = useState<ModifierGroup | 'new' | null>(null)

  return (
    <>
      <TopBar title="Modificadores" />
      <div className="content">
        <p className="muted" style={{ marginBottom: 16 }}>
          Grupos de opciones que se eligen al pedir un producto, como el punto de la carne o la guarnición.{' '}
          <Link to="/carta">Volver a la carta</Link>
        </p>
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => setEditing('new')}>Nuevo grupo</button>
        </div>

        {loading ? (
          <p className="muted">Cargando…</p>
        ) : menu.groups.length === 0 ? (
          <div className="empty">
            <h2>Todavía no hay modificadores</h2>
            <p className="muted">Creá un grupo, por ejemplo "Punto de la carne" con Jugoso, A punto y Cocido.</p>
          </div>
        ) : (
          <div className="list">
            {menu.groups.map((g) => (
              <button key={g.id} className="list-row" onClick={() => setEditing(g)}>
                <span className="product-line">
                  <span>{g.name}</span>
                  <span className="product-sub">
                    {ruleLabel(g)} · {g.modifiers.map((m) => m.name).join(', ') || 'sin opciones'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <GroupSheet
          restaurantId={restaurant.id}
          group={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await reload()
            setEditing(null)
          }}
        />
      )}
    </>
  )
}

type OptionDraft = { id: string | null; name: string; price: string }

function GroupSheet({
  restaurantId,
  group,
  onClose,
  onSaved,
}: {
  restaurantId: string
  group: ModifierGroup | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [name, setName] = useState(group?.name ?? '')
  const [min, setMin] = useState(group?.min_select ?? 0)
  const [max, setMax] = useState(group?.max_select ?? 1)
  const [options, setOptions] = useState<OptionDraft[]>(
    group?.modifiers.map((m) => ({ id: m.id, name: m.name, price: m.price_delta ? String(m.price_delta) : '' })) ?? [
      { id: null, name: '', price: '' },
    ],
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const setOption = (i: number, patch: Partial<OptionDraft>) =>
    setOptions((cur) => cur.map((o, j) => (j === i ? { ...o, ...patch } : o)))

  async function submit(e: FormEvent) {
    e.preventDefault()
    const clean = options.filter((o) => o.name.trim())
    if (clean.length === 0) return setError('Agregá al menos una opción.')
    if (max < 1 || min < 0 || max < min) return setError('Revisá el mínimo y el máximo: el máximo tiene que ser 1 o más y no menor al mínimo.')
    if (min > clean.length) return setError('El mínimo no puede ser mayor que la cantidad de opciones.')
    const prices = clean.map((o) => (o.price.trim() ? Number(o.price.replace(/\./g, '').replace(',', '.')) : 0))
    if (prices.some((p) => !Number.isFinite(p))) return setError('Hay un precio adicional inválido.')

    setBusy(true)
    setError(null)
    const values = { name: name.trim(), min_select: min, max_select: max }
    const res = group
      ? await supabase.from('modifier_groups').update(values).eq('id', group.id).select('id').single()
      : await supabase.from('modifier_groups').insert({ ...values, restaurant_id: restaurantId }).select('id').single()
    if (res.error) return fail(res.error)
    const groupId = res.data.id

    // Opciones: actualizar las existentes, crear las nuevas, borrar las quitadas.
    // Borrar es seguro: las ventas guardan una copia del nombre y precio del modificador.
    const kept = new Set(clean.filter((o) => o.id).map((o) => o.id as string))
    const removed = (group?.modifiers ?? []).filter((m) => !kept.has(m.id)).map((m) => m.id)
    if (removed.length) {
      const { error } = await supabase.from('modifiers').delete().in('id', removed)
      if (error) return fail(error)
    }
    for (const [i, o] of clean.entries()) {
      const row = { name: o.name.trim(), price_delta: prices[i] ?? 0, sort_order: i }
      const { error } = o.id
        ? await supabase.from('modifiers').update(row).eq('id', o.id)
        : await supabase.from('modifiers').insert({ ...row, restaurant_id: restaurantId, group_id: groupId })
      if (error) return fail(error)
    }
    await onSaved()
  }

  function fail(err: unknown) {
    setError(errorMessage(err))
    setBusy(false)
  }

  return (
    <Sheet title={group ? 'Editar grupo' : 'Nuevo grupo'} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="g-name">Nombre del grupo</label>
          <input id="g-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej.: Punto de la carne" />
        </div>
        <div className="field-row">
          <div className="field">
            <label htmlFor="g-min">Mínimo a elegir</label>
            <input id="g-min" type="number" inputMode="numeric" min={0} value={min} onChange={(e) => setMin(Number(e.target.value))} />
          </div>
          <div className="field">
            <label htmlFor="g-max">Máximo a elegir</label>
            <input id="g-max" type="number" inputMode="numeric" min={1} value={max} onChange={(e) => setMax(Number(e.target.value))} />
          </div>
        </div>
        <span className="hint muted">{ruleLabel({ min_select: min, max_select: max })}. Mínimo 0 = opcional.</span>

        <fieldset className="fieldset">
          <legend>Opciones</legend>
          {options.map((o, i) => (
            <div key={o.id ?? `new-${i}`} className="option-row">
              <input
                aria-label={`Opción ${i + 1}`}
                value={o.name}
                onChange={(e) => setOption(i, { name: e.target.value })}
                placeholder="Nombre"
              />
              <input
                aria-label={`Precio adicional de la opción ${i + 1}`}
                inputMode="decimal"
                value={o.price}
                onChange={(e) => setOption(i, { price: e.target.value })}
                placeholder="+ $0"
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={`Quitar opción ${i + 1}`}
                onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          <button type="button" className="link-btn" onClick={() => setOptions((cur) => [...cur, { id: null, name: '', price: '' }])}>
            Agregar opción
          </button>
        </fieldset>

        {error && <div className="notice notice-error" role="alert">{error}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" disabled={busy}>Guardar grupo</button>
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancelar</button>
        </div>
      </form>
    </Sheet>
  )
}
