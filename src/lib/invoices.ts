import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Tables } from './database.types'

export type Invoice = Tables<'invoices'>
export type FiscalSettings = Tables<'fiscal_settings'>

// En los comprobantes los importes van con centavos
const money2 = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const invoiceMoney = (n: number | null | undefined) => money2.format(Number(n ?? 0))

export const cbteLabel: Record<number, { name: string; letter: string; code: string }> = {
  1: { name: 'Factura A', letter: 'A', code: '01' },
  6: { name: 'Factura B', letter: 'B', code: '06' },
  11: { name: 'Factura C', letter: 'C', code: '11' },
  3: { name: 'Nota de crédito A', letter: 'A', code: '03' },
  8: { name: 'Nota de crédito B', letter: 'B', code: '08' },
  13: { name: 'Nota de crédito C', letter: 'C', code: '13' },
}

export const isCreditNote = (cbteType: number) => [3, 8, 13].includes(cbteType)

export const ivaConditionLabel = { monotributo: 'Responsable Monotributo', responsable_inscripto: 'IVA Responsable Inscripto' } as const

export const receiverConditionLabel: Record<number, string> = {
  5: 'Consumidor final',
  1: 'IVA Responsable Inscripto',
  6: 'Responsable Monotributo',
  4: 'IVA Sujeto Exento',
}

export const docTypeLabel: Record<number, string> = { 80: 'CUIT', 96: 'DNI', 99: 'Consumidor final' }

/** 0001-00000023 */
export const invoiceNumber = (inv: Pick<Invoice, 'point_of_sale' | 'number'>) =>
  `${String(inv.point_of_sale).padStart(5, '0')}-${String(inv.number ?? 0).padStart(8, '0')}`

export const formatCuit = (c: string) => (c.length === 11 ? `${c.slice(0, 2)}-${c.slice(2, 10)}-${c.slice(10)}` : c)

/** Link del QR fiscal (RG 4892): lleva los datos del comprobante en base64. */
export function fiscalQrUrl(inv: Invoice, cuit: string) {
  const data = {
    ver: 1,
    fecha: inv.issued_on,
    cuit: Number(cuit),
    ptoVta: inv.point_of_sale,
    tipoCmp: inv.cbte_type,
    nroCmp: inv.number,
    importe: Number(inv.total),
    moneda: 'PES',
    ctz: 1,
    tipoDocRec: inv.doc_type,
    nroDocRec: Number(inv.doc_number),
    tipoCodAut: 'E',
    codAut: Number(inv.cae),
  }
  return `https://www.afip.gob.ar/fe/qr/?p=${btoa(JSON.stringify(data))}`
}

export type Receiver = { doc_type: number; doc_number: string; condition: number; name?: string }

export const issueInvoice = (orderId: string, receiver?: Receiver) => callArca({ action: 'invoice', order_id: orderId, receiver })

/** Anula una factura con una nota de crédito por el total (dueño o encargado). */
export const issueCreditNote = (invoiceId: string, reason?: string) => callArca({ action: 'credit_note', invoice_id: invoiceId, reason })

async function callArca(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('arca', { body })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const payload = (await error.context.json().catch(() => null)) as { error?: string } | null
      return { invoice: null, error: payload?.error ?? 'ARCA no respondió.' }
    }
    return { invoice: null, error: 'No hay conexión con el servidor. Revisá internet y probá de nuevo.' }
  }
  return { invoice: (data as { invoice: Invoice }).invoice, error: null }
}
