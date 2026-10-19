import { TopBar } from '../components/AppShell'

/** Secciones del MVP que todavía no están construidas. */
const copy = {
  comandas: {
    title: 'Comandas',
    heading: 'Todavía no hay comandas para mostrar',
    body: 'Acá vas a ver las ventas abiertas de mesa, mostrador y take away, con su total y lo que falta cobrar. Por ahora, abrí mesas desde el Salón.',
  },
  cocina: {
    title: 'Cocina',
    heading: 'La pantalla de cocina todavía no está activa',
    body: 'Acá van a llegar los pedidos enviados por los mozos, ordenados por demora, para marcarlos en preparación y listos.',
  },
  caja: {
    title: 'Caja',
    heading: 'La caja todavía no está activa',
    body: 'Acá vas a abrir el turno con el efectivo inicial, registrar ingresos y retiros, y cerrar con el arqueo calculado.',
  },
} as const

export function Upcoming({ section }: { section: keyof typeof copy }) {
  const c = copy[section]
  return (
    <>
      <TopBar title={c.title} />
      <div className="content">
        <div className="empty">
          <h2>{c.heading}</h2>
          <p className="muted">{c.body}</p>
        </div>
      </div>
    </>
  )
}
