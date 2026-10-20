// Factura electrónica con ARCA (web services WSAA + WSFEv1).
//
// Acciones de administración (header x-admin-key = secreto arca_admin_key de Vault):
//   csr       { cuit, org, alias, force? }  genera la clave privada (queda en Vault) y devuelve el pedido (CSR)
//   set_cert  { cert }                      guarda el certificado que devuelve ARCA (verifica que sea de esta clave)
//   test      { pto_vta?, cbte_tipo? }      WSAA + FEDummy + puntos de venta + último comprobante
//
// Acción con sesión (owner, manager o cashier del local):
//   invoice   { order_id, receiver?: { doc_type, doc_number, condition, name } }
//             emite Factura C (monotributo) o B/A (responsable inscripto) por el total de la comanda
//   credit_note { invoice_id, reason? }    (owner o manager) anula la factura con nota de crédito C/B/A
//
// La clave privada nunca sale del servidor.
import forge from 'npm:node-forge@1.3.1'
import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } })

const ENV = 'homologacion' as const
const URLS = {
  homologacion: {
    wsaa: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://wswhomo.afip.gov.ar/wsfev1/service.asmx',
  },
  produccion: {
    wsaa: 'https://wsaa.afip.gov.ar/ws/services/LoginCms',
    wsfe: 'https://servicios1.afip.gov.ar/wsfev1/service.asmx',
  },
}[ENV]

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-admin-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const fail = (message: string, status = 400) => json({ error: message }, status)

async function getSecret(name: string): Promise<string | null> {
  const { data, error } = await admin.rpc('arca_get_secret', { p_name: name })
  if (error) throw error
  return (data as string | null) ?? null
}
async function putSecret(name: string, value: string) {
  const { error } = await admin.rpc('arca_put_secret', { p_name: name, p_value: value })
  if (error) throw error
}

// ---------------------------------------------------------------------------
// XML mínimo
// ---------------------------------------------------------------------------
const unescape = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml)
  return m ? m[1]! : null
}
function tags(xml: string, name: string): string[] {
  return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, 'g'))].map((m) => m[1]!)
}

// Fecha ISO con la zona de Argentina (-03:00), como la piden en el TRA
function isoAr(d: Date) {
  const t = new Date(d.getTime() - 3 * 3600_000)
  return t.toISOString().replace(/\.\d{3}Z$/, '-03:00')
}

// ---------------------------------------------------------------------------
// WSAA: ticket de acceso (se reutiliza mientras esté vigente)
// ---------------------------------------------------------------------------
async function ticket(service: string, renew = false) {
  if (!renew) {
    const { data } = await admin.from('arca_tokens').select('*').eq('environment', ENV).eq('service', service).maybeSingle()
    if (data && new Date(data.expires_at).getTime() > Date.now() + 5 * 60_000) return data as { token: string; sign: string }
  }
  const [keyPem, certPem] = await Promise.all([getSecret('arca_private_key'), getSecret('arca_cert')])
  if (!keyPem || !certPem) throw new Error('Falta el certificado de ARCA.')

  const now = new Date()
  const tra = `<?xml version="1.0" encoding="UTF-8"?><loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(now.getTime() / 1000)}</uniqueId><generationTime>${isoAr(new Date(now.getTime() - 10 * 60_000))}</generationTime><expirationTime>${isoAr(new Date(now.getTime() + 10 * 60_000))}</expirationTime></header><service>${service}</service></loginTicketRequest>`

  const cert = forge.pki.certificateFromPem(certPem)
  const key = forge.pki.privateKeyFromPem(keyPem)
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(tra, 'utf8')
  p7.addCertificate(cert)
  p7.addSigner({
    key,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest },
      { type: forge.pki.oids.signingTime, value: now as unknown as string },
    ],
  })
  p7.sign()
  const cms = forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes())

  const res = await fetch(URLS.wsaa, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
    body: `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${cms}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`,
  })
  const text = await res.text()
  const ret = tag(text, 'loginCmsReturn')
  if (!ret) {
    const fault = tag(text, 'faultstring') ?? text.slice(0, 300)
    throw new Error(`WSAA: ${unescape(fault)}`)
  }
  const ta = unescape(ret)
  const row = {
    environment: ENV,
    service,
    token: tag(ta, 'token')!,
    sign: tag(ta, 'sign')!,
    expires_at: tag(ta, 'expirationTime')!,
  }
  await admin.from('arca_tokens').upsert(row)
  return row
}

