import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { rangeFor, useSalesReport } from '../lib/reports'
import { formatMoney } from '../lib/format'
import { formatQty, isLow, type Ingredient } from '../lib/stock'
import { TopBar } from '../components/AppShell'
import { Kpis } from './Reportes'

const today = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })
const time = new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' })

type Live = {
  tables: number
  busyTables: number
  openOrders: number
  toCollect: number
  inKitchen: number
  lateInKitchen: number
  cashOpenedAt: string | null
  low: Ingredient[]
}

const LATE_MIN = 20

const capitalize = (t: string) => t.charAt(0).toLocaleUpperCase('es') + t.slice(1)

/** Tablero del dueño: lo que pasa ahora y cómo va el día, en una pantalla. */
export function Inicio() {
  const { restaurant } = useCurrentRestaurant()
  const rid = restaurant.id
  const range = useMemo(() => rangeFor('today'), [])
  const { report, reload: reloadReport } = useSalesReport(rid, range)
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [t, o, k, c, i] = await Promise.all([
      supabase.from('tables').select('id').eq('restaurant_id', rid).eq('active', true),
      supabase.from('orders').select('id, table_id, total, paid_total').eq('restaurant_id', rid).eq('status', 'open'),
      supabase.from('order_items').select('id, sent_at').eq('restaurant_id', rid).in('status', ['sent', 'preparing']),
      supabase.from('cash_sessions').select('opened_at').eq('restaurant_id', rid).is('closed_at', null).limit(1),
      supabase.from('ingredients').select('*').eq('restaurant_id', rid).eq('active', true),
    ])
    const failed = [t, o, k, c, i].find((x) => x.error)
    if (failed?.error) return setError(errorMessage(failed.error))
    const orders = o.data ?? []
    const limit = Date.now() - LATE_MIN * 60_000
    setLive({
      tables: t.data?.length ?? 0,
      busyTables: new Set(orders.filter((x) => x.table_id).map((x) => x.table_id)).size,
      openOrders: orders.length,
      toCollect: orders.reduce((s, x) => s + Math.max(x.total - x.paid_total, 0), 0),
      inKitchen: k.data?.length ?? 0,
      lateInKitchen: (k.data ?? []).filter((x) => x.sent_at && new Date(x.sent_at).getTime() < limit).length,
      cashOpenedAt: c.data?.[0]?.opened_at ?? null,
      low: (i.data ?? []).filter(isLow).sort((a, b) => a.name.localeCompare(b.name, 'es')),
    })
    setError(null)
  }, [rid])

  useEffect(() => {
    void load()
    const channel = supabase
      .channel(`inicio-${rid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `restaurant_id=eq.${rid}` }, () => {
        void load()
        void reloadReport()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items', filter: `restaurant_id=eq.${rid}` }, () => void load())
      .subscribe()
    const timer = setInterval(() => void load(), 60_000)
    return () => {
      void supabase.removeChannel(channel)
      clearInterval(timer)
    }
  }, [rid, load, reloadReport])

  return (
    <>
      <TopBar title="Inicio" />
      <div className="content">
        <p className="muted today">{capitalize(today.format(new Date()))}</p>
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        {report && <Kpis report={report} />}

        {live && (
          <section className="section">
            <h2>Ahora</h2>
            <div className="now-grid">
              <Link to="/salon" className="now-card">
                <span className="now-value">{live.busyTables}<span className="now-of">/{live.tables}</span></span>
                <span className="now-label">mesas ocupadas</span>
              </Link>
              <Link to="/comandas" className="now-card">
                <span className="now-value">{formatMoney(live.toCollect)}</span>
                <span className="now-label">por cobrar en {live.openOrders} comanda{live.openOrders === 1 ? '' : 's'}</span>
              </Link>
              <Link to="/cocina" className={`now-card${live.lateInKitchen ? ' alert' : ''}`}>
                <span className="now-value">{live.inKitchen}</span>
                <span className="now-label">
                  {live.inKitchen === 1 ? 'plato en cocina' : 'platos en cocina'}
                  {live.lateInKitchen > 0 && ` · ${live.lateInKitchen} con más de ${LATE_MIN} min`}
                </span>
              </Link>
              <Link to="/caja" className={`now-card${live.cashOpenedAt ? '' : ' warn'}`}>
                <span className="now-value">{live.cashOpenedAt ? 'Abierta' : 'Cerrada'}</span>
                <span className="now-label">
                  {live.cashOpenedAt ? `caja desde las ${time.format(new Date(live.cashOpenedAt))}` : 'abrila para cobrar en efectivo'}
                </span>
              </Link>
            </div>
          </section>
        )}

        {live && live.low.length > 0 && (
          <section className="section">
            <div className="section-head">
              <h2>Faltantes de stock</h2>
              <Link className="link-btn" to="/stock">Ver stock</Link>
            </div>
            <div className="list">
              {live.low.slice(0, 6).map((i) => (
                <div key={i.id} className="list-row">
                  <span className="product-line">
                    <span>{i.name}</span>
                    <span className="product-sub">Mínimo {formatQty(i.min_stock, i.unit)}</span>
                  </span>
                  <span className="price neg">{formatQty(i.stock_qty, i.unit)}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        <Link className="btn btn-quiet" to="/reportes">Ver reportes</Link>
      </div>
    </>
  )
}
