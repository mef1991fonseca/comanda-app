// Cobro con QR de Mercado Pago.
//
//  POST /mercadopago            (con sesión)  { action: 'status' | 'connect' | 'disconnect' | 'create' | 'refresh' | 'cancel', ... }
//  GET  /mercadopago/oauth      (Mercado Pago) vuelta de la vinculación de cuenta (?code&state)
//  POST /mercadopago/webhook    (Mercado Pago) notificaciones de "Order (Mercado Pago)"
//
// Cada local vincula su cuenta con OAuth (secretos MP_CLIENT_ID y MP_CLIENT_SECRET de la aplicación de
// ALTech; la URL de redirección es esta función + /oauth). Sus tokens quedan en mp_credentials, que solo
// lee la service role, y se renuevan solos antes de vencer (duran 180 días). Si un local no vinculó su
// cuenta, se usa la cuenta general (MP_ACCESS_TOKEN). Los tokens nunca llegan al dispositivo.
// El estado de un cobro siempre se toma de la API de Mercado Pago (GET /v1/orders/{id}), nunca del cuerpo
// de una notificación, así que una notificación falsa a lo sumo provoca una consulta.
import { createClient } from 'npm:@supabase/supabase-js@2'

const MP = 'https://api.mercadopago.com'
const TOKEN = Deno.env.get('MP_ACCESS_TOKEN') ?? ''
const CLIENT_ID = Deno.env.get('MP_CLIENT_ID') ?? ''
const CLIENT_SECRET = Deno.env.get('MP_CLIENT_SECRET') ?? ''
const USE_PKCE = Deno.env.get('MP_OAUTH_PKCE') !== '0'
const APP_URL = (Deno.env.get('APP_URL') ?? 'https://comanda-app.pages.dev').replace(/\/$/, '')
const WEBHOOK_SECRET = Deno.env.get('MP_WEBHOOK_SECRET') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

