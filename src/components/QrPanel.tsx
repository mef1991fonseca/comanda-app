import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { cancelCharge, useCharge, type MpCharge } from '../lib/mercadopago'
import { formatMoney } from '../lib/format'

function useCountdown(until: string | null) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  if (!until) return null
  const left = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000))
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
}

/** QR de Mercado Pago en pantalla, esperando que el cliente pague. */
export function QrPanel({
  initial,
  onPaid,
  onBack,
  onRetry,
}: {
  initial: MpCharge
  onPaid: () => void
  onBack: () => void
  onRetry: () => void
}) {
  const [charge, setCharge] = useCharge(initial)
  const [svg, setSvg] = useState('')
  const [busy, setBusy] = useState(false)
  const left = useCountdown(charge.expires_at)

  useEffect(() => {
    if (!charge.qr_data) return
    void QRCode.toString(charge.qr_data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg)
  }, [charge.qr_data])

  const notified = useRef(false)
  useEffect(() => {
    if (charge.status === 'processed' && !notified.current) {
      notified.current = true
      onPaid()
    }
  }, [charge.status, onPaid])

  async function cancel() {
    setBusy(true)
    const { data } = await cancelCharge(charge.id)
    if (data?.charge) setCharge(data.charge)
    setBusy(false)
    if (!data?.charge || data.charge.status !== 'processed') onBack()
  }

  if (charge.status === 'processed') {
    return (
      <div className="qr-panel">
        <div className="qr-result ok" role="status">
          <span className="qr-result-title">Pago aprobado</span>
          <span className="cash-big">{formatMoney(charge.amount)}</span>
        </div>
        <button className="btn btn-primary btn-block" onClick={onBack}>Seguir</button>
      </div>
    )
  }

  if (charge.status !== 'created' || left === '0:00') {
    const message =
      charge.status === 'refunded'
        ? 'El pago entró pero la comanda ya no lo admitía, así que se devolvió en Mercado Pago.'
        : charge.status === 'failed'
          ? (charge.error ?? 'Mercado Pago no pudo procesar el cobro.')
          : 'El QR venció o se canceló. No se cobró nada.'
    return (
      <div className="qr-panel">
        <div className="notice notice-error" role="alert">{message}</div>
        <button className="btn btn-primary btn-block" onClick={onRetry}>Generar otro QR</button>
        <button className="btn btn-quiet btn-block" onClick={onBack}>Volver</button>
      </div>
    )
  }

  return (
    <div className="qr-panel">
      <div className="qr-amount">
        <span className="muted">A cobrar</span>
        <span className="cash-big">{formatMoney(charge.amount)}</span>
      </div>
      <div className="qr-code" role="img" aria-label="Código QR de Mercado Pago" dangerouslySetInnerHTML={{ __html: svg }} />
      <p className="qr-help">
        Mostrale la pantalla al cliente: escanea con la app de Mercado Pago y paga.
      </p>
      <div className="qr-wait" aria-live="polite">
        <span className="qr-dot" aria-hidden="true" />
        Esperando el pago{left ? ` · vence en ${left}` : ''}
      </div>
      <button className="btn btn-quiet btn-block" disabled={busy} onClick={() => void cancel()}>
        Cancelar QR
      </button>
    </div>
  )
}
