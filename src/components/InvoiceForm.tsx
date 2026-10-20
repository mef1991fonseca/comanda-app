import { useState } from 'react'
import { formatMoney } from '../lib/format'
import { issueInvoice, receiverConditionLabel, type Invoice } from '../lib/invoices'
import type { Customer } from '../lib/customers'

/** Emisión de la factura de una comanda cobrada: consumidor final o con DNI/CUIT. */
export function InvoiceForm({
  orderId,
  total,
  customer = null,
  onDone,
  onSkip,
}: {
  orderId: string
  total: number
  customer?: Customer | null
  onDone: (invoice: Invoice) => void
  onSkip: () => void
}) {
  // Si la comanda tiene un cliente con documento, la factura sale con sus datos
  const known = customer?.doc_type ? customer : null
  const [withData, setWithData] = useState(Boolean(known))
  const [docType, setDocType] = useState<80 | 96>((known?.doc_type as 80 | 96 | undefined) ?? 96)
  const [docNumber, setDocNumber] = useState(known?.doc_number ?? '')
  const [name, setName] = useState(customer?.name ?? '')
  const [condition, setCondition] = useState(known?.doc_type === 80 && known.iva_condition !== 5 ? known.iva_condition : 1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function emit() {
    setBusy(true)
    setError(null)
    const receiver = withData
      ? { doc_type: docType, doc_number: docNumber.replace(/\D/g, ''), condition: docType === 80 ? condition : 5, name: name.trim() || undefined }
      : undefined
    const { invoice, error } = await issueInvoice(orderId, receiver)
    setBusy(false)
    if (error || !invoice) return setError(error ?? 'No se pudo emitir la factura.')
    onDone(invoice)
  }

  return (
    <div className="form">
      <div className="ticket">
        <div className="ticket-row ticket-total">
          <span>A facturar</span>
          <span className="amount">{formatMoney(total)}</span>
        </div>
      </div>

      <div className="switcher" role="group" aria-label="Destinatario de la factura">
        <button type="button" aria-pressed={!withData} onClick={() => setWithData(false)}>Consumidor final</button>
        <button type="button" aria-pressed={withData} onClick={() => setWithData(true)}>Con DNI o CUIT</button>
      </div>

      {withData && (
        <>
          <div className="field-row">
            <div className="field">
              <label htmlFor="inv-doc-type">Documento</label>
              <select id="inv-doc-type" value={docType} onChange={(e) => setDocType(Number(e.target.value) as 80 | 96)}>
                <option value={96}>DNI</option>
                <option value={80}>CUIT</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="inv-doc">Número</label>
              <input id="inv-doc" inputMode="numeric" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="inv-name">Nombre o razón social</label>
            <input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Opcional" />
          </div>
          {docType === 80 && (
            <div className="field">
              <label htmlFor="inv-cond">Condición frente al IVA</label>
              <select id="inv-cond" value={condition} onChange={(e) => setCondition(Number(e.target.value))}>
                {[1, 6, 4].map((c) => (
                  <option key={c} value={c}>{receiverConditionLabel[c]}</option>
                ))}
              </select>
            </div>
          )}
        </>
      )}

      {error && <div className="notice notice-error" role="alert">{error}</div>}

      <div className="sheet-actions">
        <button className="btn btn-primary" disabled={busy} onClick={() => void emit()}>
          {busy ? 'Pidiendo el CAE a ARCA…' : 'Emitir factura'}
        </button>
        <button className="btn btn-quiet" disabled={busy} onClick={onSkip}>Ahora no</button>
      </div>
    </div>
  )
}
