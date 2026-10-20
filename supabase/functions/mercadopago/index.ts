// Cobro con QR de Mercado Pago.
//
//  POST /mercadopago            (con sesión)  { action: 'status' | 'create' | 'refresh' | 'cancel', ... }
//  POST /mercadopago/webhook    (Mercado Pago) notificaciones de "Order (Mercado Pago)"
//
// El Access Token vive solo acá (secreto MP_ACCESS_TOKEN). El estado de un cobro siempre se
// toma de la API de Mercado Pago (GET /v1/orders/{id}), nunca del cuerpo de una notificación,
// así que una notificación falsa a lo sumo provoca una consulta.
import { createClient } from 'npm:@supabase/supabase-js@2'

const MP = 'https://api.mercadopago.com'
const TOKEN = Deno.env.get('MP_ACCESS_TOKEN') ?? ''
const WEBHOOK_SECRET = Deno.env.get('MP_WEBHOOK_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const fail = (message: string, status = 400) => json({ error: message }, status)

class MpError extends Error {
  constructor(public status: number, public body: unknown) {
    // La API de orders responde { errors: [{ message, details }] }; las otras, { message }
    const b = body as { message?: unknown; errors?: { message?: string; details?: string[] }[] } | null
    super(String(b?.errors?.[0]?.details?.[0] ?? b?.errors?.[0]?.message ?? b?.message ?? `HTTP ${status}`))
  }
}

async function mp(path: string, init: { method?: string; body?: unknown; idempotency?: string } = {}) {
  const res = await fetch(MP + path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.idempotency ? { 'X-Idempotency-Key': init.idempotency } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = { message: text }
  }
  if (!res.ok) throw new MpError(res.status, data)
  return data as Record<string, any>
}

const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } })

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2)
const alnum = (s: string) => s.replace(/[^A-Za-z0-9]/g, '')
// Mercado Pago rechaza algunos nombres con tildes o símbolos
const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9 .-]/g, '').trim()

// ---------------------------------------------------------------------------
// Sucursal y caja del local en Mercado Pago (se crean una vez)
// ---------------------------------------------------------------------------
async function ensurePos(restaurant: { id: string; name: string; address: string | null }) {
  const { data: existing } = await admin.from('mp_pos').select('*').eq('restaurant_id', restaurant.id).maybeSingle()
  if (existing) return existing as { external_pos_id: string }

  const me = await mp('/users/me')
  const key = alnum(restaurant.id).slice(0, 32)
  const storeExternal = `CMD${key}`
  const posExternal = `CMDP${key}`

  let storeId: string
  try {
    const store = await mp(`/users/${me.id}/stores`, {
      method: 'POST',
      body: {
        name: plain(restaurant.name).slice(0, 60) || 'Local',
        external_id: storeExternal,
        location: {
          street_number: '0',
          street_name: restaurant.address?.slice(0, 60) || 'Sin dirección',
          // Tiene que ser un barrio válido de la lista de Mercado Pago (después se cambia la dirección real)
          city_name: 'San Nicolás',
          state_name: 'Capital Federal',
          latitude: -34.6037,
          longitude: -58.3816,
          reference: 'Comandá',
        },
      },
    })
    storeId = String(store.id)
  } catch (e) {
    // Si la sucursal ya existía (un intento anterior a medias), se reutiliza
    const found = await mp(`/users/${me.id}/stores/search?external_id=${storeExternal}`).catch(() => null)
    const first = found?.results?.[0]
    if (!first) throw e
    storeId = String(first.id)
  }

  let posId: string | null = null
  try {
    const pos = await mp('/v2/pos', {
      method: 'POST',
      idempotency: posExternal,
      body: { name: 'Caja Comanda', store_id: storeId, external_id: posExternal, config: { qr: { operating_mode: 'pdv' } } },
    })
    posId = pos.id ? String(pos.id) : null
  } catch (e) {
    const found = await mp(`/pos?external_id=${posExternal}`).catch(() => null)
    const first = found?.results?.[0]
    if (!first) throw e
    posId = String(first.id)
  }

  const row = { restaurant_id: restaurant.id, mp_user_id: String(me.id), mp_store_id: storeId, mp_pos_id: posId, external_pos_id: posExternal }
  await admin.from('mp_pos').upsert(row)
  return row
}

// ---------------------------------------------------------------------------
// Conciliación: el estado de la order en Mercado Pago manda
// ---------------------------------------------------------------------------
type Charge = { id: string; status: string; mp_order_id: string | null; amount: number; order_id: string; restaurant_id: string }