// ---------------------------------------------------------------------------
// WSFEv1
// ---------------------------------------------------------------------------
async function wsfe(method: string, inner = '', cuit?: string) {
  const auth = cuit
    ? await ticket('wsfe').then((t) => `<ar:Auth><ar:Token>${t.token}</ar:Token><ar:Sign>${t.sign}</ar:Sign><ar:Cuit>${cuit}</ar:Cuit></ar:Auth>`)
    : ''
  const res = await fetch(URLS.wsfe, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: `"http://ar.gov.afip.dif.FEV1/${method}"` },
    body: `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="http://ar.gov.afip.dif.FEV1/"><soap:Body><ar:${method}>${auth}${inner}</ar:${method}></soap:Body></soap:Envelope>`,
  })
  const text = await res.text()
  const fault = tag(text, 'faultstring')
  if (fault) throw new Error(`WSFE ${method}: ${unescape(fault)}`)
  return text
}

const errorsOf = (xml: string) =>
  tags(xml, 'Err').map((e) => `${tag(e, 'Code')}: ${unescape(tag(e, 'Msg') ?? '')}`)

// ---------------------------------------------------------------------------
// Administración
// ---------------------------------------------------------------------------
async function makeCsr(body: { cuit?: string; org?: string; alias?: string; force?: boolean }) {
  const cuit = String(body.cuit ?? '').replace(/\D/g, '')
  if (!/^\d{11}$/.test(cuit)) return fail('El CUIT/CUIL tiene que tener 11 dígitos.')
  if (!body.force && (await getSecret('arca_private_key'))) return fail('Ya hay una clave generada. Mandá force: true para reemplazarla.', 409)
  const alias = (body.alias ?? 'comanda').replace(/[^A-Za-z0-9]/g, '').slice(0, 30) || 'comanda'
  const org = (body.org ?? 'ALTech').slice(0, 60)

  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048, e: 0x10001 })
  const csr = forge.pki.createCertificationRequest()
  csr.publicKey = keys.publicKey
  csr.setSubject([
    { name: 'countryName', value: 'AR' },
    { name: 'organizationName', value: org },
    { name: 'commonName', value: alias },
    { type: '2.5.4.5', value: `CUIT ${cuit}` },
  ])
  csr.sign(keys.privateKey, forge.md.sha256.create())

  await putSecret('arca_private_key', forge.pki.privateKeyToPem(keys.privateKey))
  await putSecret('arca_cuit', cuit)
  await putSecret('arca_alias', alias)
  await admin.from('arca_tokens').delete().eq('environment', ENV)
  return json({ alias, cuit, csr: forge.pki.certificationRequestToPem(csr) })
}

async function setCert(body: { cert?: string }) {
  const pem = String(body.cert ?? '').trim()
  let cert: forge.pki.Certificate
  try {
    cert = forge.pki.certificateFromPem(pem)
  } catch {
    return fail('El certificado no tiene el formato esperado (-----BEGIN CERTIFICATE----- …).')
  }
  const keyPem = await getSecret('arca_private_key')
  if (!keyPem) return fail('Primero hay que generar el pedido de certificado.')
  const key = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey
  const pub = cert.publicKey as forge.pki.rsa.PublicKey
  if (pub.n.compareTo(key.n) !== 0) return fail('Ese certificado no corresponde al último pedido que generamos.')
  await putSecret('arca_cert', pem)
  await admin.from('arca_tokens').delete().eq('environment', ENV)
  return json({
    subject: cert.subject.attributes.map((a) => `${a.shortName ?? a.type}=${a.value}`).join(', '),
    valid_from: cert.validity.notBefore,
    valid_to: cert.validity.notAfter,
  })
}

async function selfTest(body: { pto_vta?: number; cbte_tipo?: number }) {
  const cuit = await getSecret('arca_cuit')
  if (!cuit) return fail('Falta el CUIT.')
  const out: Record<string, unknown> = { environment: ENV, cuit }
  const dummy = await wsfe('FEDummy')
  out.dummy = { app: tag(dummy, 'AppServer'), db: tag(dummy, 'DbServer'), auth: tag(dummy, 'AuthServer') }
  const t = await ticket('wsfe')
  out.ticket_expira = (t as { expires_at?: string }).expires_at ?? 'vigente'
  const ptos = await wsfe('FEParamGetPtosVenta', '', cuit)
  out.puntos_de_venta = tags(ptos, 'PtoVenta').map((p) => ({ nro: tag(p, 'Nro'), tipo: tag(p, 'EmisionTipo'), baja: tag(p, 'Bloqueado') }))
  out.puntos_errores = errorsOf(ptos)
  const pv = body.pto_vta ?? 1
  const tipo = body.cbte_tipo ?? 11
  const last = await wsfe('FECompUltimoAutorizado', `<ar:PtoVta>${pv}</ar:PtoVta><ar:CbteTipo>${tipo}</ar:CbteTipo>`, cuit)
  out.ultimo = { pto_vta: pv, cbte_tipo: tipo, nro: tag(last, 'CbteNro'), errores: errorsOf(last) }
  return json(out)
}

