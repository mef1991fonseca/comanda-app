import { useCallback, useEffect, useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import { useAuth } from '../lib/auth'
import { useCurrentRestaurant } from '../lib/restaurant'
import { roleLabel } from '../lib/format'
import { inviteUrl, roleHelp } from '../lib/invites'
import type { Enums, Tables } from '../lib/database.types'
import { TopBar } from '../components/AppShell'
import { Sheet } from '../components/Sheet'

type Role = Enums<'member_role'>
type Member = { user_id: string; role: Role; display_name: string | null; name: string | null }
type Invite = Tables<'restaurant_invites'>

const ROLES: Role[] = ['waiter', 'kitchen', 'cashier', 'manager', 'owner']

const expiry = (iso: string) => new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'long' })

/** Equipo del local: personas, roles e invitaciones por link (dueño y encargado). */
export function Equipo() {
  const { session } = useAuth()
  const { restaurant, role: myRole } = useCurrentRestaurant()
  const me = session?.user.id
  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [error, setError] = useState<string | null>(null)
  const [inviting, setInviting] = useState(false)
  const [sharing, setSharing] = useState<Invite | null>(null)
  const [editing, setEditing] = useState<Member | null>(null)

  const assignable = myRole === 'owner' ? ROLES : ROLES.filter((r) => r !== 'owner')
  const canManage = (m: Member) => m.user_id !== me && (myRole === 'owner' || m.role !== 'owner')

  const load = useCallback(async () => {
    const [m, i] = await Promise.all([
      supabase
        .from('restaurant_members')
        .select('user_id, role, display_name')
        .eq('restaurant_id', restaurant.id)
        .eq('active', true),
      supabase
        .from('restaurant_invites')
        .select('*')
        .eq('restaurant_id', restaurant.id)
        .is('accepted_at', null)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }),
    ])
    if (m.error || i.error) return setError(errorMessage(m.error ?? i.error))
    const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', m.data.map((x) => x.user_id))
    const names = new Map((profiles ?? []).map((p) => [p.id, p.full_name]))
    const order = (r: Role) => ['owner', 'manager', 'cashier', 'waiter', 'kitchen'].indexOf(r)
    setMembers(
      m.data
        .map((x) => ({ ...x, name: names.get(x.user_id) ?? null }))
        .sort((a, b) => order(a.role) - order(b.role) || (a.name ?? '').localeCompare(b.name ?? '', 'es')),
    )
    setInvites(i.data)
    setError(null)
  }, [restaurant.id])

  useEffect(() => {
    void load()
  }, [load])

  async function revoke(inv: Invite) {
    const { error } = await supabase.from('restaurant_invites').update({ revoked_at: new Date().toISOString() }).eq('id', inv.id)
    if (error) setError(errorMessage(error))
    void load()
  }

  return (
    <>
      <TopBar title="Equipo" />
      <div className="content">
        {error && <div className="notice notice-error" role="alert">{error}</div>}

        <button className="btn btn-primary btn-block" onClick={() => setInviting(true)}>
          Invitar a alguien
        </button>

        <section className="section" style={{ marginTop: 20 }}>
          <h2>Personas · {members.length}</h2>
          <div className="list">
            {members.map((m) => {
              const label = (
                <>
                  <span className="product-line">
                    <span>
                      {m.display_name ?? m.name ?? 'Sin nombre'}
                      {m.user_id === me && <span className="muted"> (vos)</span>}
                    </span>
                    <span className="product-sub">{roleHelp[m.role]}</span>
                  </span>
                  <span className="badge">{roleLabel[m.role]}</span>
                </>
              )
              return canManage(m) ? (
                <button key={m.user_id} className="list-row" onClick={() => setEditing(m)} aria-label={`${m.name ?? 'Persona'}, ${roleLabel[m.role]}. Cambiar rol`}>
                  {label}
                </button>
              ) : (
                <div key={m.user_id} className="list-row">{label}</div>
              )
            })}
          </div>
        </section>

        {invites.length > 0 && (
          <section className="section">
            <h2>Invitaciones sin usar</h2>
            <div className="list">
              {invites.map((inv) => (
                <div key={inv.id} className="list-row">
                  <span className="product-line">
                    <span>{roleLabel[inv.role]}</span>
                    <span className="product-sub">Vence el {expiry(inv.expires_at)}</span>
                  </span>
                  <span style={{ display: 'flex', gap: 16 }}>
                    <button className="link-btn" onClick={() => setSharing(inv)}>Compartir</button>
                    <button className="link-btn" style={{ color: 'var(--tomato)' }} onClick={() => void revoke(inv)}>Anular</button>
                  </span>
                </div>
              ))}
            </div>
            <p className="muted">Cada link sirve para una sola persona.</p>
          </section>
        )}
      </div>

      {inviting && (
        <InviteSheet
          restaurantId={restaurant.id}
          roles={assignable}
          onClose={() => setInviting(false)}
          onCreated={(inv) => {
            setInviting(false)
            setSharing(inv)
            void load()
          }}
        />
      )}
      {sharing && <ShareSheet invite={sharing} restaurantName={restaurant.name} onClose={() => setSharing(null)} />}
      {editing && (
        <MemberSheet
          member={editing}
          roles={assignable}
          restaurantId={restaurant.id}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            void load()
          }}
        />
      )}
    </>
  )
}

