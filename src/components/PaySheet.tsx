import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { parseAmount, type PaymentMethod } from '../lib/cash'
import { formatMoney } from '../lib/format'
import type { Order, OrderItem, Payment } from '../lib/orders'
import type { Enums } from '../lib/database.types'
import { Sheet } from './Sheet'
import { QrPanel } from './QrPanel'
import { InvoiceForm } from './InvoiceForm'
import { useNavigate } from 'react-router-dom'
import { createQrCharge, type MpCharge } from '../lib/mercadopago'

type Role = Enums<'member_role'>

/**
 * Cobro de una comanda: descuento, uno o varios pagos (efectivo con vuelto, tarjeta,
 * transferencia, Mercado Pago), propina y cierre. Las reglas duras viven en la base:
 * no se cobra de más, el efectivo exige caja abierta y no se cierra sin estar paga.
 */
export function PaySheet({
  order,
  payments,
  items = [],
  role,
  pendingItems,
  onClose,
  onChanged,
  onClosedOrder,
}: {
  order: Order
  payments: Payment[]
  items?: OrderItem[]
  role: Role
  pendingItems: number
  onClose: () => void
  onChanged: () => Promise<void>
  onClosedOrder: () => void
}) {
  const [methods, setMethods] = useState<PaymentMethod[]>([])
  const [cashOpen, setCashOpen] = useState<boolean | null>(null)
  const [methodId, setMethodId] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [received, setReceived] = useState('')
  const [tip, setTip] = useState('')
  const [discount, setDiscount] = useState(order.discount_amount ? String(order.discount_amount) : '')
  const [discountPct, setDiscountPct] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [qr, setQr] = useState<MpCharge | null>(null)
  // Dividir la cuenta: solo sugiere el monto de cada pago; los pagos parciales los controla la base
  const [split, setSplit] = useState<'none' | 'equal' | 'items'>('none')
  const [parts, setParts] = useState(2)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [fiscalOn, setFiscalOn] = useState(false)
  const [invoicing, setInvoicing] = useState(false)
  const navigate = useNavigate()

  const canDiscount = ['owner', 'manager', 'cashier'].includes(role)
  const canVoid = ['owner', 'manager'].includes(role)
  const canInvoice = fiscalOn && ['owner', 'manager', 'cashier'].includes(role)
  const remaining = Math.max(order.total - order.paid_total, 0)
  const live = payments.filter((p) => !p.voided_at)

  useEffect(() => {
    async function load() {
      const [m, s, f] = await Promise.all([
        supabase.from('payment_methods').select('*').eq('restaurant_id', order.restaurant_id).eq('active', true).order('sort_order'),
        supabase.from('cash_sessions').select('id').eq('restaurant_id', order.restaurant_id).is('closed_at', null).limit(1),
        supabase.from('fiscal_settings').select('enabled').eq('restaurant_id', order.restaurant_id).maybeSingle(),
      ])
      setFiscalOn(Boolean(f.data?.enabled))
      const list = m.data ?? []
      const open = (s.data ?? []).length > 0
      setMethods(list)
      setCashOpen(open)
      setMethodId((cur) => cur ?? (list.find((x) => x.kind === (open ? 'cash' : 'debit')) ?? list[0])?.id ?? null)
    }
    void load()
  }, [order.restaurant_id])

  const billable = items.filter((i) => i.status !== 'cancelled')
  // Con descuento, cada producto paga su parte proporcional
  const factor = order.subtotal > 0 ? order.total / order.subtotal : 1
  const share = Math.ceil(order.total / parts)
  const pickedTotal = Math.round(billable.filter((i) => picked.has(i.id)).reduce((s, i) => s + (i.line_total ?? 0), 0) * factor)

  // El monto sugerido es lo que falta, o la parte que toca según cómo se divide
  useEffect(() => {
    const suggested = split === 'equal' ? Math.min(share, remaining) : split === 'items' ? Math.min(pickedTotal, remaining) : remaining
    setAmount(suggested ? String(suggested) : '')
    setReceived('')
  }, [remaining, split, share, pickedTotal])

  // Después de cada pago por productos se limpia la selección
  useEffect(() => {
    setPicked(new Set())
  }, [order.paid_total])

  const method = methods.find((m) => m.id === methodId)
  const isCash = method?.kind === 'cash'
  const isMp = method?.kind === 'mercadopago'
  const amountValue = parseAmount(amount)
  const tipValue = !isMp && tip.trim() ? parseAmount(tip) : 0
  const receivedValue = received.trim() ? parseAmount(received) : NaN
  const change = isCash && Number.isFinite(receivedValue) ? receivedValue - amountValue - tipValue : null

  const discountValue = useMemo(() => {
    const v = discount.trim() ? parseAmount(discount) : 0
    if (!Number.isFinite(v)) return NaN
    return discountPct ? Math.round((order.subtotal * v) / 100) : v
  }, [discount, discountPct, order.subtotal])

  async function run(fn: () => PromiseLike<{ error: unknown }>) {
    setBusy(true)
    setError(null)
    const { error } = await fn()
    if (error) setError(errorMessage(error))
    await onChanged()
    setBusy(false)
    return !error
  }

  async function applyDiscount() {
    if (!Number.isFinite(discountValue) || discountValue < 0) return setError('Ingresá un descuento válido.')
    if (discountValue > order.subtotal) return setError('El descuento no puede superar el subtotal.')
    await run(() => supabase.from('orders').update({ discount_amount: discountValue }).eq('id', order.id))
  }

  async function addPayment() {
    if (!method) return setError('Elegí un medio de pago.')
    if (!Number.isFinite(amountValue) || amountValue <= 0) return setError('Ingresá el monto a cobrar.')
    if (amountValue > remaining + 0.009) return setError(`El monto supera lo que falta cobrar (${formatMoney(remaining)}).`)
    if (!Number.isFinite(tipValue) || tipValue < 0) return setError('La propina no es válida.')
    if (change !== null && change < 0) return setError('Lo recibido no alcanza para el monto y la propina.')
    const ok = await run(() =>
      supabase.from('payments').insert({
        restaurant_id: order.restaurant_id,
        order_id: order.id,
        payment_method_id: method.id,
        amount: amountValue,
        tip: tipValue,
      }),
    )
    if (ok) {
      setTip('')
      setReceived('')
    }
  }

  async function showQr() {
    if (!Number.isFinite(amountValue) || amountValue <= 0) return setError('Ingresá el monto a cobrar.')
    if (amountValue > remaining + 0.009) return setError(`El monto supera lo que falta cobrar (${formatMoney(remaining)}).`)
    setBusy(true)
    setError(null)
    const { data, error } = await createQrCharge(order.id, amountValue)
    setBusy(false)
    if (error || !data) return setError(error ?? 'No se pudo generar el QR.')
    setQr(data.charge)
  }

  const onQrPaid = useCallback(() => void onChanged(), [onChanged])

  async function voidPayment(p: Payment) {
    await run(() => supabase.from('payments').update({ voided_at: new Date().toISOString() }).eq('id', p.id))
  }

  async function closeOrder(withInvoice: boolean) {
    if (await run(() => supabase.from('orders').update({ status: 'closed' }).eq('id', order.id))) {
      if (withInvoice) setInvoicing(true)
      else onClosedOrder()
    }
  }

  return (
    <Sheet
      title={invoicing ? 'Factura' : qr ? 'Cobrar con QR' : 'Cobrar'}
      aside={<span className="price">{formatMoney(order.total)}</span>}
      onClose={invoicing ? onClosedOrder : onClose}
    >
      {invoicing ? (
        <InvoiceForm
          orderId={order.id}
          total={order.total}
          onDone={(inv) => navigate(`/factura/${inv.id}`, { replace: true })}
          onSkip={onClosedOrder}
        />
      ) : qr ? (
        <QrPanel
          key={qr.id}
          initial={qr}
          onPaid={onQrPaid}
          onBack={() => setQr(null)}
          onRetry={() => {
            setQr(null)
            void showQr()
          }}
        />
      ) : (
      <div className="form">
        <div className="ticket">
          <div className="ticket-row"><span>Subtotal</span><span>{formatMoney(order.subtotal)}</span></div>
          {order.discount_amount > 0 && (
            <div className="ticket-row"><span>Descuento</span><span>−{formatMoney(order.discount_amount)}</span></div>
          )}
          {live.map((p) => (
            <div key={p.id} className="ticket-row">
              <span>
                {methods.find((m) => m.id === p.payment_method_id)?.name ?? 'Pago'}
                {p.tip > 0 && <span className="muted"> · propina {formatMoney(p.tip)}</span>}
                {canVoid && (
                  <button className="link-btn inline" onClick={() => void voidPayment(p)} disabled={busy}>
                    Anular
                  </button>
                )}
              </span>
              <span>−{formatMoney(p.amount)}</span>
            </div>
          ))}
          <div className="ticket-row ticket-total">
            <span>{remaining > 0 ? 'Falta cobrar' : 'Pagado'}</span>
            <span className="amount">{formatMoney(remaining > 0 ? remaining : order.paid_total)}</span>
          </div>
        </div>

        {canDiscount && order.paid_total === 0 && (
          <div className="discount-row">
            <div className="field">
              <label htmlFor="disc">Descuento {discountPct ? '(%)' : '($)'}</label>
              <input id="disc" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} placeholder="0" />
            </div>
            <div className="switcher compact" role="group" aria-label="Tipo de descuento">
              <button type="button" aria-pressed={!discountPct} onClick={() => setDiscountPct(false)}>$</button>
              <button type="button" aria-pressed={discountPct} onClick={() => setDiscountPct(true)}>%</button>
            </div>
            <button type="button" className="btn btn-quiet" onClick={() => void applyDiscount()} disabled={busy}>
              Aplicar
            </button>
          </div>
        )}

        {remaining > 0 ? (
          <>
            {cashOpen === false && (
              <div className="notice notice-info">La caja está cerrada: para cobrar en efectivo, abrila desde Caja.</div>
            )}
            <div className="method-chips" role="radiogroup" aria-label="Medio de pago">
              {methods.map((m) => {
                const disabled = m.kind === 'cash' && cashOpen === false
                return (
                  <button
                    key={m.id}
                    type="button"
                    role="radio"
                    aria-checked={m.id === methodId}
                    disabled={disabled}
                    onClick={() => setMethodId(m.id)}
                  >
                    {m.name}
                  </button>
                )
              })}
            </div>
            <div className="split">
              <span className="split-label">Dividir la cuenta</span>
              <div className="switcher three" role="group" aria-label="Dividir la cuenta">
                <button type="button" aria-pressed={split === 'none'} onClick={() => setSplit('none')}>No</button>
                <button type="button" aria-pressed={split === 'equal'} onClick={() => setSplit('equal')}>En partes</button>
                <button type="button" aria-pressed={split === 'items'} onClick={() => setSplit('items')} disabled={billable.length === 0}>Por productos</button>
              </div>
              {split === 'equal' && (
                <div className="split-row">
                  <span className="stepper">
                    <button aria-label="Una parte menos" disabled={parts <= 2} onClick={() => setParts((n) => n - 1)}>−</button>
                    <span>{parts}</span>
                    <button aria-label="Una parte más" disabled={parts >= 30} onClick={() => setParts((n) => n + 1)}>+</button>
                  </span>
                  <span>
                    partes de <strong>{formatMoney(share)}</strong>
                  </span>
                </div>
              )}
              {split === 'items' && (
                <div className="split-items">
                  {billable.map((i) => (
                    <label key={i.id} className="check">
                      <input
                        type="checkbox"
                        checked={picked.has(i.id)}
                        onChange={(e) =>
                          setPicked((cur) => {
                            const next = new Set(cur)
                            if (e.target.checked) next.add(i.id)
                            else next.delete(i.id)
                            return next
                          })
                        }
                      />
                      <span className="split-item">
                        <span>{i.quantity > 1 ? `${i.quantity} × ` : ''}{i.name}</span>
                        <span className="nowrap">{formatMoney((i.line_total ?? 0) * factor)}</span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="pay-amount">Monto</label>
                <input id="pay-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              {!isMp && (
                <div className="field">
                  <label htmlFor="pay-tip">Propina</label>
                  <input id="pay-tip" inputMode="decimal" value={tip} onChange={(e) => setTip(e.target.value)} placeholder="0" />
                </div>
              )}
            </div>
            {isCash && (
              <div className="field">
                <label htmlFor="pay-received">Paga con</label>
                <input id="pay-received" inputMode="decimal" value={received} onChange={(e) => setReceived(e.target.value)} placeholder="Opcional, para calcular el vuelto" />
              </div>
            )}
            {change !== null && change >= 0 && (
              <div className="change-line" aria-live="polite">
                <span>Vuelto</span>
                <span className="cash-big">{formatMoney(change)}</span>
              </div>
            )}
          </>
        ) : (
          pendingItems > 0 && (
            <p className="muted">
              Al cerrar, {pendingItems === 1 ? 'el producto sin enviar va' : `los ${pendingItems} productos sin enviar van`} a cocina.
            </p>
          )
        )}

        {error && <div className="notice notice-error" role="alert">{error}</div>}

        <div className="sheet-actions">
          {remaining > 0 && isMp ? (
            <>
              <button className="btn btn-primary" onClick={() => void showQr()} disabled={busy}>
                Mostrar QR{Number.isFinite(amountValue) && amountValue > 0 ? ` · ${formatMoney(amountValue)}` : ''}
              </button>
              <button className="btn btn-quiet" onClick={() => void addPayment()} disabled={busy}>
                Ya lo cobré con otro QR: registrar a mano
              </button>
            </>
          ) : remaining > 0 ? (
            <button className="btn btn-primary" onClick={() => void addPayment()} disabled={busy || !method}>
              Registrar pago{Number.isFinite(amountValue) && amountValue > 0 ? ` · ${formatMoney(amountValue)}` : ''}
            </button>
          ) : canInvoice ? (
            <>
              <button className="btn btn-primary" onClick={() => void closeOrder(true)} disabled={busy}>
                Cerrar y facturar
              </button>
              <button className="btn btn-quiet" onClick={() => void closeOrder(false)} disabled={busy}>
                Cerrar sin factura
              </button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={() => void closeOrder(false)} disabled={busy}>
              Cerrar comanda
            </button>
          )}
          <button className="btn btn-quiet" onClick={onClose}>Volver al pedido</button>
        </div>
      </div>
      )}
    </Sheet>
  )
}