// ---------------------------------------------------------------------------
// Pedido de CAE (factura o nota de crédito)
// ---------------------------------------------------------------------------
const arDate = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10)
const amt = (n: number) => (Math.round(n * 100) / 100).toFixed(2)

type CaeRequest = {
  cuit: string
  pv: number
  cbteType: number
  docType: number
  docNumber: string
  condition: number
  total: number
  net: number
  vat: number
  issuedOn: string
  assoc?: { type: number; pv: number; number: number; cuit: string; date: string }
}

/** Pide el próximo número y el CAE. Reintenta si otro comprobante tomó el número (10016). */
async function requestCae(r: CaeRequest): Promise<{ ok: true; number: number; cae: string; due: string | null; notes: string | null } | { ok: false; error: string }> {
  let lastError = 'ARCA no respondió.'
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const lastXml = await wsfe('FECompUltimoAutorizado', `<ar:PtoVta>${r.pv}</ar:PtoVta><ar:CbteTipo>${r.cbteType}</ar:CbteTipo>`, r.cuit)
      const lastErrs = errorsOf(lastXml)
      if (lastErrs.length) return { ok: false, error: lastErrs.join(' · ') }
      const n = Number(tag(lastXml, 'CbteNro') ?? 0) + 1
      const iva = r.vat > 0
        ? `<ar:Iva><ar:AlicIva><ar:Id>5</ar:Id><ar:BaseImp>${amt(r.net)}</ar:BaseImp><ar:Importe>${amt(r.vat)}</ar:Importe></ar:AlicIva></ar:Iva>`
        : ''
      const assoc = r.assoc
        ? `<ar:CbtesAsoc><ar:CbteAsoc><ar:Tipo>${r.assoc.type}</ar:Tipo><ar:PtoVta>${r.assoc.pv}</ar:PtoVta><ar:Nro>${r.assoc.number}</ar:Nro><ar:Cuit>${r.assoc.cuit}</ar:Cuit><ar:CbteFch>${r.assoc.date.replace(/-/g, '')}</ar:CbteFch></ar:CbteAsoc></ar:CbtesAsoc>`
        : ''
      const req = `<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${r.pv}</ar:PtoVta><ar:CbteTipo>${r.cbteType}</ar:CbteTipo></ar:FeCabReq><ar:FeDetReq><ar:FECAEDetRequest><ar:Concepto>1</ar:Concepto><ar:DocTipo>${r.docType}</ar:DocTipo><ar:DocNro>${r.docNumber}</ar:DocNro><ar:CbteDesde>${n}</ar:CbteDesde><ar:CbteHasta>${n}</ar:CbteHasta><ar:CbteFch>${r.issuedOn.replace(/-/g, '')}</ar:CbteFch><ar:ImpTotal>${amt(r.total)}</ar:ImpTotal><ar:ImpTotConc>0</ar:ImpTotConc><ar:ImpNeto>${amt(r.net)}</ar:ImpNeto><ar:ImpOpEx>0</ar:ImpOpEx><ar:ImpTrib>0</ar:ImpTrib><ar:ImpIVA>${amt(r.vat)}</ar:ImpIVA><ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz><ar:CondicionIVAReceptorId>${r.condition}</ar:CondicionIVAReceptorId>${assoc}${iva}</ar:FECAEDetRequest></ar:FeDetReq></ar:FeCAEReq>`
      const res = await wsfe('FECAESolicitar', req, r.cuit)
      const det = tag(res, 'FECAEDetResponse') ?? ''
      const result = tag(det, 'Resultado') ?? tag(res, 'Resultado')
      const obs = tags(det, 'Obs').map((o) => `${tag(o, 'Code')}: ${unescape(tag(o, 'Msg') ?? '')}`)
      const errs = errorsOf(res)
      if (result === 'A') {
        const due = tag(det, 'CAEFchVto') ?? ''
        return {
          ok: true,
          number: n,
          cae: tag(det, 'CAE') ?? '',
          due: due ? `${due.slice(0, 4)}-${due.slice(4, 6)}-${due.slice(6, 8)}` : null,
          notes: obs.join(' · ') || null,
        }
      }
      lastError = [...errs, ...obs].join(' · ') || 'ARCA rechazó el comprobante.'
      if (!/10016/.test(lastError)) break
    }
  } catch (e) {
    lastError = (e as Error).message
  }
  return { ok: false, error: lastError }
}

