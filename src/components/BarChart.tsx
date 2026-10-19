import { useId, useState } from 'react'
import { formatMoney } from '../lib/format'

export type Bar = { key: string; label: string; value: number; detail?: string }

/**
 * Barras verticales de una sola serie (un solo tono: no necesita leyenda; el título la nombra).
 * Marcas finas apoyadas en la base con punta redondeada, grilla tenue, solo la barra pico rotulada,
 * tooltip al pasar el mouse o enfocar con teclado, y tabla equivalente para lectores de pantalla.
 */
export function BarChart({ title, bars, emptyText }: { title: string; bars: Bar[]; emptyText: string }) {
  const [active, setActive] = useState<string | null>(null)
  const id = useId()
  const max = Math.max(0, ...bars.map((b) => b.value))

  if (max === 0) return <p className="muted">{emptyText}</p>

  const W = 640
  const H = 220
  const padL = 8
  const padB = 28
  const padT = 26
  const plotH = H - padB - padT
  const slot = (W - padL * 2) / bars.length
  const barW = Math.max(4, Math.min(28, slot * 0.6))
  const y = (v: number) => padT + plotH - (v / max) * plotH
  const peak = bars.reduce((a, b) => (b.value > a.value ? b : a))
  const labelEvery = bars.length > 16 ? Math.ceil(bars.length / 12) : 1
  const activeBar = bars.find((b) => b.key === active)

  return (
    <figure className="chart" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="chart-title">{title}</figcaption>
      <div className="chart-plot">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title}>
          {[0.5, 1].map((f) => (
            <line key={f} x1={padL} x2={W - padL} y1={y(max * f)} y2={y(max * f)} className="chart-grid" />
          ))}
          <line x1={padL} x2={W - padL} y1={padT + plotH} y2={padT + plotH} className="chart-axis" />
          {bars.map((b, i) => {
            const cx = padL + slot * i + slot / 2
            const top = y(b.value)
            const h = padT + plotH - top
            const r = Math.min(4, barW / 2, h)
            return (
              <g key={b.key}>
                {/* zona de hover más grande que la barra */}
                <rect
                  x={padL + slot * i}
                  y={padT}
                  width={slot}
                  height={plotH}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${b.label}: ${formatMoney(b.value)}${b.detail ? `, ${b.detail}` : ''}`}
                  onMouseEnter={() => setActive(b.key)}
                  onMouseLeave={() => setActive(null)}
                  onFocus={() => setActive(b.key)}
                  onBlur={() => setActive(null)}
                />
                {h > 0 && (
                  <path
                    className={`chart-bar${active === b.key ? ' on' : ''}`}
                    d={`M${cx - barW / 2},${padT + plotH} V${top + r} Q${cx - barW / 2},${top} ${cx - barW / 2 + r},${top} H${cx + barW / 2 - r} Q${cx + barW / 2},${top} ${cx + barW / 2},${top + r} V${padT + plotH} Z`}
                    pointerEvents="none"
                  />
                )}
                {i % labelEvery === 0 && (
                  <text x={cx} y={H - 8} textAnchor="middle" className="chart-tick">{b.label}</text>
                )}
                {b.key === peak.key && (
                  <text x={cx} y={top - 8} textAnchor="middle" className="chart-peak">{formatMoney(b.value)}</text>
                )}
              </g>
            )
          })}
        </svg>
        {activeBar && (
          <div className="chart-tip" role="status">
            <strong>{activeBar.label}</strong> · {formatMoney(activeBar.value)}
            {activeBar.detail && <span className="muted"> · {activeBar.detail}</span>}
          </div>
        )}
      </div>
      <details className="chart-table">
        <summary>Ver como tabla</summary>
        <table>
          <tbody>
            {bars.filter((b) => b.value > 0).map((b) => (
              <tr key={b.key}>
                <th scope="row">{b.label}</th>
                <td>{formatMoney(b.value)}</td>
                <td>{b.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
}

/** Barras horizontales de proporción (participación de cada parte en el total), con valores escritos. */
export function ShareBars({ rows }: { rows: { key: string; label: string; value: number; detail?: string }[] }) {
  const total = rows.reduce((s, r) => s + r.value, 0)
  if (total === 0) return <p className="muted">Sin datos en este período.</p>
  return (
    <div className="share-list">
      {rows.map((r) => {
        const pct = Math.round((r.value / total) * 100)
        return (
          <div key={r.key} className="share-row">
            <div className="share-head">
              <span>{r.label}{r.detail && <span className="muted"> · {r.detail}</span>}</span>
              <span className="price">{formatMoney(r.value)} <span className="muted share-pct">{pct}%</span></span>
            </div>
            <div className="share-track" aria-hidden="true">
              <div className="share-fill" style={{ width: `${Math.max(pct, 1)}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}