async function mp(token: string, path: string, init: { method?: string; body?: unknown; idempotency?: string } = {}) {
  const res = await fetch(MP + path, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
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

// ---------------------------------------------------------------------------
// Cuenta de Mercado Pago de cada local
// ---------------------------------------------------------------------------
class NoAccount extends Error {}

type Account = { token: string; own: boolean; mpUserId: string | null }

async function oauthToken(body: Record<string, unknown>) {
  const res = await fetch(`${MP}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, ...body }),
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.access_token) throw new MpError(res.status, data)
  return data as { access_token: string; refresh_token?: string; user_id?: number; expires_in?: number; live_mode?: boolean }
}

/** Token con el que se cobra para el local: el de su cuenta (renovado si está por vencer) o el general. */
async function accountFor(restaurantId: string): Promise<Account> {
  const [{ data: acc }, { data: cred }] = await Promise.all([
    admin.from('mp_accounts').select('*').eq('restaurant_id', restaurantId).maybeSingle(),
    admin.from('mp_credentials').select('*').eq('restaurant_id', restaurantId).maybeSingle(),
  ])
  if (acc && cred) {
    const soon = acc.expires_at && new Date(acc.expires_at).getTime() < Date.now() + 15 * 24 * 3600_000
    if (soon && cred.refresh_token && CLIENT_ID && CLIENT_SECRET) {
      try {
        const t = await oauthToken({ grant_type: 'refresh_token', refresh_token: cred.refresh_token })
        await admin.from('mp_credentials').update({ access_token: t.access_token, refresh_token: t.refresh_token ?? cred.refresh_token, updated_at: new Date().toISOString() }).eq('restaurant_id', restaurantId)
        await admin.from('mp_accounts').update({ expires_at: new Date(Date.now() + (t.expires_in ?? 15552000) * 1000).toISOString(), refreshed_at: new Date().toISOString() }).eq('restaurant_id', restaurantId)
        return { token: t.access_token, own: true, mpUserId: acc.mp_user_id }
      } catch (e) {
        console.error('No se pudo renovar el token de Mercado Pago', restaurantId, (e as Error).message)
      }
    }
    return { token: cred.access_token, own: true, mpUserId: acc.mp_user_id }
  }
  if (!TOKEN) throw new NoAccount()
  return { token: TOKEN, own: false, mpUserId: null }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const randomToken = (n: number) => b64url(crypto.getRandomValues(new Uint8Array(n)))
const redirectUri = () => `${SUPABASE_URL}/functions/v1/mercadopago/oauth`

async function connectUrl(userId: string, restaurantId: string) {
  if (!CLIENT_ID || !CLIENT_SECRET) return fail('Falta configurar la aplicación de Mercado Pago en el servidor (MP_CLIENT_ID y MP_CLIENT_SECRET).', 503)
  const role = await roleIn(restaurantId, userId)
  if (role !== 'owner' && role !== 'manager') return fail('Solo el dueño o el encargado pueden vincular la cuenta.', 403)
  const state = randomToken(24)
  const verifier = randomToken(48)
  await admin.from('mp_oauth_states').delete().lt('created_at', new Date(Date.now() - 15 * 60_000).toISOString())
  await admin.from('mp_oauth_states').insert({ state, restaurant_id: restaurantId, user_id: userId, code_verifier: verifier })
  const params = new URLSearchParams({ client_id: CLIENT_ID, response_type: 'code', platform_id: 'mp', state, redirect_uri: redirectUri() })
  if (USE_PKCE) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    params.set('code_challenge', b64url(digest))
    params.set('code_challenge_method', 'S256')
  }
  return json({ url: `https://auth.mercadopago.com/authorization?${params}` })
}

/** Vuelta de Mercado Pago después de que el dueño autoriza: guarda los tokens y vuelve a la app. */
async function oauthCallback(url: URL) {
  const back = (status: string, motivo?: string) =>
    Response.redirect(`${APP_URL}/mercadopago?mp=${status}${motivo ? `&motivo=${encodeURIComponent(motivo)}` : ''}`, 302)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state') ?? ''
  if (!code) return back('error', url.searchParams.get('error_description') ?? 'Mercado Pago no autorizó la vinculación.')
  const { data: st } = await admin.from('mp_oauth_states').select('*').eq('state', state).maybeSingle()
  if (!st) return back('error', 'El enlace venció. Probá de nuevo.')
  await admin.from('mp_oauth_states').delete().eq('state', state)
  if (new Date(st.created_at).getTime() < Date.now() - 15 * 60_000) return back('error', 'El enlace venció. Probá de nuevo.')
  try {
    const t = await oauthToken({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      ...(USE_PKCE ? { code_verifier: st.code_verifier } : {}),
    })
    const me = await mp(t.access_token, '/users/me')
    const userId = String(t.user_id ?? me.id)
    const { data: prev } = await admin.from('mp_accounts').select('mp_user_id').eq('restaurant_id', st.restaurant_id).maybeSingle()
    // La sucursal y la caja de MP son de la cuenta: con otra cuenta se crean de nuevo
    if (!prev || prev.mp_user_id !== userId) await admin.from('mp_pos').delete().eq('restaurant_id', st.restaurant_id)
    await admin.from('mp_credentials').upsert({ restaurant_id: st.restaurant_id, access_token: t.access_token, refresh_token: t.refresh_token ?? null, updated_at: new Date().toISOString() })
    await admin.from('mp_accounts').upsert({
      restaurant_id: st.restaurant_id,
      mp_user_id: userId,
      nickname: me.nickname ?? null,
      live_mode: t.live_mode ?? true,
      connected_by: st.user_id,
      connected_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + (t.expires_in ?? 15552000) * 1000).toISOString(),
      refreshed_at: null,
    })
    return back('conectado')
  } catch (e) {
    console.error('OAuth Mercado Pago', (e as Error).message)
    return back('error', `Mercado Pago rechazó la vinculación: ${(e as Error).message}`)
  }
}

async function disconnect(userId: string, restaurantId: string) {
  if ((await roleIn(restaurantId, userId)) !== 'owner') return fail('Solo el dueño puede desvincular la cuenta.', 403)
  const { data: open } = await admin.from('mp_charges').select('id').eq('restaurant_id', restaurantId).eq('status', 'created').limit(1)
  if (open?.length) return fail('Hay un cobro con QR esperando el pago. Terminalo o cancelalo antes de desvincular.')
  await admin.from('mp_credentials').delete().eq('restaurant_id', restaurantId)
  await admin.from('mp_accounts').delete().eq('restaurant_id', restaurantId)
  await admin.from('mp_pos').delete().eq('restaurant_id', restaurantId)
  return json({ ok: true })
}

async function status(userId: string, restaurantId: string) {
  if (!(await roleIn(restaurantId, userId))) return fail('No se encontró el local.', 404)
  const oauthReady = Boolean(CLIENT_ID && CLIENT_SECRET)
  const { data: acc } = await admin.from('mp_accounts').select('*').eq('restaurant_id', restaurantId).maybeSingle()
  if (acc) return json({ connected: true, own: true, nickname: acc.nickname, test: !acc.live_mode, oauth_ready: oauthReady, expires_at: acc.expires_at })
  if (!TOKEN) return json({ connected: false, own: false, nickname: null, test: false, oauth_ready: oauthReady })
  const me = await mp(TOKEN, '/users/me')
  return json({ connected: true, own: false, nickname: me.nickname ?? null, test: TOKEN.startsWith('TEST-') || /^TEST/i.test(String(me.nickname ?? '')), oauth_ready: oauthReady })
}

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2)
const alnum = (s: string) => s.replace(/[^A-Za-z0-9]/g, '')
// Mercado Pago rechaza algunos nombres con tildes o símbolos
const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9 .-]/g, '').trim()

