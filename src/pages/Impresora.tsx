import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useCurrentRestaurant } from '../lib/restaurant'
import { markCurrentKitchenAsPrinted, printInBackground, usePrinterSettings } from '../lib/printer'
import { TopBar } from '../components/AppShell'

/** Configuración de la impresora de este equipo: ancho del papel e impresión automática de comandas. */
export function Impresora() {
  const { restaurant } = useCurrentRestaurant()
  const { settings, update } = usePrinterSettings(restaurant.id)
  const [stations, setStations] = useState<{ id: string; name: string }[]>([])
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    void supabase
      .from('stations')
      .select('id, name')
      .eq('restaurant_id', restaurant.id)
      .eq('active', true)
      .order('sort_order')
      .then(({ data }) => setStations(data ?? []))
  }, [restaurant.id])

  async function toggleAuto(on: boolean) {
    // Lo que ya está en cocina no se vuelve a imprimir
    if (on) await markCurrentKitchenAsPrinted(restaurant.id)
    update({ autoKitchen: on })
  }

  function toggleStation(id: string, on: boolean) {
    const current = settings.stations.length ? settings.stations : stations.map((s) => s.id)
    const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id)
    // Todas marcadas = sin filtro
    update({ stations: next.length === stations.length ? [] : next })
  }

  async function test() {
    setTesting(true)
    await printInBackground('/imprimir/prueba')
    setTesting(false)
  }

  const printsStation = (id: string) => settings.stations.length === 0 || settings.stations.includes(id)

  return (
    <>
      <TopBar title="Impresora" />
      <div className="content form">
        <p className="muted">Esta configuración vale solo para este equipo. Cada PC, tablet o celular tiene la suya.</p>

        <div className="field">
          <span className="field-label" id="paper-label">Ancho del papel</span>
          <div className="switcher" role="group" aria-labelledby="paper-label">
            <button type="button" aria-pressed={settings.paper === 80} onClick={() => update({ paper: 80 })}>80 mm</button>
            <button type="button" aria-pressed={settings.paper === 58} onClick={() => update({ paper: 58 })}>58 mm</button>
          </div>
          <span className="hint muted">Las impresoras POS58 usan papel de 58 mm.</span>
        </div>

        <section className="section">
          <h2>Comandas de cocina</h2>
          <label className="check">
            <input type="checkbox" checked={settings.autoKitchen} onChange={(e) => void toggleAuto(e.target.checked)} />
            <span>Imprimir en este equipo cada pedido que se envía a cocina</span>
          </label>
          <p className="hint muted">
            Vale para los pedidos que mandan los mozos desde cualquier celular. Activalo en un solo equipo por impresora, y
            dejá la app abierta durante el servicio. Si se agregan productos a una mesa, sale un ticket que dice AGREGADO
            con lo nuevo.
          </p>
          {settings.autoKitchen && stations.length > 1 && (
            <fieldset className="station-picks">
              <legend className="field-label">Qué estaciones imprime este equipo</legend>
              {stations.map((s) => (
                <label key={s.id} className="check">
                  <input
                    type="checkbox"
                    checked={printsStation(s.id)}
                    disabled={printsStation(s.id) && settings.stations.length === 1}
                    onChange={(e) => toggleStation(s.id, e.target.checked)}
                  />
                  <span>{s.name}</span>
                </label>
              ))}
            </fieldset>
          )}
        </section>

        <div className="sheet-actions">
          <button className="btn btn-primary" onClick={() => void test()} disabled={testing}>
            {testing ? 'Imprimiendo…' : 'Imprimir prueba'}
          </button>
        </div>

        <section className="section">
          <h2>Imprimir sin el cuadro de diálogo (PC con Windows)</h2>
          <ol className="steps-list">
            <li>
              En Windows, abrí Configuración → Bluetooth y dispositivos → Impresoras y escáneres, elegí la POS58 y tocá
              <strong> Establecer como predeterminada</strong>. Si aparece «Permitir que Windows administre la impresora
              predeterminada», desactivalo.
            </li>
            <li>
              En las preferencias de la impresora, elegí el tamaño de papel de 58 mm (o 80 mm, según el rollo).
            </li>
            <li>
              Hacé clic derecho en el escritorio → Nuevo → Acceso directo, y pegá:
              <code className="code-line">"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk-printing {window.location.origin}</code>
              Si Chrome está en otra carpeta (por ejemplo «Program Files (x86)»), usá esa ruta; con Edge es
              <code className="code-line">"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk-printing {window.location.origin}</code>
              Ponele de nombre «Comandá».
            </li>
            <li>Cerrá todas las ventanas de Chrome y abrí la app desde ese acceso directo. Probá con «Imprimir prueba».</li>
          </ol>
          <p className="hint muted">
            Sin ese acceso directo también funciona, pero cada ticket muestra el cuadro de impresión y hay que confirmar.
          </p>
        </section>
      </div>
    </>
  )
}
