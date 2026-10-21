import { useMemo, useState } from 'react'
import { useCurrentRestaurant } from '../lib/restaurant'
import { rangeFor, rangeLabel, useSalesReport, type RangeKey, type SalesReport } from '../lib/reports'
import { formatMoney } from '../lib/format'
import { orderTypeLabel } from '../lib/orders'
import { TopBar } from '../components/AppShell'
import { BarChart, ShareBars, type Bar } from '../components/BarChart'

const dayFmt = new Intl.DateTimeFormat('es-AR', { day: 'numeric', month: 'numeric', timeZone: 'UTC' })
const qtyFmt = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 })

export function Reportes() {
  const { restaurant } = useCurrentRestaurant()
  const [key, setKey] = useState<RangeKey>('today')
  const range = useMemo(() => rangeFor(key), [key])
  const { report, loading, error } = useSalesReport(restaurant.id, range)

  return (
    <>
      <TopBar title="Reportes" />
      <div className="content">
        <div className="areas" role="group" aria-label="Período">
          {(Object.keys(rangeLabel) as RangeKey[]).map((k) => (
            <button key={k} aria-pressed={k === key} onClick={() => setKey(k)}>{rangeLabel[k]}</button>
          ))}
        </div>

        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {loading && !report ? <p className="muted">Calculando…</p> : report && <ReportBody report={report} rangeKey={key} />}
      </div>
    </>
  )
}

export function Kpis({ report }: { report: SalesReport }) {
  const t = report.totals
  const avg = t.orders ? t.sales / t.orders : 0
  return (
    <div className="kpis">
      <div className="kpi kpi-main">
        <span className="kpi-label">Ventas</span>
        <span className="kpi-value">{formatMoney(t.sales)}</span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Comandas</span>
        <span className="kpi-value">{t.orders}</span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Ticket promedio</span>
        <span className="kpi-value">{formatMoney(avg)}</span>
      </div>
      <div className="kpi">
        <span className="kpi-label">Propinas</span>
        <span className="kpi-value">{formatMoney(t.tips)}</span>
      </div>
      {t.discounts > 0 && (
        <div className="kpi">
          <span className="kpi-label">Descuentos</span>
          <span className="kpi-value">{formatMoney(t.discounts)}</span>
        </div>
      )}
    </div>
  )
}

function ReportBody({ report, rangeKey }: { report: SalesReport; rangeKey: RangeKey }) {
  const singleDay = rangeKey === 'today' || rangeKey === 'yesterday'

  const bars: Bar[] = useMemo(() => {
    if (singleDay) {
      // Del primer al último horario con ventas, completando las horas vacías
      const hours = report.by_hour.map((h) => h.hour)
      if (!hours.length) return []
      const lo = Math.min(...hours)
      const hi = Math.max(...hours)
      return Array.from({ length: hi - lo + 1 }, (_, i) => {
        const h = lo + i
        const row = report.by_hour.find((x) => x.hour === h)
        return {
          key: String(h),
          label: `${h} h`,
          value: row?.sales ?? 0,
          detail: row ? `${row.orders} comanda${row.orders === 1 ? '' : 's'}` : undefined,
        }
      })
    }
    return report.by_day.map((d) => ({
      key: d.day,
      label: dayFmt.format(new Date(`${d.day}T00:00:00Z`)),
      value: d.sales,
      detail: `${d.orders} comanda${d.orders === 1 ? '' : 's'}`,
    }))
  }, [report, singleDay])

  if (report.totals.orders === 0) {
    return (
      <div className="empty">
        <h2>No hay ventas cerradas en este período</h2>
        <p className="muted">Las ventas aparecen acá cuando se cobra y se cierra cada comanda.</p>
      </div>
    )
  }

  const withRecipe = report.products.filter((p) => p.has_recipe)
  const costTotal = withRecipe.reduce((s, p) => s + p.cost, 0)
  const revenueWithRecipe = withRecipe.reduce((s, p) => s + (p.costed_revenue ?? 0), 0)

  return (
    <>
      <Kpis report={report} />

      <section className="section">
        <BarChart
          title={singleDay ? 'Ventas por hora' : 'Ventas por día'}
          bars={bars}
          emptyText="Sin ventas en este período."
        />
      </section>

      <div className="report-grid">
        <section className="section">
          <h2>Medios de pago</h2>
          <ShareBars
            rows={report.by_payment.map((p) => ({
              key: p.method,
              label: p.method,
              value: p.amount,
              detail: `${p.count} cobro${p.count === 1 ? '' : 's'}`,
            }))}
          />
        </section>
        <section className="section">
          <h2>Canales</h2>
          <ShareBars
            rows={report.by_type.map((t) => ({
              key: t.type,
              label: orderTypeLabel[t.type],
              value: t.sales,
              detail: `${t.orders} comanda${t.orders === 1 ? '' : 's'}`,
            }))}
          />
        </section>
      </div>

      <section className="section">
        <h2>Productos</h2>
        {withRecipe.length > 0 && (
          <p className="muted">
            Costo de lo vendido con receta: {formatMoney(costTotal)} sobre {formatMoney(revenueWithRecipe)} (
            {revenueWithRecipe ? Math.round((costTotal / revenueWithRecipe) * 100) : 0}% de costo de mercadería). Se calcula con el costo de los insumos al momento de cada venta.
          </p>
        )}
        <div className="table-wrap">
          <table className="report-table">
            <thead>
              <tr>
                <th scope="col">Producto</th>
                <th scope="col" className="num">Cant.</th>
                <th scope="col" className="num">Ventas</th>
                <th scope="col" className="num">Margen</th>
              </tr>
            </thead>
            <tbody>
              {report.products.map((p) => {
                const costed = p.costed_revenue ?? 0
                const margin = p.has_recipe && costed > 0 ? Math.round(((costed - p.cost) / costed) * 100) : null
                return (
                  <tr key={`${p.product_id ?? ''}-${p.name}`}>
                    <th scope="row">{p.name}</th>
                    <td className="num">{qtyFmt.format(p.qty)}</td>
                    <td className="num">{formatMoney(p.revenue)}</td>
                    <td className="num">{margin === null ? <span className="muted">Sin receta</span> : `${margin}%`}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="hint muted">Ventas por producto antes de descuentos.</p>
      </section>
    </>
  )
}