// ---------------------------------------------------------------------------
// Sucursal y caja del local en Mercado Pago (se crean una vez)
// ---------------------------------------------------------------------------
async function ensurePos(acc: Account, restaurant: { id: string; name: string; address: string | null }) {
  const { data: existing } = await admin.from('mp_pos').select('*').eq('restaurant_id', restaurant.id).maybeSingle()
  if (existing && (!acc.mpUserId || existing.mp_user_id === acc.mpUserId)) return existing as { external_pos_id: string }
  if (existing) await admin.from('mp_pos').delete().eq('restaurant_id', restaurant.id)

  const token = acc.token
  const me = await mp(token, '/users/me')
  const key = alnum(restaurant.id).slice(0, 32)
  const storeExternal = `CMD${key}`
  const posExternal = `CMDP${key}`

  let storeId: string
  try {
    const store = await mp(token, `/users/${me.id}/stores`, {
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
    const found = await mp(token, `/users/${me.id}/stores/search?external_id=${storeExternal}`).catch(() => null)
    const first = found?.results?.[0]
    if (!first) throw e
    storeId = String(first.id)
  }

  let posId: string | null = null
  try {
    const pos = await mp(token, '/v2/pos', {
      method: 'POST',
      idempotency: posExternal,
      body: { name: 'Caja Comanda', store_id: storeId, external_id: posExternal, config: { qr: { operating_mode: 'pdv' } } },
    })
    posId = pos.id ? String(pos.id) : null
  } catch (e) {
    const found = await mp(token, `/pos?external_id=${posExternal}`).catch(() => null)
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
  const { token } = await accountFor(charge.restaurant_id)
  const o = order ?? (await mp(token, `/v1/orders/${charge.mp_order_id}`))
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
        await mp(token, `/v1/orders/${charge.mp_order_id}/refund`, { method: 'POST', idempotency: `refund-${charge.id}` })
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

  const acc = await accountFor(order.restaurant_id)
  // Un QR por comanda a la vez: los anteriores sin pagar se cancelan
  const { data: open } = await admin.from('mp_charges').select('*').eq('order_id', order.id).eq('status', 'created')
  for (const c of open ?? []) {
    if (c.mp_order_id) await mp(acc.token, `/v1/orders/${c.mp_order_id}/cancel`, { method: 'POST', idempotency: `cancel-${c.id}` }).catch(() => null)
    await reconcile(c).catch(() => null)
    await admin.from('mp_charges').update({ status: 'canceled' }).eq('id', c.id).eq('status', 'created')
  }

  const pos = await ensurePos(acc, restaurant)
  const { data: charge, error } = await admin
    .from('mp_charges')
    .insert({ restaurant_id: order.restaurant_id, order_id: order.id, amount, created_by: userId })
    .select('*')
    .single()
  if (error || !charge) return fail('No se pudo crear el cobro.', 500)

  const title = order.number ? `${restaurant.name} · Comanda #${order.number}` : restaurant.name
  try {
    const created = await mp(acc.token, '/v1/orders', {
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
  const url = new URL(req.url)
  if (req.method === 'GET' && url.pathname.endsWith('/oauth')) {
    try {
      return await oauthCallback(url)
    } catch (e) {
      console.error(e)
      return Response.redirect(`${APP_URL}/mercadopago?mp=error&motivo=${encodeURIComponent('Error inesperado al vincular la cuenta.')}`, 302)
    }
  }
  if (req.method !== 'POST') return fail('Método no permitido', 405)

  try {
    if (url.pathname.endsWith('/webhook')) return await webhook(req)

    const session = await withUser(req)
    if (!session) return fail('Iniciá sesión.', 401)
    const body = await req.json().catch(() => ({}))

    switch (body.action) {
      case 'status':
        return await status(session.user.id, String(body.restaurant_id ?? ''))
      case 'connect':
        return await connectUrl(session.user.id, String(body.restaurant_id ?? ''))
      case 'disconnect':
        return await disconnect(session.user.id, String(body.restaurant_id ?? ''))
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
          const { token } = await accountFor(charge.restaurant_id)
          await mp(token, `/v1/orders/${charge.mp_order_id}/cancel`, { method: 'POST', idempotency: `cancel-${charge.id}` }).catch(() => null)
        }
        return json({ charge: await reconcile(charge).catch(() => charge) })
      }
      default:
        return fail('Acción desconocida.')
    }
  } catch (e) {
    if (e instanceof NoAccount) return fail('Este local todavía no vinculó su cuenta de Mercado Pago (Más → Mercado Pago).', 503)
    if (e instanceof MpError) {
      if (e.status === 401) return fail('Mercado Pago rechazó las credenciales. Volvé a vincular la cuenta en Más → Mercado Pago.', 502)
      return fail(`Error de Mercado Pago: ${e.message}`, 502)
    }
    console.error(e)
    return fail('Error inesperado en el servidor.', 500)
  }
})
