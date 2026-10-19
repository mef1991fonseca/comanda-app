import { Navigate, Route, Routes } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { useRestaurant } from './lib/restaurant'
import { AppShell, homeFor } from './components/AppShell'
import { Login } from './pages/Login'
import { Onboarding } from './pages/Onboarding'
import { Salon } from './pages/Salon'
import { Comandas } from './pages/Comandas'
import { Comanda } from './pages/Comanda'
import { Carta } from './pages/Carta'
import { Modificadores } from './pages/Modificadores'
import { Mas } from './pages/Mas'
import { Cocina } from './pages/Cocina'
import { Caja } from './pages/Caja'

export function App() {
  const { session, loading: authLoading } = useAuth()
  const { loading, error, current, reload } = useRestaurant()

  if (authLoading) return <div className="center-screen">Cargando…</div>
  if (!session) return <Login />
  if (loading && !current) return <div className="center-screen">Cargando tu local…</div>
  if (error && !current)
    return (
      <div className="center-screen" style={{ gap: 12, padding: 24 }}>
        <div className="notice notice-error" role="alert">No pudimos cargar tus locales: {error}</div>
        <button className="btn btn-primary" onClick={() => void reload()}>Reintentar</button>
      </div>
    )
  if (!current) return <Onboarding />

  return (
    <Routes>
      <Route path="/nuevo-local" element={<Onboarding first={false} />} />
      <Route element={<AppShell />}>
        <Route path="/salon" element={<Salon />} />
        <Route path="/comandas" element={<Comandas />} />
        <Route path="/comanda/:orderId" element={<Comanda />} />
        {(current.role === 'owner' || current.role === 'manager') && (
          <>
            <Route path="/carta" element={<Carta />} />
            <Route path="/carta/modificadores" element={<Modificadores />} />
          </>
        )}
        <Route path="/cocina" element={<Cocina />} />
        <Route path="/caja" element={<Caja />} />
        <Route path="/mas" element={<Mas />} />
      </Route>
      <Route path="*" element={<Navigate to={homeFor(current.role)} replace />} />
    </Routes>
  )
}
