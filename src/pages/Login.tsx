import { useState, type FormEvent } from 'react'
import { supabase, errorMessage } from '../lib/supabase'

type Mode = 'signin' | 'signup'

export function Login() {
  const [mode, setMode] = useState<Mode>('signin')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    if (mode === 'signin') {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) setError(errorMessage(error))
    } else {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: { data: { full_name: name.trim() }, emailRedirectTo: window.location.origin },
      })
      if (error) setError(errorMessage(error))
      else if (!data.session) setSentTo(email)
    }
    setBusy(false)
  }

  return (
    <main className="entry">
      <section className="entry-brand">
        <div className="wordmark">Comandá</div>
        <p>Salón, cocina, caja y stock de tu restaurante, desde el celular.</p>
      </section>

      <section className="entry-body">
        {sentTo ? (
          <>
            <h2>Revisá tu email</h2>
            <p>
              Te enviamos un enlace a <strong>{sentTo}</strong>. Abrilo para confirmar tu cuenta y
              después iniciá sesión acá.
            </p>
            <button className="btn btn-quiet" onClick={() => { setSentTo(null); setMode('signin') }}>
              Iniciar sesión
            </button>
          </>
        ) : (
          <>
            <div className="switcher" role="group" aria-label="Elegí cómo entrar">
              <button type="button" aria-pressed={mode === 'signin'} onClick={() => setMode('signin')}>
                Iniciar sesión
              </button>
              <button type="button" aria-pressed={mode === 'signup'} onClick={() => setMode('signup')}>
                Crear cuenta
              </button>
            </div>

            <form onSubmit={submit} style={{ display: 'grid', gap: 16 }}>
              {mode === 'signup' && (
                <div className="field">
                  <label htmlFor="name">Tu nombre</label>
                  <input id="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />
                </div>
              )}
              <div className="field">
                <label htmlFor="email">Email</label>
                <input
                  id="email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="password">Contraseña</label>
                <input
                  id="password"
                  type="password"
                  autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                  minLength={6}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {mode === 'signup' && <span className="hint">Mínimo 6 caracteres.</span>}
              </div>

              {error && <div className="notice notice-error" role="alert">{error}</div>}

              <button className="btn btn-primary btn-block" disabled={busy}>
                {mode === 'signin' ? 'Iniciar sesión' : 'Crear cuenta'}
              </button>
            </form>
          </>
        )}
      </section>
    </main>
  )
}