async function reconcile(charge: Charge, order?: Record<string, any>) {
  if (!charge.mp_order_id) return charge
  const o = order ?? (await mp(`/v1/orders/${charge.mp_order_id}`))
  const status: string = o.status
  const payments: any[] = o.transactions?.payments ?? []
  const paid = payments.filter((p) => ['processed', 'approved', 'accredited'].includes(String(p.status)))

  if (status === 'processed' || paid.length > 0) {
    const amount = paid.reduce((s, p) => s + Number(p.paid_amount ?? p.amount ?? 0), 0) || Number(o.total_amount)
    const { data: result, error } = await admin.rpc('mp_charge_settle', {
      p_charge: charge.id,
      p_mp_payment: String(paid[0]?.id ?? payments[0]?.id ?? ''),
      p_amount: amount,
    })
    if (error) throw error
    if (result === 'refund') {
      try {
        await mp(`/v1/orders/${charge.mp_order_id}/refund`, { method: 'POST', idempotency: `refund-${charge.id}` })
        await admin.from('mp_charges').update({ status: 'refunded' }).eq('id', charge.id)
      } catch (e) {
        await admin.from('mp_charges').update({ error: `No se pudo devolver el pago en Mercado Pago: ${(e as Error).message}` }).eq('id', charge.id)
      }
    }
  } else if (['canceled', 'cancelled', 'expired', 'refunded'].includes(status)) {
    const next = status === 'cancelled' ? 'canceled' : status
    if (charge.status === 'created') await admin.from('mp_charges').update({ status: next }).eq('id', charge.id)
  }
  const { data } = await admin.from('mp_charges').select('*').eq('id', charge.id).single()
  return data
}

// ---------------------------------------------------------------------------
// Acciones con sesión
// ---------------------------------------------------------------------------
async function withUser(req: Request) {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (!jwt) return null
  const { data, error } = await admin.auth.getUser(jwt)
  if (error || !data.user) return null
  return { user: data.user }
}

// La función usa la service role, así que la pertenencia al local se controla acá
async function roleIn(restaurantId: string, userId: string) {
  const { data } = await admin
    .from('restaurant_members')
    .select('role')
    .eq('restaurant_id', restaurantId)
    .eq('user_id', userId)
    .eq('active', true)
    .maybeSingle()
  return (data?.role as string | undefined) ?? null
}

async function createCharge(userId: string, orderId: string, amount: number) {
  const { data: order } = await admin
    .from('orders')
    .select('id, restaurant_id, number, status, total, paid_total, type, customer_name')
    .eq('id', orderId)
    .maybeSingle()
  const role = order ? await roleIn(order.restaurant_id, userId) : null
  if (!order || !role) return fail('No se encontró la comanda.', 404)
  if (!['owner', 'manager', 'cashier', 'waiter'].includes(role)) return fail('Tu rol no puede cobrar.', 403)
  if (order.status !== 'open') return fail('Solo se puede cobrar una comanda abierta.')
  const remaining = Math.round((Number(order.total) - Number(order.paid_total)) * 100) / 100
  if (!(amount > 0)) return fail('Ingresá el monto a cobrar.')
  if (amount > remaining + 0.009) return fail(`El monto supera lo que falta cobrar ($ ${money(remaining)}).`)

  const { data: restaurant } = await admin.from('restaurants').select('id, name, address').eq('id', order.restaurant_id).single()
  if (!restaurant) return fail('No se encontró el local.', 404)

  // Un QR por comanda a la vez: los anteriores sin pagar se cancelan
  const { data: open } = await admin.from('mp_charges').select('*').eq('order_id', order.id).eq('status', 'created')
  for (const c of open ?? []) {
    if (c.mp_order_id) await mp(`/v1/orders/${c.mp_order_id}/cancel`, { method: 'POST', idempotency: `cancel-${c.id}` }).catch(() => null)
    await reconcile(c).catch(() => null)
    await admin.from('mp_charges').update({ status: 'canceled' }).eq('id', c.id).eq('status', 'created')
  }

  const pos = await ensurePos(restaurant)
  const { data: charge, error } = await admin
    .from('mp_charges')
    .insert({ restaurant_id: order.restaurant_id, order_id: order.id, amount, created_by: userId })
    .select('*')
    .single()
  if (error || !charge) return fail('No se pudo crear el cobro.', 500)

  const title = order.number ? `${restaurant.name} · Comanda #${order.number}` : restaurant.name
  try {
    const created = await mp('/v1/orders', {
      method: 'POST',
      idempotency: charge.id,
      body: {
        type: 'qr',
        total_amount: money(amount),
        description: title.slice(0, 150),
        external_reference: charge.id,
        expiration_time: 'PT15M',
        config: { qr: { external_pos_id: pos.external_pos_id, mode: 'dynamic' } },
        transactions: { payments: [{ amount: money(amount) }] },
        items: [{ title: title.slice(0, 150), unit_price: money(amount), quantity: 1, unit_measure: 'unit' }],
      },
    })
    const qr = created.type_response?.qr_data ?? created.qr_data ?? created.config?.qr?.qr_data ?? null
    const { data: saved } = await admin
      .from('mp_charges')
      .update({ mp_order_id: String(created.id), qr_data: qr, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() })
      .eq('id', charge.id)
      .select('*')
      .single()
    if (!qr) return fail('Mercado Pago no devolvió el código QR.', 502)
    return json({ charge: saved })
  } catch (e) {
    const msg = (e as Error).message
    await admin.from('mp_charges').update({ status: 'failed', error: msg }).eq('id', charge.id)
    return fail(`Mercado Pago rechazó el cobro: ${msg}`, 502)
  }
}

