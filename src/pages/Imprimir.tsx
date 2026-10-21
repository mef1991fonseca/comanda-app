import { useEffect, useRef } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { itemModifiers, orderNumberLabel, orderTitle, useOrder } from '../lib/orders'
import { useCurrentRestaurant } from '../lib/restaurant'
import { useMenu } from '../lib/menu'
import { useTeam } from '../lib/team'
import { formatMoney } from '../lib/format'
import { usePrinterSettings } from '../lib/printer'

/**
 * Tickets para impresora térmica de 80 o 58 mm (o cualquier impresora) usando la impresión del navegador.
 *  /imprimir/precuenta/:orderId          precuenta para el cliente, no válida como factura
 *  /imprimir/cocina/:orderId             comanda para cocina, por estación y sin precios
 *  ?items=a,b                            solo esos ítems (lo recién enviado; sale como "Agregado" si ya había otros)
 *  ?embed=1                              dentro del marco oculto de lib/printer.ts: imprime y avisa al terminar
 * El ancho del papel sale de la configuración de este equipo (Más → Impresora).
 */
function useAutoPrint(ready: boolean, embed: boolean) {
  const printed = useRef(false)
  useEffect(() => {
    if (!ready || printed.current) return
    printed.current = true
    const finish = () => {
      if (embed) window.parent.postMessage({ type: 'comanda-printed' }, window.location.origin)
    }
    window.addEventListener('afterprint', finish, { once: true })
    // Un instante para que el navegador termine de dibujar antes de imprimir
    const t = window.setTimeout(() => {
      window.print()
      // Con --kiosk-printing algunos navegadores no disparan afterprint
      window.setTimeout(finish, 1500)
    }, 300)
    return () => window.clearTimeout(t)
  }, [ready, embed])
}
export function Imprimir() {
  const { kind = 'precuenta', orderId = '' } = useParams()
  const [params] = useSearchParams()
  const embed = params.get('embed') === '1'
  const only = params.get('items')?.split(',').filter(Boolean) ?? null
  const navigate = useNavigate()
  const { restaurant } = useCurrentRestaurant()
  const { settings } = usePrinterSettings(restaurant.id)
  const { order, items, tableName, loading } = useOrder(orderId)
  const { menu } = useMenu(restaurant.id)
  const team = useTeam(restaurant.id)

  const all = items.filter((i) => i.status !== 'cancelled')
  const live = only ? all.filter((i) => only.includes(i.id)) : all
  const added = Boolean(only) && all.some((i) => !only?.includes(i.id) && i.status !== 'pending')
  const ready = !loading && order !== null && (kind !== 'cocina' || menu.stations.length > 0 || live.every((i) => !i.station_id))

  useAutoPrint(ready, embed)

  if (loading) return <div className="center-screen">Preparando el ticket…</div>
  if (!order) return <div className="center-screen">No se encontró la comanda.</div>

  const where = orderTitle(order, tableName)
  const waiter = team.find((m) => m.user_id === order.waiter_id)?.name
  const when = new Date().toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

  return (
    <div className={`print-page receipt-page ${settings.paper === 58 ? 'paper-58' : ''}`}>
      {!embed && (
        <div className="print-actions no-print">
          <button className="btn btn-quiet" onClick={() => navigate(-1)}>Volver</button>
          <button className="btn btn-primary" onClick={() => window.print()}>Imprimir</button>
        </div>
      )}

      {kind === 'cocina' ? (
        <article className="receipt">
          {added && <div className="receipt-center receipt-added">AGREGADO</div>}
          <div className="receipt-big">{where}</div>
          <div className="receipt-center">
            {orderNumberLabel(order)} · {when}
            {waiter ? ` · ${waiter}` : ''}
            {order.guests ? ` · ${order.guests} pax` : ''}
          </div>
          {groupByStation(live, menu.stations).map(({ name, rows }) => (
            <section key={name} className="receipt-station">
              <div className="receipt-station-name">{name}</div>
              {rows.map((i) => (
                <div key={i.id} className="receipt-kitchen-item">
                  <span className="receipt-qty">{i.quantity}</span>
                  <span>
                    <strong>{i.name}</strong>
                    {itemModifiers(i).map((m) => (
                      <span key={m.id} className="receipt-mod">· {m.name}</span>
                    ))}
                    {i.notes && <span className="receipt-mod">» {i.notes}</span>}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </article>
      ) : (
        <article className="receipt">
          <div className="receipt-center receipt-title">{restaurant.name}</div>
          {restaurant.address && <div className="receipt-center">{restaurant.address}</div>}
          <div className="receipt-rule" />
          <div className="receipt-row"><span>{where}</span><span>{orderNumberLabel(order).replace('Comanda ', '')}</span></div>
          <div className="receipt-row"><span>{when}</span><span>{waiter ?? ''}</span></div>
          {order.guests ? <div className="receipt-row"><span>Comensales</span><span>{order.guests}</span></div> : null}
          <div className="receipt-rule" />
          {live.map((i) => (
            <div key={i.id} className="receipt-item">
              <div className="receipt-row">
                <span>{i.quantity} × {i.name}</span>
                <span>{formatMoney(i.line_total)}</span>
              </div>
              {itemModifiers(i).length > 0 && (
                <div className="receipt-mod">{itemModifiers(i).map((m) => m.name).join(', ')}</div>
              )}
            </div>
          ))}
          <div className="receipt-rule" />
          {order.discount_amount > 0 && (
            <>
              <div className="receipt-row"><span>Subtotal</span><span>{formatMoney(order.subtotal)}</span></div>
              <div className="receipt-row"><span>Descuento</span><span>−{formatMoney(order.discount_amount)}</span></div>
            </>
          )}
          <div className="receipt-row receipt-total"><span>TOTAL</span><span>{formatMoney(order.total)}</span></div>
          {order.paid_total > 0 && (
            <>
              <div className="receipt-row"><span>Pagado</span><span>{formatMoney(order.paid_total)}</span></div>
              <div className="receipt-row"><span>Falta</span><span>{formatMoney(Math.max(order.total - order.paid_total, 0))}</span></div>
            </>
          )}
          <div className="receipt-row"><span>Propina sugerida 10 %</span><span>{formatMoney(order.total * 0.1)}</span></div>
          <div className="receipt-rule" />
          <div className="receipt-center">Precuenta · no válida como factura</div>
          <div className="receipt-center">¡Gracias por venir!</div>
        </article>
      )}
    </div>
  )
}

/** Hoja de prueba para configurar la impresora de este equipo. */
export function PrintTest() {
  const [params] = useSearchParams()
  const embed = params.get('embed') === '1'
  const navigate = useNavigate()
  const { restaurant } = useCurrentRestaurant()
  const { settings } = usePrinterSettings(restaurant.id)
  useAutoPrint(true, embed)
  const when = new Date().toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  return (
    <div className={`print-page receipt-page ${settings.paper === 58 ? 'paper-58' : ''}`}>
      {!embed && (
        <div className="print-actions no-print">
          <button className="btn btn-quiet" onClick={() => navigate(-1)}>Volver</button>
          <button className="btn btn-primary" onClick={() => window.print()}>Imprimir</button>
        </div>
      )}
      <article className="receipt">
        <div className="receipt-center receipt-title">{restaurant.name}</div>
        <div className="receipt-center">Prueba de impresión · papel de {settings.paper} mm</div>
        <div className="receipt-center">{when}</div>
        <div className="receipt-rule" />
        <div className="receipt-big">Mesa 12</div>
        <div className="receipt-kitchen-item">
          <span className="receipt-qty">2</span>
          <span><strong>Hamburguesa con queso</strong><span className="receipt-mod">· Sin cebolla</span></span>
        </div>
        <div className="receipt-row"><span>Línea completa de ancho</span><span>$ 99.999</span></div>
        <div className="receipt-rule" />
        <div className="receipt-center">Si se lee entero y no se corta a los costados, está bien configurada.</div>
      </article>
    </div>
  )
}

function groupByStation<T extends { station_id: string | null }>(rows: T[], stations: { id: string; name: string }[]) {
  const groups = stations
    .map((s) => ({ name: s.name, rows: rows.filter((r) => r.station_id === s.id) }))
    .filter((g) => g.rows.length > 0)
  const loose = rows.filter((r) => !r.station_id || !stations.some((s) => s.id === r.station_id))
  if (loose.length) groups.push({ name: 'General', rows: loose })
  return groups
}
