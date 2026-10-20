import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { formatMoney } from '../lib/format'
import { cbteLabel, invoiceNumber, ivaConditionLabel, type FiscalSettings, type Invoice } from '../lib/invoices'
import type { Enums } from '../lib/database.types'
import { TopBar } from '../components/AppShell'

/** Datos fiscales del local (solo el dueño los edita) y últimas facturas emitidas. */
export function Facturacion() {
  const { restaurant, role } = useCurrentRestaurant()
  const navigate = useNavigate()
  const canEdit = role === 'owner'
  const [settings, setSettings] = useState<FiscalSettings | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [form, setForm] = useState({
    cuit: '',
    legal_name: restaurant.legal_name ?? '',
    address: restaurant.address ?? '',
    iva_condition: 'monotributo' as Enums<'iva_condition'>,
    point_of_sale: '1',
    activity_start: '',
    gross_income: '',
    enabled: false,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    async function load() {
      const [s, i] = await Promise.all([
        supabase.from('fiscal_settings').select('*').eq('restaurant_id', restaurant.id).maybeSingle(),
        supabase.from('invoices').select('*').eq('restaurant_id', restaurant.id).eq('status', 'authorized').order('created_at', { ascending: false }).limit(30),
      ])
      if (s.data) {
        setSettings(s.data)
        setForm({
          cuit: s.data.cuit,
          legal_name: s.data.legal_name,
          address: s.data.address,
          iva_condition: s.data.iva_condition,
          point_of_sale: String(s.data.point_of_sale),
          activity_start: s.data.activity_start ?? '',
          gross_income: s.data.gross_income ?? '',
          enabled: s.data.enabled,
        })
      }
      setInvoices(i.data ?? [])
    }
    void load()
  }, [restaurant.id])

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => {
    setForm((f) => ({ ...f, [k]: e.target.value }))
    setSaved(false)
  }

  async function save(e: FormEvent) {
    e.preventDefault()
    const cuit = form.cuit.replace(/\D/g, '')
    if (cuit.length !== 11) return setError('El CUIT tiene que tener 11 dígitos.')
    const pv = Number(form.point_of_sale)
    if (!Number.isInteger(pv) || pv < 1) return setError('Ingresá el número de punto de venta (el que diste de alta en ARCA para web services).')
    setBusy(true)
    setError(null)
    const row = {
      restaurant_id: restaurant.id,
      cuit,
      legal_name: form.legal_name.trim(),
      address: form.address.trim(),
      iva_condition: form.iva_condition,
      point_of_sale: pv,
      activity_start: form.activity_start || null,
      gross_income: form.gross_income.trim() || null,
      enabled: form.enabled,
    }
    const { data, error } = settings
      ? await supabase.from('fiscal_settings').update(row).eq('restaurant_id', restaurant.id).select('*').single()
      : await supabase.from('fiscal_settings').insert(row).select('*').single()
    setBusy(false)
    if (error) return setError(errorMessage(error))
    setSettings(data)
    setSaved(true)
  }

  const test = (settings?.environment ?? 'homologacion') === 'homologacion'

  return (
    <>
      <TopBar title="Facturación" />
      <div className="content">
        {test && (
          <div className="notice notice-info" style={{ marginBottom: 16 }}>
            Modo de prueba (homologación de ARCA): las facturas se autorizan de verdad en el ambiente de pruebas pero no tienen validez fiscal.
          </div>
        )}

        <form className="form section" onSubmit={save}>
          <h2>Datos fiscales</h2>
          <fieldset disabled={!canEdit} className="form" style={{ border: 0, padding: 0, margin: 0 }}>
            <div className="field">
              <label htmlFor="f-cuit">CUIT del local</label>
              <input id="f-cuit" inputMode="numeric" value={form.cuit} onChange={set('cuit')} placeholder="20123456789" required />
            </div>
            <div className="field">
              <label htmlFor="f-name">Razón social</label>
              <input id="f-name" value={form.legal_name} onChange={set('legal_name')} required />
            </div>
            <div className="field">
              <label htmlFor="f-address">Domicilio comercial</label>
              <input id="f-address" value={form.address} onChange={set('address')} required />
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="f-iva">Condición frente al IVA</label>
                <select id="f-iva" value={form.iva_condition} onChange={set('iva_condition')}>
                  <option value="monotributo">{ivaConditionLabel.monotributo}</option>
                  <option value="responsable_inscripto">{ivaConditionLabel.responsable_inscripto}</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-pv">Punto de venta</label>
                <input id="f-pv" inputMode="numeric" value={form.point_of_sale} onChange={set('point_of_sale')} required />
              </div>
            </div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="f-start">Inicio de actividades</label>
                <input id="f-start" type="date" value={form.activity_start} onChange={set('activity_start')} />
              </div>
              <div className="field">
                <label htmlFor="f-iibb">Ingresos brutos</label>
                <input id="f-iibb" value={form.gross_income} onChange={set('gross_income')} placeholder="Opcional" />
              </div>
            </div>
            <label className="check">
              <input type="checkbox" checked={form.enabled} onChange={(e) => { setForm((f) => ({ ...f, enabled: e.target.checked })); setSaved(false) }} />
              <span>Facturar al cerrar las comandas</span>
            </label>
          </fieldset>
          <p className="muted">
            {form.iva_condition === 'monotributo'
              ? 'Se emite Factura C.'
              : 'Se emite Factura B a consumidores finales y Factura A a responsables inscriptos, con IVA 21 %.'}
          </p>
          {error && <div className="notice notice-error" role="alert">{error}</div>}
          {saved && <div className="notice notice-info" role="status">Datos guardados.</div>}
          {canEdit ? (
            <button className="btn btn-primary btn-block" disabled={busy}>Guardar</button>
          ) : (
            <p className="muted">Solo el dueño puede cambiar estos datos.</p>
          )}
        </form>

        <section className="section">
          <h2>Últimas facturas</h2>
          {invoices.length === 0 ? (
            <p className="muted">Todavía no se emitió ninguna.</p>
          ) : (
            <div className="list">
              {invoices.map((inv) => (
                <button key={inv.id} className="list-row" onClick={() => navigate(`/factura/${inv.id}`)}>
                  <span className="product-line">
                    <span>{cbteLabel[inv.cbte_type]?.name} {invoiceNumber(inv)}</span>
                    <span className="product-sub">{new Date(`${inv.issued_on}T12:00:00`).toLocaleDateString('es-AR')}</span>
                  </span>
                  <span className="nowrap">{formatMoney(inv.total)}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}
