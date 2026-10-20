import { useState, type FormEvent } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { parseAmount } from '../lib/cash'
import { receiverConditionLabel } from '../lib/invoices'
import type { Customer } from '../lib/customers'

/** Alta o edición de un cliente. Con DNI o CUIT, la factura sale con sus datos. */
export function CustomerForm({
  restaurantId,
  customer,
  onSaved,
  onCancel,
}: {
  restaurantId: string
  customer?: Customer | null
  onSaved: (c: Customer) => void
  onCancel: () => void
}) {
  const [name, setName] = useState(customer?.name ?? '')
  const [docType, setDocType] = useState<'' | '96' | '80'>(customer?.doc_type ? (String(customer.doc_type) as '96' | '80') : '')
  const [docNumber, setDocNumber] = useState(customer?.doc_number ?? '')
  const [condition, setCondition] = useState(customer?.iva_condition ?? 5)
  const [phone, setPhone] = useState(customer?.phone ?? '')
  const [email, setEmail] = useState(customer?.email ?? '')
  const [limit, setLimit] = useState(customer?.credit_limit != null ? String(customer.credit_limit) : '')
  const [notes, setNotes] = useState(customer?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(e: FormEvent) {
    e.preventDefault()
    const digits = docNumber.replace(/\D/g, '')
    if (docType === '80' && digits.length !== 11) return setError('El CUIT tiene que tener 11 dígitos.')
    if (docType === '96' && (digits.length < 7 || digits.length > 8)) return setError('El DNI tiene que tener 7 u 8 dígitos.')
    const creditLimit = limit.trim() ? parseAmount(limit) : null
    if (creditLimit !== null && (!Number.isFinite(creditLimit) || creditLimit < 0)) return setError('El límite no es válido.')
    setBusy(true)
    setError(null)
    const row = {
      restaurant_id: restaurantId,
      name: name.trim(),
      doc_type: docType ? Number(docType) : null,
      doc_number: docType ? digits : null,
      iva_condition: docType === '80' ? condition : 5,
      phone: phone.trim() || null,
      email: email.trim() || null,
      credit_limit: creditLimit,
      notes: notes.trim() || null,
    }
    const { data, error } = customer
      ? await supabase.from('customers').update(row).eq('id', customer.id).select('*').single()
      : await supabase.from('customers').insert(row).select('*').single()
    setBusy(false)
    if (error) return setError(errorMessage(error))
    onSaved(data)
  }

  return (
    <form className="form" onSubmit={save}>
      <div className="field">
        <label htmlFor="c-name">Nombre o razón social</label>
        <input id="c-name" value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
      </div>
      <div className="field-row">
        <div className="field">
          <label htmlFor="c-doc-type">Documento</label>
          <select id="c-doc-type" value={docType} onChange={(e) => setDocType(e.target.value as '' | '96' | '80')}>
            <option value="">Sin documento</option>
            <option value="96">DNI</option>
            <option value="80">CUIT</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="c-doc">Número</label>
          <input id="c-doc" inputMode="numeric" value={docNumber} onChange={(e) => setDocNumber(e.target.value)} disabled={!docType} />
        </div>
      </div>
      {docType === '80' && (
        <div className="field">
          <label htmlFor="c-cond">Condición frente al IVA</label>
          <select id="c-cond" value={condition} onChange={(e) => setCondition(Number(e.target.value))}>
            {[1, 6, 4].map((c) => (
              <option key={c} value={c}>{receiverConditionLabel[c]}</option>
            ))}
          </select>
        </div>
      )}
      <div className="field-row">
        <div className="field">
          <label htmlFor="c-phone">Teléfono</label>
          <input id="c-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="c-limit">Límite de cuenta</label>
          <input id="c-limit" inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Sin límite" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="c-email">Email</label>
        <input id="c-email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="c-notes">Notas</label>
        <input id="c-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" />
      </div>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="sheet-actions">
        <button className="btn btn-primary" disabled={busy}>{customer ? 'Guardar cambios' : 'Crear cliente'}</button>
        <button type="button" className="btn btn-quiet" onClick={onCancel}>Cancelar</button>
      </div>
    </form>
  )
}