async function memberRole(restaurantId: string, userId: string) {
  const { data } = await admin.from('restaurant_members').select('role').eq('restaurant_id', restaurantId).eq('user_id', userId).eq('active', true).maybeSingle()
  return (data?.role as string | undefined) ?? null
}

async function fiscalFor(restaurantId: string) {
  const { data: fs } = await admin.from('fiscal_settings').select('*').eq('restaurant_id', restaurantId).maybeSingle()
  if (!fs?.enabled) return { fs: null, error: 'Activá la facturación en Más → Facturación.' }
  if (fs.environment !== ENV) return { fs: null, error: 'El ambiente de facturación no coincide con el del servidor.' }
  return { fs, error: null }
}

// ---------------------------------------------------------------------------
// Emitir la factura de una comanda
// ---------------------------------------------------------------------------
async function issueInvoice(userId: string, body: { order_id?: string; receiver?: Record<string, unknown> }) {
  const { data: order } = await admin
    .from('orders')
    .select('id, restaurant_id, number, status, total, paid_total')
    .eq('id', String(body.order_id ?? ''))
    .maybeSingle()
  const role = order ? await memberRole(order.restaurant_id, userId) : null
  if (!order || !role) return fail('No se encontró la comanda.', 404)
  if (!['owner', 'manager', 'cashier'].includes(role)) return fail('Tu rol no puede facturar.', 403)
  const total = Number(order.total)
  if (!(total > 0)) return fail('La comanda no tiene importe para facturar.')
  if (order.status !== 'closed' && Number(order.paid_total) + 0.009 < total) return fail('Cobrá la comanda antes de facturar.')

  const { data: done } = await admin
    .from('invoices').select('*').eq('order_id', order.id).eq('status', 'authorized').in('cbte_type', [1, 6, 11]).is('credit_note_id', null).maybeSingle()
  if (done) return json({ invoice: done })

  const { fs, error: fsError } = await fiscalFor(order.restaurant_id)
  if (!fs) return fail(fsError!)

  // Receptor: consumidor final salvo que se indique DNI o CUIT
  const r = body.receiver ?? {}
  const docType = Number(r.doc_type ?? 99)
  let docNumber = String(r.doc_number ?? '0').replace(/\D/g, '') || '0'
  let condition = Number(r.condition ?? 5)
  if (![80, 96, 99].includes(docType)) return fail('Tipo de documento no válido.')
  if (docType === 99) docNumber = '0'
  if (docType === 80 && !/^\d{11}$/.test(docNumber)) return fail('El CUIT del cliente tiene que tener 11 dígitos.')
  if (docType === 96 && !/^\d{7,8}$/.test(docNumber)) return fail('El DNI tiene que tener 7 u 8 dígitos.')
  if (docType !== 80) condition = 5
  if (![1, 4, 5, 6].includes(condition)) return fail('Condición frente al IVA no válida.')

  const ri = fs.iva_condition === 'responsable_inscripto'
  const cbteType = ri ? (condition === 1 ? 1 : 6) : 11
  const net = ri ? Math.round((total / 1.21) * 100) / 100 : total
  const vat = ri ? Math.round((total - net) * 100) / 100 : 0
  const issuedOn = arDate()

  const { data: inv, error } = await admin
    .from('invoices')
    .insert({
      restaurant_id: order.restaurant_id, order_id: order.id, environment: ENV, cbte_type: cbteType, point_of_sale: fs.point_of_sale,
      issued_on: issuedOn, doc_type: docType, doc_number: docNumber, receiver_name: r.name ? String(r.name).slice(0, 120) : null,
      receiver_condition: condition, total, net, vat, created_by: userId,
    })
    .select('*')
    .single()
  if (error || !inv) return fail('No se pudo registrar la factura.', 500)

  const res = await requestCae({ cuit: fs.cuit, pv: fs.point_of_sale, cbteType, docType, docNumber, condition, total, net, vat, issuedOn })
  if (!res.ok) {
    await admin.from('invoices').update({ status: 'rejected', error: res.error }).eq('id', inv.id)
    return fail(`ARCA rechazó la factura: ${res.error}`, 502)
  }
  const { data: ok } = await admin
    .from('invoices')
    .update({ status: 'authorized', number: res.number, cae: res.cae, cae_due: res.due, notes: res.notes, error: null })
    .eq('id', inv.id)
    .select('*')
    .single()
  return json({ invoice: ok })
}

