import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { Sheet } from '../components/Sheet'
import { InvoiceForm } from '../components/InvoiceForm'
import {
  isCreditNote,
  issueCreditNote,
  cbteLabel,
  docTypeLabel,
  fiscalQrUrl,
  formatCuit,
  invoiceMoney as formatMoney,
  invoiceNumber,
  ivaConditionLabel,
  receiverConditionLabel,
  type FiscalSettings,
  type Invoice,
} from '../lib/invoices'
import type { Tables } from '../lib/database.types'

type Item = Pick<Tables<'order_items'>, 'id' | 'name' | 'quantity' | 'line_total' | 'status'>

const day = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('es-AR')

/** Comprobante para mostrar, imprimir o compartir, con el QR fiscal de ARCA. */
export function Factura() {
  const { invoiceId = '' } = useParams()
  const navigate = useNavigate()
  const [inv, setInv] = useState<Invoice | null>(null)
  const [fs, setFs] = useState<FiscalSettings | null>(null)
  const [items, setItems] = useState<Item[]>([])
  const [qr, setQr] = useState('')
  const [missing, setMissing] = useState(false)
  const [linked, setLinked] = useState<Invoice | null>(null)
  const [voiding, setVoiding] = useState(false)
  const [reinvoicing, setReinvoicing] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { role } = useCurrentRestaurant()
  const canVoid = role === 'owner' || role === 'manager'
  const canInvoice = canVoid || role === 'cashier'

  useEffect(() => {
    async function load() {
      setLinked(null)
      setVoiding(false)
      setReinvoicing(false)
      const { data } = await supabase.from('invoices').select('*').eq('id', invoiceId).maybeSingle()
      if (!data) return setMissing(true)
      setInv(data)
      // La nota de crédito que la anuló, o la factura que anula esta nota de crédito
      const linkedId = data.credit_note_id ?? data.associated_id
      if (linkedId) void supabase.from('invoices').select('*').eq('id', linkedId).maybeSingle().then(({ data: l }) => setLinked(l))
      const [s, i] = await Promise.all([
        supabase.from('fiscal_settings').select('*').eq('restaurant_id', data.restaurant_id).maybeSingle(),
        supabase.from('order_items').select('id, name, quantity, line_total, status').eq('order_id', data.order_id).neq('status', 'cancelled').order('created_at'),
      ])
      setFs(s.data)
      setItems(i.data ?? [])
      if (s.data && data.cae) setQr(await QRCode.toString(fiscalQrUrl(data, s.data.cuit), { type: 'svg', margin: 0 }))
    }
    void load()
  }, [invoiceId])

  if (missing) return <div className="center-screen">No se encontró la factura.</div>
  if (!inv || !fs) return <div className="center-screen">Cargando la factura…</div>

  const kind = cbteLabel[inv.cbte_type]
  const showVat = inv.cbte_type === 1 || inv.cbte_type === 3
  const nc = isCreditNote(inv.cbte_type)
  const linkedLabel = linked ? `${cbteLabel[linked.cbte_type]?.name} N.º ${invoiceNumber(linked)}` : ''

  async function voidInvoice() {
    if (!inv) return
    setBusy(true)
    setError(null)
    const { invoice, error } = await issueCreditNote(inv.id, reason.trim() || undefined)
    setBusy(false)
    if (error || !invoice) return setError(error ?? 'No se pudo emitir la nota de crédito.')
    navigate(`/factura/${invoice.id}`, { replace: true })
  }

  return (
    <div className="invoice-page">
      <div className="invoice-actions no-print">
        <button className="btn btn-quiet" onClick={() => navigate(-1)}>Volver</button>
        <button className="btn btn-primary" onClick={() => window.print()}>Imprimir o guardar PDF</button>
      </div>

      {(inv.credit_note_id || nc) && linked && (
        <div className="notice notice-info invoice-link no-print">
          {nc ? 'Esta nota de crédito anula la ' : 'Factura anulada con la '}
          <button className="link-btn inline" onClick={() => navigate(`/factura/${linked.id}`)}>{linkedLabel}</button>.
        </div>
      )}

      <article className="invoice">
        {inv.environment === 'homologacion' && <div className="invoice-test">Comprobante de prueba · sin validez fiscal</div>}
        <header className="invoice-head">
          <div>
            <div className="invoice-legal">{fs.legal_name}</div>
            <div>{fs.address}</div>
            <div>{ivaConditionLabel[fs.iva_condition]}</div>
          </div>
          <div className="invoice-letter" aria-label={kind?.name}>
            <span>{kind?.letter}</span>
            <small>Cód. {kind?.code}</small>
          </div>
          <div className="invoice-meta">
            <div className="invoice-kind">{kind?.name}</div>
            <div>N.º {invoiceNumber(inv)}</div>
            <div>Fecha {day(inv.issued_on)}</div>
            <div>CUIT {formatCuit(fs.cuit)}</div>
            {fs.gross_income && <div>IIBB {fs.gross_income}</div>}
            {fs.activity_start && <div>Inicio de actividades {day(fs.activity_start)}</div>}
          </div>
        </header>

        <section className="invoice-receiver">
          <div>
            <strong>{inv.receiver_name || receiverConditionLabel[inv.receiver_condition]}</strong>
          </div>
          {inv.doc_type !== 99 && (
            <div>
              {docTypeLabel[inv.doc_type]} {inv.doc_type === 80 ? formatCuit(inv.doc_number) : inv.doc_number}
            </div>
          )}
          {inv.receiver_name && <div>{receiverConditionLabel[inv.receiver_condition]}</div>}
        </section>

        {nc && linked && (
          <div className="invoice-assoc">
            Comprobante asociado: {linkedLabel} del {day(linked.issued_on)}
            {inv.reason && <> · Motivo: {inv.reason}</>}
          </div>
        )}

        <table className="invoice-items">
          <thead>
            <tr><th>Cant.</th><th>Descripción</th><th className="num">Importe</th></tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.id}>
                <td>{it.quantity}</td>
                <td>{it.name}</td>
                <td className="num">{formatMoney(it.line_total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="invoice-totals">
          {showVat && (
            <>
              <div><span>Neto gravado</span><span>{formatMoney(inv.net)}</span></div>
              <div><span>IVA 21 %</span><span>{formatMoney(inv.vat)}</span></div>
            </>
          )}
          <div className="invoice-total"><span>Total</span><span>{formatMoney(inv.total)}</span></div>
          {inv.cbte_type === 6 && <p className="muted">IVA contenido: {formatMoney(inv.vat)}</p>}
        </div>

        <footer className="invoice-foot">
          <div className="invoice-qr" dangerouslySetInnerHTML={{ __html: qr }} aria-label="QR de ARCA" role="img" />
          <div>
            <div className="invoice-ok">Comprobante autorizado</div>
            <div>CAE {inv.cae}</div>
            {inv.cae_due && <div>Vencimiento del CAE {day(inv.cae_due)}</div>}
          </div>
        </footer>
      </article>

      <div className="invoice-actions no-print">
        {!nc && !inv.credit_note_id && canVoid && (
          <button className="btn btn-danger" onClick={() => setVoiding(true)}>Anular con nota de crédito</button>
        )}
        {inv.credit_note_id && canInvoice && (
          <button className="btn btn-primary" onClick={() => setReinvoicing(true)}>Facturar la comanda de nuevo</button>
        )}
      </div>

      {voiding && (
        <Sheet title="Anular factura" onClose={() => setVoiding(false)}>
          <p>
            Se emite una <strong>{cbteLabel[{ 1: 3, 6: 8, 11: 13 }[inv.cbte_type] ?? 13]?.name}</strong> por {formatMoney(inv.total)} que
            anula la {kind?.name} N.º {invoiceNumber(inv)}. La venta sigue registrada y después podés facturarla de nuevo con otros datos.
          </p>
          <div className="field">
            <label htmlFor="nc-reason">Motivo</label>
            <input id="nc-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Opcional, por ejemplo: datos del cliente mal cargados" />
          </div>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          <div className="sheet-actions">
            <button className="btn btn-danger" disabled={busy} onClick={() => void voidInvoice()}>
              {busy ? 'Pidiendo el CAE a ARCA…' : 'Emitir nota de crédito'}
            </button>
            <button className="btn btn-quiet" disabled={busy} onClick={() => setVoiding(false)}>Cancelar</button>
          </div>
        </Sheet>
      )}

      {reinvoicing && (
        <Sheet title="Facturar de nuevo" onClose={() => setReinvoicing(false)}>
          <InvoiceForm
            orderId={inv.order_id}
            total={inv.total}
            onDone={(i) => navigate(`/factura/${i.id}`, { replace: true })}
            onSkip={() => setReinvoicing(false)}
          />
        </Sheet>
      )}
    </div>
  )
}
