import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { money } from '../lib/format'
import { Empty, ErrorNotice, Loading, PageHeader, Stat } from '../components/ui'
import { Supplier, SupplierForm, useSuppliers } from './Purchases'

export default function Suppliers() {
  const { businessId, role } = useAccount()
  const { suppliers, error, reload } = useSuppliers()
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null)
  const [balances, setBalances] = useState<Map<string, { total: number; owed: number }>>(new Map())

  const loadBalances = useCallback(async () => {
    const { data } = await supabase.from('purchases').select('supplier_id,total,amount_paid').eq('business_id', businessId).not('supplier_id', 'is', null).limit(5000)
    const map = new Map<string, { total: number; owed: number }>()
    for (const row of data || []) {
      const entry = map.get(row.supplier_id as string) || { total: 0, owed: 0 }
      entry.total += Number(row.total); entry.owed += Number(row.total) - Number(row.amount_paid)
      map.set(row.supplier_id as string, entry)
    }
    setBalances(map)
  }, [businessId])
  useEffect(() => { loadBalances() }, [loadBalances])

  const owed = [...balances.values()].reduce((s, b) => s + b.owed, 0)
  return <>
    <PageHeader title="Suppliers" subtitle="Who you buy from and what you owe them" actions={<>
      {can(role, 'recordPurchase') && <Link className="button secondary" to="/app/purchases?new=1">New purchase</Link>}
      <button type="button" className="button" onClick={() => setEditing('new')}>Add supplier</button>
    </>} />
    <ErrorNotice message={error} onRetry={reload} />
    {!suppliers ? <Loading /> : <>
      <div className="stat-grid"><Stat label="Suppliers" value={suppliers.filter(s => s.active).length} /><Stat label="Owed to suppliers" value={money(owed)} tone={owed > 0 ? 'warning' : undefined} /></div>
      {suppliers.length === 0 ? <Empty title="No suppliers yet"><button type="button" className="button" onClick={() => setEditing('new')}>Add a supplier</button></Empty> :
        <div className="table-wrap"><table className="data-table clickable">
          <thead><tr><th>Supplier</th><th>Contact</th><th>Phone</th><th className="num">Total bought</th><th className="num">Owed</th></tr></thead>
          <tbody>{suppliers.map(s => { const b = balances.get(s.id); return <tr key={s.id} onClick={() => setEditing(s)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setEditing(s) }} className={s.active ? '' : 'row-muted'}>
            <td data-label="Supplier"><strong>{s.name}</strong>{!s.active && <small>Archived</small>}</td>
            <td data-label="Contact">{s.contact_person || '-'}</td><td data-label="Phone">{s.phone || '-'}</td>
            <td data-label="Total bought" className="num">{money(b?.total || 0)}</td>
            <td data-label="Owed" className={`num ${b && b.owed > 0 ? 'neg' : ''}`}>{money(b?.owed || 0)}</td>
          </tr> })}</tbody>
        </table></div>}
    </>}
    {editing && <SupplierForm supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload() }} />}
  </>
}