// ---------------------------------------------------------------------------
// Anular una factura con nota de crédito por el total
// ---------------------------------------------------------------------------
const CREDIT_FOR: Record<number, number> = { 1: 3, 6: 8, 11: 13 }

async function creditNote(userId: string, body: { invoice_id?: string; reason?: string }) {
  const { data: inv } = await admin.from('invoices').select('*').eq('id', String(body.invoice_id ?? '')).maybeSingle()
  const role = inv ? await memberRole(inv.restaurant_id, userId) : null
  if (!inv || !role) return fail('No se encontró la factura.', 404)
  if (!['owner', 'manager'].includes(role)) return fail('Solo el dueño o el encargado pueden anular facturas.', 403)
  if (inv.status !== 'authorized' || !CREDIT_FOR[inv.cbte_type]) return fail('Solo se anulan facturas autorizadas.')
  if (inv.credit_note_id) {
    const { data: nc } = await admin.from('invoices').select('*').eq('id', inv.credit_note_id).single()
    return json({ invoice: nc })
  }
  if (inv.environment !== ENV) return fail('La factura es de otro ambiente.')
  const { fs, error: fsError } = await fiscalFor(inv.restaurant_id)
  if (!fs) return fail(fsError!)

  const cbteType = CREDIT_FOR[inv.cbte_type]!
  const issuedOn = arDate()
  const { data: nc, error } = await admin
    .from('invoices')
    .insert({
      restaurant_id: inv.restaurant_id, order_id: inv.order_id, environment: ENV, cbte_type: cbteType, point_of_sale: inv.point_of_sale,
      issued_on: issuedOn, doc_type: inv.doc_type, doc_number: inv.doc_number, receiver_name: inv.receiver_name,
      receiver_condition: inv.receiver_condition, total: inv.total, net: inv.net, vat: inv.vat, created_by: userId,
      associated_id: inv.id, reason: body.reason ? String(body.reason).slice(0, 200) : null,
    })
    .select('*')
    .single()
  if (error || !nc) return fail('No se pudo registrar la nota de crédito.', 500)

  const res = await requestCae({
    cuit: fs.cuit, pv: inv.point_of_sale, cbteType, docType: inv.doc_type, docNumber: inv.doc_number, condition: inv.receiver_condition,
    total: Number(inv.total), net: Number(inv.net), vat: Number(inv.vat), issuedOn,
    assoc: { type: inv.cbte_type, pv: inv.point_of_sale, number: Number(inv.number), cuit: fs.cuit, date: inv.issued_on },
  })
  if (!res.ok) {
    await admin.from('invoices').update({ status: 'rejected', error: res.error }).eq('id', nc.id)
    return fail(`ARCA rechazó la nota de crédito: ${res.error}`, 502)
  }
  const { data: ok } = await admin
    .from('invoices')
    .update({ status: 'authorized', number: res.number, cae: res.cae, cae_due: res.due, notes: res.notes, error: null })
    .eq('id', nc.id)
    .select('*')
    .single()
  await admin.from('invoices').update({ credit_note_id: nc.id }).eq('id', inv.id)
  return json({ invoice: ok })
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return fail('Método no permitido', 405)
  try {
    const body = await req.json().catch(() => ({}))
    if (body.action === 'invoice' || body.action === 'credit_note') {
      const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
      const { data } = jwt ? await admin.auth.getUser(jwt) : { data: { user: null } }
      if (!data.user) return fail('Iniciá sesión.', 401)
      return body.action === 'invoice' ? await issueInvoice(data.user.id, body) : await creditNote(data.user.id, body)
    }
    const adminKey = req.headers.get('x-admin-key') ?? ''
    const expected = await getSecret('arca_admin_key')
    if (!expected || adminKey !== expected) return fail('No autorizado.', 401)
    switch (body.action) {
      case 'csr':
        return await makeCsr(body)
      case 'set_cert':
        return await setCert(body)
      case 'test':
        return await selfTest(body)
      default:
        return fail('Acción desconocida.')
    }
  } catch (e) {
    console.error(e)
    return fail((e as Error).message ?? 'Error inesperado.', 500)
  }
})
