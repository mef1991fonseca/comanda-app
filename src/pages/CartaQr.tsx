import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase, errorMessage } from '../lib/supabase'
import { useCurrentRestaurant, useRestaurant } from '../lib/restaurant'
import type { Tables } from '../lib/database.types'
import { TopBar } from '../components/AppShell'

/** "Bodegón Doña Rosa" → "bodegon-dona-rosa" */
export const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

export const menuUrl = (slug: string, table?: string) =>
  `${window.location.origin}/m/${slug}${table ? `?mesa=${encodeURIComponent(table)}` : ''}`

function useQrSvg(text: string | null) {
  const [svg, setSvg] = useState('')
  useEffect(() => {
    if (!text) return setSvg('')
    void QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).then(setSvg)
  }, [text])
  return svg
}

/** Publicar la carta y sacar los QR (dueño o encargado). */
export function CartaQr() {
  const { restaurant } = useCurrentRestaurant()
  const { reload } = useRestaurant()
  const navigate = useNavigate()
  const [slug, setSlug] = useState(restaurant.menu_slug ?? slugify(restaurant.name))
  const [note, setNote] = useState(restaurant.menu_note ?? '')
  const [published, setPublished] = useState(restaurant.menu_public)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const live = restaurant.menu_public && restaurant.menu_slug ? restaurant.menu_slug : null
  const svg = useQrSvg(live ? menuUrl(live) : null)

  async function save(nextPublic: boolean) {
    setBusy(true)
    setError(null)
    setSaved(null)
    const { data, error } = await supabase.rpc('set_public_menu', { p_restaurant: restaurant.id, p_slug: slug, p_public: nextPublic, p_note: note })
    setBusy(false)
    if (error) return setError(errorMessage(error))
    setSlug(data)
    setPublished(nextPublic)
    setSaved(nextPublic ? 'La carta está publicada.' : 'La carta ya no se puede ver desde afuera.')
    await reload()
  }

  return (
    <>
      <TopBar title="Carta QR" />
      <div className="content form">
        <p className="muted">
          Los clientes escanean el QR de la mesa y ven la carta con los precios actualizados. No hace falta instalar nada ni
          tener cuenta.
        </p>
        <div className="field">
          <label htmlFor="qr-slug">Dirección de la carta</label>
          <div className="slug-input">
            <span className="muted">{window.location.host}/m/</span>
            <input id="qr-slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} autoCapitalize="none" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="qr-note">Aviso arriba de la carta</label>
          <input id="qr-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: Abierto de 12 a 16 y de 20 a 24" />
        </div>
        {error && <div className="notice notice-error" role="alert">{error}</div>}
        {saved && <div className="notice notice-info" role="status">{saved}</div>}
        <div className="sheet-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => void save(true)}>
            {published ? 'Guardar cambios' : 'Publicar carta'}
          </button>
          {published && (
            <button className="btn btn-quiet" disabled={busy} onClick={() => void save(false)}>Dejar de publicar</button>
          )}
        </div>

        {live && <OrderingToggle />}

        {live && (
          <section className="section qr-share">
            <h2>Tu carta</h2>
            <div className="qr-code" role="img" aria-label="QR de la carta" dangerouslySetInnerHTML={{ __html: svg }} />
            <a className="qr-link" href={menuUrl(live)} target="_blank" rel="noreferrer">{menuUrl(live)}</a>
            <div className="sheet-actions">
              <button className="btn btn-primary" onClick={() => navigate('/imprimir/qr')}>Imprimir QR para las mesas</button>
              <button
                className="btn btn-quiet"
                onClick={() => void navigator.clipboard?.writeText(menuUrl(live)).then(() => setCopied(true)).catch(() => undefined)}
              >
                {copied ? 'Link copiado' : 'Copiar link'}
              </button>
            </div>
          </section>
        )}
      </div>
    </>
  )
}

/** Encender o pausar los pedidos que mandan los clientes desde la carta. */
function OrderingToggle() {
  const { restaurant } = useCurrentRestaurant()
  const { reload } = useRestaurant()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const on = restaurant.menu_ordering

  async function toggle() {
    setBusy(true)
    setError(null)
    const { error } = await supabase.rpc('set_menu_ordering', { p_restaurant: restaurant.id, p_enabled: !on })
    setBusy(false)
    if (error) return setError(errorMessage(error))
    await reload()
  }

  return (
    <section className="section">
      <h2>Pedidos desde la mesa</h2>
      <div className="list">
        <div className="list-row">
          <span>
            <span className="row-title">Los clientes piden desde la carta</span>
            <span className="muted row-sub">
              {on
                ? 'Cada pedido le aparece al salón para aceptarlo. Al aceptarlo se suma a la comanda de la mesa y va a cocina.'
                : 'Hoy la carta es solo para mirar. Activalo para que también puedan pedir desde la mesa.'}
            </span>
          </span>
          <button className={on ? 'btn btn-quiet' : 'btn btn-primary'} disabled={busy} onClick={() => void toggle()}>
            {on ? 'Pausar pedidos' : 'Activar pedidos'}
          </button>
        </div>
      </div>
      {on && <p className="muted">Solo se puede pedir con el QR de una mesa. El QR general sigue siendo para mirar la carta.</p>}
      {error && <div className="notice notice-error" role="alert">{error}</div>}
    </section>
  )
}

/** Hoja para imprimir: un QR por mesa (con su número) y uno general para mostrador o la vidriera. */
export function ImprimirQr() {
  const { restaurant } = useCurrentRestaurant()
  const navigate = useNavigate()
  const [tables, setTables] = useState<Tables<'tables'>[]>([])
  const [codes, setCodes] = useState<{ label: string; svg: string }[]>([])
  const slug = restaurant.menu_public ? restaurant.menu_slug : null

  useEffect(() => {
    void supabase
      .from('tables')
      .select('*')
      .eq('restaurant_id', restaurant.id)
      .eq('active', true)
      .order('sort_order')
      .then(({ data }) => setTables(data ?? []))
  }, [restaurant.id])

  useEffect(() => {
    if (!slug) return
    const all = [{ label: 'Carta', url: menuUrl(slug) }, ...tables.map((t) => ({ label: `Mesa ${t.name}`, url: menuUrl(slug, t.name) }))]
    void Promise.all(all.map(async (c) => ({ label: c.label, svg: await QRCode.toString(c.url, { type: 'svg', margin: 1 }) }))).then(setCodes)
  }, [slug, tables])

  if (!slug) return <div className="center-screen">Primero publicá la carta.</div>

  return (
    <div className="print-page">
      <div className="print-actions no-print">
        <button className="btn btn-quiet" onClick={() => navigate(-1)}>Volver</button>
        <button className="btn btn-primary" onClick={() => window.print()}>Imprimir</button>
      </div>
      <div className="qr-sheet">
        {codes.map((c) => (
          <div key={c.label} className="qr-card">
            <div className="qr-card-name">{restaurant.name}</div>
            <div className="qr-card-svg" dangerouslySetInnerHTML={{ __html: c.svg }} />
            <div className="qr-card-label">{c.label}</div>
            <div className="qr-card-hint">Escaneá para ver la carta</div>
          </div>
        ))}
      </div>
    </div>
  )
}
