import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { formatElapsed, minutesSince } from '../lib/format'
import { itemModifiers, orderTitle, setItemsStatus, useSyncedReload, type ItemStatus, type Order, type OrderItem } from '../lib/orders'
import { cachedQuery, type Filter } from '../lib/offline'
import type { Tables } from '../lib/database.types'

type Station = Tables<'stations'>
type Ticket = { order: Order; items: OrderItem[]; since: string }

const ALL = 'todas'
const RECENT_MIN = 30 // minutos que siguen visibles los listos y los cancelados
const WARN_MIN = 10
const LATE_MIN = 20

const next: Partial<Record<ItemStatus, ItemStatus>> = { sent: 'preparing', preparing: 'ready' }

/** Pitido corto con Web Audio: no necesita archivos ni red. */
function beep(ctx: AudioContext) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = 880
  gain.gain.setValueAtTime(0.0001, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.4, ctx.currentTime + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35)
  osc.connect(gain).connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + 0.4)
}

export function Cocina() {
  const { restaurant } = useCurrentRestaurant()
  const rid = restaurant.id
  const [items, setItems] = useState<OrderItem[]>([])
  const [orders, setOrders] = useState<Map<string, Order>>(new Map())
  const [tables, setTables] = useState<Map<string, string>>(new Map())
  const [stations, setStations] = useState<Station[]>([])
  const [station, setStation] = useState<string>(ALL)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const audio = useRef<AudioContext | null>(null)
  const [soundOn, setSoundOn] = useState(false)
  const known = useRef<Set<string> | null>(null)

  const load = useCallback(async () => {
    const since = new Date(Date.now() - RECENT_MIN * 60_000).toISOString()
    // Sin filtro de estado en la superposición: un "listo" marcado sin conexión mueve el ítem
    // de "activos" a "recientes" y la clasificación se hace acá abajo.
    const byRestaurant: Filter[] = [{ col: 'restaurant_id', op: 'eq', value: rid }]
    const [active, recent] = await Promise.all([
      cachedQuery<OrderItem>(`cocina:${rid}:active`, 'order_items', byRestaurant, () =>
        supabase.from('order_items').select('*').eq('restaurant_id', rid).in('status', ['sent', 'preparing']),
      ),
      cachedQuery<OrderItem>(`cocina:${rid}:recent`, 'order_items', byRestaurant, () =>
        supabase
          .from('order_items')
          .select('*')
          .eq('restaurant_id', rid)
          .in('status', ['ready', 'cancelled'])
          .not('sent_at', 'is', null)
          .gte('updated_at', since),
      ),
    ])
    if (active.error || recent.error) {
      setError(errorMessage(active.error ?? recent.error))
      setLoading(false)
      return
    }
    const merged = new Map<string, OrderItem>()
    for (const i of [...recent.data, ...active.data]) merged.set(i.id, i)
    const all = [...merged.values()].filter(
      (i) =>
        i.status === 'sent' ||
        i.status === 'preparing' ||
        ((i.status === 'ready' || i.status === 'cancelled') && i.sent_at !== null && i.updated_at >= since),
    )
    const orderIds = [...new Set(all.map((i) => i.order_id))]
    const o = await cachedQuery<Order>(`cocina:${rid}:orders`, 'orders', [{ col: 'id', op: 'in', value: orderIds }], () =>
      orderIds.length ? supabase.from('orders').select('*').in('id', orderIds) : Promise.resolve({ data: [] as Order[], error: null }),
    )
    if (o.error) setError(errorMessage(o.error))
    else {
      setOrders(new Map(o.data.map((x) => [x.id, x])))
      setItems(all)
      setError(null)
    }

    // Aviso sonoro si entró algo nuevo para preparar
    const sentIds = new Set(all.filter((i) => i.status === 'sent').map((i) => i.id))
    if (known.current && audio.current) {
      for (const id of sentIds) {
        if (!known.current.has(id)) {
          beep(audio.current)
          break
        }
      }
    }
    known.current = sentIds
    setLoading(false)
  }, [rid])

  useSyncedReload(load)

  useEffect(() => {
    async function init() {
      const [s, t] = await Promise.all([
        cachedQuery<Station>(`cocina:${rid}:stations`, 'stations', [], () =>
          supabase.from('stations').select('*').eq('restaurant_id', rid).eq('active', true).order('sort_order'),
        ),
        cachedQuery<{ id: string; name: string }>(`cocina:${rid}:tables`, 'tables', [], () =>
          supabase.from('tables').select('id, name').eq('restaurant_id', rid),
        ),
      ])
      if (s.data) setStations(s.data)
      if (t.data) setTables(new Map(t.data.map((x) => [x.id, x.name])))
    }
    void init()
    void load()
    const channel = supabase
      .channel(`cocina-${rid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items', filter: `restaurant_id=eq.${rid}` }, () => void load())
      .subscribe()
    const tick = setInterval(() => setNow(Date.now()), 15_000)
    return () => {
      void supabase.removeChannel(channel)
      clearInterval(tick)
    }
  }, [rid, load])

  function toggleSound() {
    if (soundOn) {
      setSoundOn(false)
      void audio.current?.close()
      audio.current = null
      return
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    audio.current = new Ctx()
    beep(audio.current)
    setSoundOn(true)
  }

  const { preparing, ready } = useMemo(() => {
    const visible = items.filter((i) => station === ALL || i.station_id === station)
    const byOrder = new Map<string, OrderItem[]>()
    for (const i of visible) byOrder.set(i.order_id, [...(byOrder.get(i.order_id) ?? []), i])
    const preparing: Ticket[] = []
    const ready: Ticket[] = []
    for (const [orderId, list] of byOrder) {
      const order = orders.get(orderId)
      if (!order) continue
      const sorted = [...list].sort((a, b) => (a.sent_at ?? '').localeCompare(b.sent_at ?? ''))
      const since = sorted[0]?.sent_at ?? order.opened_at
      const open = sorted.some((i) => i.status === 'sent' || i.status === 'preparing')
      if (open) preparing.push({ order, items: sorted, since })
      else if (sorted.some((i) => i.status === 'ready')) ready.push({ order, items: sorted.filter((i) => i.status === 'ready'), since })
    }
    preparing.sort((a, b) => a.since.localeCompare(b.since))
    ready.sort((a, b) => b.since.localeCompare(a.since))
    return { preparing, ready }
  }, [items, orders, station])

  async function setStatus(ids: string[], status: ItemStatus) {
    if (!ids.length) return
    // Actualización optimista: la cocina no espera a la red para ver el cambio
    setItems((cur) => cur.map((i) => (ids.includes(i.id) ? { ...i, status } : i)))
    const label = status === 'ready' ? 'Cocina: marcar listo' : status === 'preparing' ? 'Cocina: empezar' : 'Cocina: cambiar estado'
    const { error } = await setItemsStatus(ids, status, label)
    if (error) setError(errorMessage(error))
    void load()
  }

  const titleOf = (o: Order) => orderTitle(o, o.table_id ? tables.get(o.table_id) : null)

  return (
    <div className="kds">
      <header className="kds-head">
        <h1>Cocina</h1>
        <div className="kds-controls">
          <div className="areas kds-stations" role="group" aria-label="Estación">
            <button aria-pressed={station === ALL} onClick={() => setStation(ALL)}>Todas</button>
            {stations.map((s) => (
              <button key={s.id} aria-pressed={station === s.id} onClick={() => setStation(s.id)}>{s.name}</button>
            ))}
          </div>
          <button className={`kds-sound${soundOn ? ' on' : ''}`} onClick={toggleSound} aria-pressed={soundOn}>
            {soundOn ? 'Sonido activado' : 'Activar sonido'}
          </button>
        </div>
      </header>

      {error && <div className="notice notice-error" role="alert">{error}</div>}

      {loading ? (
        <p className="kds-empty">Cargando pedidos…</p>
      ) : preparing.length === 0 ? (
        <p className="kds-empty">No hay pedidos para preparar.</p>
      ) : (
        <div className="kds-board">
          {preparing.map(({ order, items: list, since }) => {
            const mins = minutesSince(since, now)
            const level = mins >= LATE_MIN ? 'late' : mins >= WARN_MIN ? 'warn' : 'ok'
            const actionable = list.filter((i) => i.status === 'sent' || i.status === 'preparing')
            const notStarted = list.filter((i) => i.status === 'sent')
            return (
              <article key={order.id} className={`kds-ticket ${level}`} aria-label={`Pedido ${titleOf(order)}`}>
                <header className="kds-ticket-head">
                  <span className="kds-where">{titleOf(order)}</span>
                  <span className="kds-time">{formatElapsed(mins)}</span>
                </header>
                <div className="kds-meta">#{order.number}</div>
                <ul className="kds-items">
                  {list.map((i) => {
                    const mods = itemModifiers(i)
                    return (
                      <li key={i.id} className={`kds-item ${i.status}`}>
                        <button
                          onClick={() => {
                            const n = next[i.status]
                            if (n) void setStatus([i.id], n)
                          }}
                          disabled={!next[i.status]}
                          aria-label={`${i.quantity} ${i.name}, ${i.status === 'sent' ? 'tocar para empezar' : i.status === 'preparing' ? 'tocar para marcar listo' : i.status === 'cancelled' ? 'cancelado' : 'listo'}`}
                        >
                          <span className="kds-qty">{i.quantity}</span>
                          <span className="kds-text">
                            <span className="kds-name">{i.name}</span>
                            {mods.length > 0 && <span className="kds-mods">{mods.map((m) => m.name).join(' · ')}</span>}
                            {i.notes && <span className="kds-note">{i.notes}</span>}
                          </span>
                          <span className="kds-state">
                            {i.status === 'preparing' ? 'En preparación' : i.status === 'ready' ? 'Listo' : i.status === 'cancelled' ? 'Cancelado' : ''}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
                <div className="kds-actions">
                  {notStarted.length > 0 && (
                    <button className="btn btn-quiet" onClick={() => void setStatus(notStarted.map((i) => i.id), 'preparing')}>
                      Empezar
                    </button>
                  )}
                  <button className="btn btn-primary" onClick={() => void setStatus(actionable.map((i) => i.id), 'ready')}>
                    Todo listo
                  </button>
                </div>
              </article>
            )
          })}
        </div>
      )}

      {ready.length > 0 && (
        <section className="kds-ready" aria-label="Listos para servir">
          <h2>Listos para servir</h2>
          <div className="kds-ready-list">
            {ready.map(({ order, items: list }) => (
              <div key={order.id} className="kds-ready-card">
                <span>
                  <strong>{titleOf(order)}</strong>
                  <span className="kds-ready-items"> {list.map((i) => `${i.quantity} ${i.name}`).join(', ')}</span>
                </span>
                <button className="link-btn" onClick={() => void setStatus(list.map((i) => i.id), 'preparing')}>
                  Deshacer
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
