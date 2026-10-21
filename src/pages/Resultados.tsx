import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { formatMoney } from '../lib/format'
import { categoryLabel, type ExpenseCategory } from '../lib/purchases'
import { TopBar } from '../components/AppShell'
import { BarChart, type Bar } from '../components/BarChart'

export type IncomeMonth = {
  month: string // YYYY-MM
  orders: number
  sales: number
  discounts: number
  tips: number
  cogs: number
  sales_without_recipe: number
  inventory_purchases: number
  expenses: Partial<Record<ExpenseCategory, number>>
}

const monthFmt = new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const shortFmt = new Intl.DateTimeFormat('es-AR', { month: 'short', timeZone: 'UTC' })
const monthDate = (m: string) => new Date(`${m}-01T00:00:00Z`)
export const monthName = (m: string) => {
  const s = monthFmt.format(monthDate(m))
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const expensesTotal = (m: IncomeMonth) => Object.values(m.expenses).reduce((s, v) => s + (v ?? 0), 0)
export const grossProfit = (m: IncomeMonth) => m.sales - m.cogs
export const netResult = (m: IncomeMonth) => grossProfit(m) - expensesTotal(m)
const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—')

/** Estado de resultados mes a mes: ventas − costo de lo vendido − gastos (dueño o encargado). */
export function Resultados() {
  const { restaurant } = useCurrentRestaurant()
  const navigate = useNavigate()
  const [months, setMonths] = useState(6)
  const [data, setData] = useState<IncomeMonth[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setError(null)
    void supabase.rpc('income_statement', { p_restaurant: restaurant.id, p_months: months }).then(({ data, error }) => {
      if (!alive) return
      if (error) return setError(errorMessage(error))
      const rows = (data ?? []) as unknown as IncomeMonth[]
      setData(rows)
      setSelected((cur) => (cur && rows.some((r) => r.month === cur) ? cur : rows.at(-1)?.month ?? null))
    })
    return () => {
      alive = false
    }
  }, [restaurant.id, months])

  const bars: Bar[] = useMemo(
    () =>
      (data ?? []).map((m) => ({
        key: m.month,
        label: shortFmt.format(monthDate(m.month)).replace('.', ''),
        value: m.sales,
        detail: `resultado ${formatMoney(netResult(m))}`,
      })),
    [data],
  )

  const month = data?.find((m) => m.month === selected) ?? null
  const empty = data !== null && data.every((m) => m.sales === 0 && expensesTotal(m) === 0 && m.inventory_purchases === 0)

  return (
    <>
      <TopBar title="Estado de resultados" />
      <div className="content">
        <div className="areas" role="group" aria-label="Período">
          {[6, 12].map((n) => (
            <button key={n} aria-pressed={n === months} onClick={() => setMonths(n)}>Últimos {n} meses</button>
          ))}
        </div>

        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {!data && !error && <p className="muted">Calculando…</p>}

        {empty && (
          <div className="empty">
            <h2>Todavía no hay movimientos</h2>
            <p className="muted">El estado de resultados se arma con las ventas cerradas y las compras y gastos que cargues.</p>
            <button className="btn btn-primary" onClick={() => navigate('/compras/nueva')}>Cargar un gasto</button>
          </div>
        )}

        {data && !empty && (
          <>
            <div className="areas month-chips" role="group" aria-label="Mes">
              {data.map((m) => (
                <button key={m.month} aria-pressed={m.month === selected} onClick={() => setSelected(m.month)}>
                  {shortFmt.format(monthDate(m.month)).replace('.', '')}
                </button>
              ))}
            </div>

            {month && <Statement month={month} />}

            <section className="section">
              <BarChart title="Ventas por mes" bars={bars} emptyText="Sin ventas en estos meses." />
            </section>

            <section className="section">
              <h2>Mes a mes</h2>
              <div className="table-wrap">
                <table className="report-table">
                  <thead>
                    <tr>
                      <th scope="col">Mes</th>
                      <th scope="col" className="num">Ventas</th>
                      <th scope="col" className="num">Costo</th>
                      <th scope="col" className="num">Gastos</th>
                      <th scope="col" className="num">Resultado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data].reverse().map((m) => {
                      const r = netResult(m)
                      return (
                        <tr key={m.month}>
                          <th scope="row">{monthName(m.month)}</th>
                          <td className="num">{formatMoney(m.sales)}</td>
                          <td className="num">{formatMoney(m.cogs)}</td>
                          <td className="num">{formatMoney(expensesTotal(m))}</td>
                          <td className={`num ${r < 0 ? 'neg' : ''}`}>{formatMoney(r)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </>
  )
}

function Statement({ month: m }: { month: IncomeMonth }) {
  const expenses = (Object.entries(m.expenses) as [ExpenseCategory, number][]).sort((a, b) => b[1] - a[1])
  const totalExp = expensesTotal(m)
  const gross = grossProfit(m)
  const result = netResult(m)

  return (
    <section className="section">
      <h2>{monthName(m.month)}</h2>
      <dl className="pnl" aria-label={`Estado de resultados de ${monthName(m.month)}`}>
        <div className="pnl-row pnl-strong">
          <dt>Ventas</dt>
          <dd>{formatMoney(m.sales)}</dd>
        </div>
        <div className="pnl-row pnl-sub">
          <dt>{m.orders} comanda{m.orders === 1 ? '' : 's'}{m.discounts > 0 ? ` · descuentos ${formatMoney(m.discounts)}` : ''}</dt>
          <dd />
        </div>
        <div className="pnl-row">
          <dt>Costo de lo vendido</dt>
          <dd>−{formatMoney(m.cogs)}</dd>
        </div>
        <div className="pnl-row pnl-total">
          <dt>Margen bruto <span className="muted">{pct(gross, m.sales)}</span></dt>
          <dd>{formatMoney(gross)}</dd>
        </div>
        {expenses.map(([cat, amount]) => (
          <div className="pnl-row" key={cat}>
            <dt>{categoryLabel[cat]}</dt>
            <dd>−{formatMoney(amount)}</dd>
          </div>
        ))}
        {expenses.length === 0 && (
          <div className="pnl-row pnl-sub">
            <dt>Sin gastos cargados este mes</dt>
            <dd />
          </div>
        )}
        <div className={`pnl-row pnl-result ${result < 0 ? 'neg' : ''}`}>
          <dt>Resultado <span className="muted">{pct(result, m.sales)}</span></dt>
          <dd>{formatMoney(result)}</dd>
        </div>
      </dl>
      {totalExp === 0 && m.sales > 0 && <p className="hint muted">Cargá alquiler, sueldos y servicios en Compras y gastos para ver el resultado real.</p>}

      <div className="pnl-notes">
        {m.sales_without_recipe > 0 && (
          <div className="notice notice-warn">
            {formatMoney(m.sales_without_recipe)} de ventas son de productos sin receta: su costo no está incluido. Cargá la receta en la Carta.
          </div>
        )}
        <p className="muted">
          Compras de mercadería y bebidas: {formatMoney(m.inventory_purchases)}. Van al stock y se cuentan como costo cuando se venden.
          {m.tips > 0 && ` Propinas: ${formatMoney(m.tips)} (del personal, no suman a las ventas).`}
        </p>
        <p className="hint muted">El costo usa el costo actual de los insumos. Es una referencia de gestión, no un balance contable.</p>
      </div>
    </section>
  )
}