async function chargeFor(userId: string, chargeId: string) {
  const { data } = await admin.from('mp_charges').select('*').eq('id', chargeId).maybeSingle()
  if (!data || !(await roleIn(data.restaurant_id, userId))) return null
  return data as Charge
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------
async function validSignature(req: Request, dataId: string) {
  if (!WEBHOOK_SECRET) return true
  const header = req.headers.get('x-signature') ?? ''
  const requestId = req.headers.get('x-request-id') ?? ''
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]))
  if (!parts.ts || !parts.v1) return false
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(manifest)))
  const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
  return hex === parts.v1
}

async function webhook(req: Request) {
  const url = new URL(req.url)
  const body = await req.json().catch(() => ({}))
  const dataId = url.searchParams.get('data.id') ?? body?.data?.id ?? ''
  const type = url.searchParams.get('type') ?? body?.type ?? ''
  if (!dataId || (type && type !== 'order')) return json({ ignored: true })
  if (!(await validSignature(req, String(dataId)))) return fail('Firma inválida', 401)
  const { data: charge } = await admin.from('mp_charges').select('*').eq('mp_order_id', String(dataId)).maybeSingle()
  if (!charge) return json({ ignored: true })
  await reconcile(charge as Charge)
  return json({ ok: true })
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return fail('Método no permitido', 405)
  const url = new URL(req.url)

  try {
    if (url.pathname.endsWith('/webhook')) return await webhook(req)

    if (!TOKEN) return fail('Falta configurar Mercado Pago en el servidor (MP_ACCESS_TOKEN).', 503)

    const session = await withUser(req)
    if (!session) return fail('Iniciá sesión.', 401)
    const body = await req.json().catch(() => ({}))

    switch (body.action) {
      case 'status': {
        const me = await mp('/users/me')
        return json({ connected: true, nickname: me.nickname ?? null, user_id: me.id, test: TOKEN.startsWith('TEST-') || /^TEST/i.test(String(me.nickname ?? '')) })
      }
      case 'create':
        return await createCharge(session.user.id, String(body.order_id ?? ''), Number(body.amount))
      case 'refresh': {
        const charge = await chargeFor(session.user.id, String(body.charge_id ?? ''))
        if (!charge) return fail('No se encontró el cobro.', 404)
        return json({ charge: charge.status === 'created' ? await reconcile(charge) : charge })
      }
      case 'cancel': {
        const charge = await chargeFor(session.user.id, String(body.charge_id ?? ''))
        if (!charge) return fail('No se encontró el cobro.', 404)
        if (charge.status === 'created' && charge.mp_order_id) {
          await mp(`/v1/orders/${charge.mp_order_id}/cancel`, { method: 'POST', idempotency: `cancel-${charge.id}` }).catch(() => null)
        }
        return json({ charge: await reconcile(charge).catch(() => charge) })
      }
      default:
        return fail('Acción desconocida.')
    }
  } catch (e) {
    if (e instanceof MpError) {
      if (e.status === 401) return fail('Mercado Pago rechazó las credenciales: revisá MP_ACCESS_TOKEN.', 502)
      return fail(`Error de Mercado Pago: ${e.message}`, 502)
    }
    console.error(e)
    return fail('Error inesperado en el servidor.', 500)
  }
})
