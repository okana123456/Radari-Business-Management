import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { friendlyError, money } from '../lib/format'
import { Empty, ErrorNotice, Loading, Modal, PageHeader, Stat } from '../components/ui'

type Member = { id: string; name: string; phone: string | null; loyalty_points: number }

export default function Loyalty() {
  const { businessId, business, role } = useAccount()
  const [rows, setRows] = useState<Member[] | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [adjusting, setAdjusting] = useState<Member | null>(null)
  const value = Number(business.loyalty_point_value || 0)

  const load = useCallback(async () => {
    let query = supabase.from('customer_balances').select('id,name,phone,loyalty_points').eq('business_id', businessId).eq('active', true)
      .order('loyalty_points', { ascending: false }).limit(300)
    const term = search.trim().replace(/[%,()]/g, '')
    if (term) query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%`)
    else query = query.gt('loyalty_points', 0)
    const { data, error: loadError } = await query
    if (loadError) setError(friendlyError(loadError)); else setRows((data as Member[]).map(r => ({ ...r, loyalty_points: Number(r.loyalty_points) })))
  }, [businessId, search])
  useEffect(() => { const t = window.setTimeout(load, search ? 300 : 0); return () => window.clearTimeout(t) }, [load, search])

  const totalPoints = (rows || []).reduce((s, r) => s + r.loyalty_points, 0)
  return <>
    <PageHeader title="Loyalty points" subtitle={business.loyalty_enabled
      ? `Customers earn 1 point for every ${money(business.loyalty_spend_per_point)} spent. Each point is worth ${money(value)} off a future purchase.`
      : 'The loyalty programme is switched off.'} actions={can(role, 'settings') ? <Link className="button secondary" to="/app/settings">Programme settings</Link> : undefined} />
    {!business.loyalty_enabled && <div className="notice info" style={{ marginBottom: 16 }}>Switch on the programme in Settings. Points are then earned automatically whenever a sale is linked to a customer, and can be redeemed at the till.</div>}
    <ErrorNotice message={error} onRetry={load} />
    {!rows ? <Loading /> : <>
      <div className="stat-grid"><Stat label={search ? 'Points (shown customers)' : 'Points held by customers'} value={totalPoints.toLocaleString('en-KE')} /><Stat label="Value if redeemed" value={money(totalPoints * value)} /></div>
      <div className="toolbar"><input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search any customer by name or phone" aria-label="Search customers" /></div>
      {rows.length === 0 ? <Empty title={search ? 'No customers match' : 'No customer has points yet'}><p>Points are earned when a sale is linked to a customer at the till.</p></Empty> :
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Customer</th><th>Phone</th><th className="num">Points</th><th className="num">Value</th><th aria-label="Actions" /></tr></thead>
          <tbody>{rows.map(r => <tr key={r.id}>
            <td data-label="Customer"><strong>{r.name}</strong></td><td data-label="Phone">{r.phone || '-'}</td>
            <td data-label="Points" className="num">{r.loyalty_points.toLocaleString('en-KE')}</td><td data-label="Value" className="num">{money(r.loyalty_points * value)}</td>
            <td className="row-actions">{can(role, 'adjustLoyalty') && <button type="button" onClick={() => setAdjusting(r)}>Adjust</button>}</td>
          </tr>)}</tbody>
        </table></div>}
    </>}
    {adjusting && <Adjust member={adjusting} onClose={() => setAdjusting(null)} onDone={() => { setAdjusting(null); load() }} />}
  </>
}

function Adjust({ member, onClose, onDone }: { member: Member; onClose: () => void; onDone: () => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const points = Math.trunc(Number(form.get('points'))) * (form.get('direction') === 'remove' ? -1 : 1)
    const { error: rpcError } = await supabase.rpc('adjust_loyalty_points', { target_business_id: businessId, target_customer_id: member.id, points_change: points, adjustment_note: String(form.get('note') || '') || null })
    setBusy(false)
    if (rpcError) setError(friendlyError(rpcError)); else onDone()
  }
  return <Modal title={`Adjust points: ${member.name}`} onClose={onClose}>
    <form onSubmit={submit}>
      <p className="hint">Current balance: <strong>{member.loyalty_points} points</strong>.</p>
      <div className="form-pair"><label>Action<select name="direction"><option value="add">Add points</option><option value="remove">Remove points</option></select></label>
        <label>Points<input name="points" type="number" min="1" step="1" required autoFocus /></label></div>
      <label>Reason<input name="note" maxLength={300} required placeholder="For example: welcome bonus" /></label>
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Saving' : 'Save'}</button>
    </form>
  </Modal>
}
