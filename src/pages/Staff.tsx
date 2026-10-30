import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { Role, roleDescription, roleLabel } from '../lib/roles'
import { dateOnly, friendlyError } from '../lib/format'
import { ErrorNotice, Loading, Modal, PageHeader, StatusBadge } from '../components/ui'

type Member = { user_id: string; full_name: string; email: string | null; role: Role; status: string; joined_at: string }
type Invitation = { id: string; email: string; role: Role; status: string; created_at: string; expires_at: string }
const ASSIGNABLE: Exclude<Role, 'owner'>[] = ['admin', 'stock_manager', 'cashier', 'accountant']

export default function Staff() {
  const { businessId, role, user } = useAccount()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [invites, setInvites] = useState<Invitation[]>([])
  const [error, setError] = useState('')
  const [inviting, setInviting] = useState(false)
  const [editing, setEditing] = useState<Member | null>(null)
  const [copied, setCopied] = useState(false)
  const assignable = ASSIGNABLE.filter(r => role === 'owner' || r !== 'admin')
  const signupLink = `${window.location.origin}/signup?staff=1`

  const load = useCallback(async () => {
    setError('')
    const [staff, pending] = await Promise.all([
      supabase.rpc('list_business_staff', { target_business_id: businessId }),
      supabase.from('staff_invitations').select('id,email,role,status,created_at,expires_at').eq('business_id', businessId).eq('status', 'pending').order('created_at', { ascending: false }),
    ])
    if (staff.error) { setError(friendlyError(staff.error)); return }
    setMembers(staff.data as Member[])
    setInvites((pending.data || []) as Invitation[])
  }, [businessId])
  useEffect(() => { load() }, [load])

  async function revoke(invite: Invitation) {
    const { error: revokeError } = await supabase.rpc('revoke_staff_invitation', { target_business_id: businessId, invitation_id: invite.id })
    if (revokeError) setError(friendlyError(revokeError)); else load()
  }

  async function copyLink() {
    try { await navigator.clipboard.writeText(signupLink); setCopied(true); window.setTimeout(() => setCopied(false), 2000) } catch { setCopied(false) }
  }

  return <>
    <PageHeader title="Staff" subtitle="Who can use Radari for this business, and what they can do" actions={<button type="button" className="button" onClick={() => setInviting(true)}>+ Invite staff</button>} />
    <ErrorNotice message={error} onRetry={load} />
    <section className="panel how-it-works">
      <h2>How staff join</h2>
      <ol>
        <li>Invite them here using their email address and choose a role.</li>
        <li>Send them this link to create their own login: <code>{signupLink}</code> <button type="button" className="link-button" onClick={copyLink}>{copied ? 'Copied ✓' : 'Copy link'}</button></li>
        <li>Once they confirm their email and sign in, they join your business automatically. Invitations expire after 14 days.</li>
      </ol>
    </section>
    {!members ? <Loading /> : <div className="table-wrap"><table className="data-table">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th aria-label="Actions" /></tr></thead>
      <tbody>{members.map(m => <tr key={m.user_id}>
        <td data-label="Name"><strong>{m.full_name}</strong>{m.user_id === user.id && <small>You</small>}</td>
        <td data-label="Email">{m.email || '—'}</td>
        <td data-label="Role">{roleLabel[m.role]}</td>
        <td data-label="Status"><StatusBadge status={m.status} /></td>
        <td data-label="Joined">{dateOnly(m.joined_at)}</td>
        <td className="row-actions">{m.role !== 'owner' && m.user_id !== user.id && (role === 'owner' || m.role !== 'admin') && <button type="button" onClick={() => setEditing(m)}>Change</button>}</td>
      </tr>)}</tbody>
    </table></div>}

    {invites.length > 0 && <section className="panel"><h2>Pending invitations</h2>
      <ul className="simple-list">{invites.map(i => <li key={i.id}>
        <span><strong>{i.email}</strong><small>{roleLabel[i.role]} · expires {dateOnly(i.expires_at)}</small></span>
        <button type="button" className="button secondary small" onClick={() => revoke(i)}>Cancel invite</button>
      </li>)}</ul></section>}

    <section className="panel"><h2>What each role can do</h2>
      <dl className="role-list"><dt>Owner</dt><dd>Everything, including paying for the subscription and managing admins</dd>
        {ASSIGNABLE.map(r => <div key={r}><dt>{roleLabel[r]}</dt><dd>{roleDescription[r]}</dd></div>)}</dl></section>

    {inviting && <InviteForm roles={assignable} onClose={() => setInviting(false)} onSaved={() => { setInviting(false); load() }} />}
    {editing && <EditMember member={editing} roles={assignable} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
  </>
}

function InviteForm({ roles, onClose, onSaved }: { roles: Exclude<Role, 'owner'>[]; onClose: () => void; onSaved: () => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const { error: inviteError } = await supabase.rpc('invite_staff', { target_business_id: businessId, staff_email: String(form.get('email')).trim().toLowerCase(), staff_role: String(form.get('role')) })
    setBusy(false)
    if (inviteError) setError(friendlyError(inviteError)); else onSaved()
  }
  return <Modal title="Invite staff" onClose={onClose}>
    <form onSubmit={submit}>
      <label>Email address<input name="email" type="email" required autoFocus /></label>
      <fieldset className="radio-cards"><legend>Role</legend>{roles.map((r, index) => <label key={r} className="radio-card">
        <input type="radio" name="role" value={r} defaultChecked={r === 'cashier' || (index === 0 && !roles.includes('cashier'))} />
        <span><strong>{roleLabel[r]}</strong><small>{roleDescription[r]}</small></span></label>)}</fieldset>
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Inviting…' : 'Send invitation'}</button>
    </form>
  </Modal>
}

function EditMember({ member, roles, onClose, onSaved }: { member: Member; roles: Exclude<Role, 'owner'>[]; onClose: () => void; onSaved: () => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const { error: saveError } = await supabase.rpc('update_staff_member', { target_business_id: businessId, target_user_id: member.user_id, new_role: String(form.get('role')), new_status: String(form.get('status')) })
    setBusy(false)
    if (saveError) setError(friendlyError(saveError)); else onSaved()
  }
  return <Modal title={`Change access — ${member.full_name}`} onClose={onClose}>
    <form onSubmit={submit}>
      <label>Role<select name="role" defaultValue={member.role}>{roles.map(r => <option key={r} value={r}>{roleLabel[r]}</option>)}</select></label>
      <label>Access<select name="status" defaultValue={member.status === 'disabled' ? 'disabled' : 'active'}><option value="active">Active — can sign in</option><option value="disabled">Disabled — blocked immediately</option></select></label>
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
    </form>
  </Modal>
}