function RolePicker({ roles, value, onChange, name }: { roles: Role[]; value: Role; onChange: (r: Role) => void; name: string }) {
  return (
    <fieldset className="fieldset">
      <legend>Rol</legend>
      {roles.map((r) => (
        <label key={r} className="check">
          <input type="radio" name={name} checked={value === r} onChange={() => onChange(r)} />
          <span className="product-line">
            <span>{roleLabel[r]}</span>
            <span className="product-sub">{roleHelp[r]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}

function InviteSheet({
  restaurantId,
  roles,
  onClose,
  onCreated,
}: {
  restaurantId: string
  roles: Role[]
  onClose: () => void
  onCreated: (inv: Invite) => void
}) {
  const [role, setRole] = useState<Role>('waiter')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    setBusy(true)
    const { data, error } = await supabase.from('restaurant_invites').insert({ restaurant_id: restaurantId, role }).select('*').single()
    setBusy(false)
    if (error) return setError(errorMessage(error))
    onCreated(data)
  }

  return (
    <Sheet title="Invitar a alguien" onClose={onClose}>
      <p className="muted">Creás un link y se lo mandás por WhatsApp. La persona crea su cuenta y entra con este rol.</p>
      <RolePicker roles={roles} value={role} onChange={setRole} name="invite-role" />
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="sheet-actions">
        <button className="btn btn-primary btn-block" disabled={busy} onClick={() => void create()}>
          Crear link de {roleLabel[role]?.toLowerCase()}
        </button>
        <button className="btn btn-quiet btn-block" onClick={onClose}>Cancelar</button>
      </div>
    </Sheet>
  )
}

function ShareSheet({ invite, restaurantName, onClose }: { invite: Invite; restaurantName: string; onClose: () => void }) {
  const url = inviteUrl(invite.token)
  const text = `Te invito a sumarte a ${restaurantName} en Comandá como ${roleLabel[invite.role]?.toLowerCase()}. Entrá acá: ${url}`
  const [copied, setCopied] = useState(false)
  const canShare = typeof navigator.share === 'function'

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Sheet title={`Link para ${roleLabel[invite.role]?.toLowerCase()}`} onClose={onClose}>
      <p className="muted">Sirve para una persona y vence el {expiry(invite.expires_at)}.</p>
      <div className="field">
        <label htmlFor="invite-link">Link</label>
        <input id="invite-link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      </div>
      <div className="sheet-actions">
        <a className="btn btn-primary btn-block" href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer">
          Enviar por WhatsApp
        </a>
        {canShare && (
          <button className="btn btn-quiet btn-block" onClick={() => void navigator.share({ title: 'Comandá', text }).catch(() => undefined)}>
            Compartir…
          </button>
        )}
        <button className="btn btn-quiet btn-block" onClick={() => void copy()}>
          {copied ? 'Link copiado' : 'Copiar link'}
        </button>
      </div>
    </Sheet>
  )
}

function MemberSheet({
  member,
  roles,
  restaurantId,
  onClose,
  onSaved,
}: {
  member: Member
  roles: Role[]
  restaurantId: string
  onClose: () => void
  onSaved: () => void
}) {
  const [role, setRole] = useState<Role>(member.role)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = member.display_name ?? member.name ?? 'Esta persona'

  async function save(patch: { role?: Role; active?: boolean }) {
    setBusy(true)
    const { error } = await supabase
      .from('restaurant_members')
      .update(patch)
      .eq('restaurant_id', restaurantId)
      .eq('user_id', member.user_id)
    setBusy(false)
    if (error) return setError(errorMessage(error))
    onSaved()
  }

  return (
    <Sheet title={name} onClose={onClose}>
      <RolePicker roles={roles} value={role} onChange={setRole} name="member-role" />
      {error && <div className="notice notice-error" role="alert">{error}</div>}
      <div className="sheet-actions">
        <button className="btn btn-primary btn-block" disabled={busy || role === member.role} onClick={() => void save({ role })}>
          Guardar rol
        </button>
        <button
          className="btn btn-danger btn-block"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`${name} no va a poder entrar más a este local. ¿Dar de baja?`)) void save({ active: false })
          }}
        >
          Dar de baja del local
        </button>
      </div>
    </Sheet>
  )
}
