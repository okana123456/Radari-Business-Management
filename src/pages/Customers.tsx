import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { dateTime, downloadCsv, friendlyError, money, paymentLabel, titleCase } from '../lib/format'
import { Empty, ErrorNotice, Loading, Modal, PageHeader, Stat } from '../components/ui'

type Customer = { id: string; name: string; phone: string | null; email: string | null; notes: string | null; credit_limit: number; active: boolean; balance: number; last_activity_at: string | null }
type Entry = { id: string; entry_type: string; amount: number; payment_method: string | null; note: string | null; created_at: string; created_by: string | null }

export default function Customers() {
  const { businessId } = useAccount()
  const [rows, setRows] = useState<Customer[] | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [owingOnly, setOwingOnly] = useState(false)
  const [open, setOpen] = useState<Customer | null>(null)
  const [editing, setEditing] = useState<Customer | 'new' | null>(null)

  const load = useCallback(async () => {
    setError('')
    let query = supabase.from('customer_balances').select('id,name,phone,email,notes,credit_limit,active,balance,last_activity_at')
      .eq('business_id', businessId).order('name').limit(300)
    const term = search.trim().replace(/[%,()]/g, '')
    if (term) query = query.or(`name.ilike.%${term}%,phone.ilike.%${term}%`)
    if (owingOnly) query = query.gt('balance', 0)
    const { data, error: loadError } = await query
    if (loadError) setError(friendlyError(loadError))
    else setRows((data || []).map(c => ({ ...c, balance: Number(c.balance), credit_limit: Number(c.credit_limit) })) as Customer[])
  }, [businessId, search, owingOnly])
  useEffect(() => { const timer = window.setTimeout(load, search ? 300 : 0); return () => window.clearTimeout(timer) }, [load, search])

  const owed = (rows || []).reduce((sum, c) => sum + Math.max(0, c.balance), 0)
  const debtors = (rows || []).filter(c => c.balance > 0).length

  return <>
    <PageHeader title="Customers" subtitle="Customer details and credit (debts)" actions={<>
      <button type="button" className="button secondary" disabled={!rows?.length} onClick={() => downloadCsv('radari-customers.csv', [['Name', 'Phone', 'Email', 'Credit limit', 'Balance owed', 'Active'], ...(rows || []).map(c => [c.name, c.phone, c.email, c.credit_limit, c.balance, c.active ? 'yes' : 'no'])])}>Export CSV</button>
      <button type="button" className="button" onClick={() => setEditing('new')}>+ New customer</button>
    </>} />
    {rows && <div className="stat-grid">
      <Stat label={search || owingOnly ? 'Owed (shown customers)' : 'Total owed to you'} value={money(owed)} tone={owed ? 'warning' : undefined} />
      <Stat label="Customers with a balance" value={debtors} />
    </div>}
    <div className="toolbar">
      <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name or phone" aria-label="Search customers" />
      <label className="check"><input type="checkbox" checked={owingOnly} onChange={e => setOwingOnly(e.target.checked)} /> Only customers who owe</label>
    </div>
    <ErrorNotice message={error} onRetry={load} />
    {!rows && !error ? <Loading /> : rows && rows.length === 0 ? <Empty title={search || owingOnly ? 'No customers match' : 'No customers yet'}>
      <p>Customers are added here or at the till when selling on credit.</p></Empty> : rows &&
      <div className="table-wrap"><table className="data-table clickable">
        <thead><tr><th>Customer</th><th>Phone</th><th className="num">Credit limit</th><th className="num">Balance</th><th>Last activity</th></tr></thead>
        <tbody>{rows.map(c => <tr key={c.id} onClick={() => setOpen(c)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setOpen(c) }} className={c.active ? '' : 'row-muted'}>
          <td data-label="Customer"><strong>{c.name}</strong>{!c.active && <small>Archived</small>}</td>
          <td data-label="Phone">{c.phone || '—'}</td>
          <td data-label="Credit limit" className="num">{c.credit_limit ? money(c.credit_limit) : 'No limit'}</td>
          <td data-label="Balance" className={`num ${c.balance > 0 ? 'neg' : ''}`}>{c.balance > 0 ? money(c.balance) : c.balance < 0 ? `${money(-c.balance)} credit` : '—'}</td>
          <td data-label="Last activity">{c.last_activity_at ? dateTime(c.last_activity_at) : '—'}</td>
        </tr>)}</tbody>
      </table></div>}
    {rows?.length === 300 && <p className="hint">Showing the first 300 customers. Search to find others.</p>}
    {open && <CustomerDetail customer={open} onClose={() => setOpen(null)} onChanged={() => { load() }} onEdit={() => { setEditing(open); setOpen(null) }} />}
    {editing && <CustomerForm customer={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load() }} />}
  </>
}

function CustomerForm({ customer, onClose, onSaved }: { customer: Customer | null; onClose: () => void; onSaved: () => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const text = (key: string) => String(form.get(key) || '').trim() || null
    const fields = { name: String(text('name')), phone: text('phone'), email: text('email'), notes: text('notes'), credit_limit: Number(form.get('limit') || 0) }
    const { error: saveError } = customer
      ? await supabase.from('customers').update({ ...fields, active: form.get('active') === 'on' }).eq('id', customer.id).eq('business_id', businessId)
      : await supabase.from('customers').insert({ ...fields, business_id: businessId })
    setBusy(false)
    if (saveError) setError(friendlyError(saveError)); else onSaved()
  }
  return <Modal title={customer ? `Edit ${customer.name}` : 'New customer'} onClose={onClose}>
    <form onSubmit={submit}>
      <label>Name<input name="name" required maxLength={120} defaultValue={customer?.name} autoFocus /></label>
      <div className="form-pair">
        <label>Phone<input name="phone" type="tel" maxLength={30} defaultValue={customer?.phone || ''} /></label>
        <label>Email<input name="email" type="email" maxLength={120} defaultValue={customer?.email || ''} /></label>
      </div>
      <label>Credit limit in KSh (0 = no limit)<input name="limit" type="number" min="0" step="1" defaultValue={customer?.credit_limit ?? 0} /></label>
      <label>Notes<input name="notes" maxLength={500} defaultValue={customer?.notes || ''} /></label>
      {customer && <label className="check"><input type="checkbox" name="active" defaultChecked={customer.active} /> Active</label>}
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Saving…' : 'Save customer'}</button>
    </form>
  </Modal>
}

function CustomerDetail({ customer, onClose, onChanged, onEdit }: { customer: Customer; onClose: () => void; onChanged: () => void; onEdit: () => void }) {
  const { businessId, staffName } = useAccount()
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [balance, setBalance] = useState(customer.balance)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase.from('customer_ledger').select('id,entry_type,amount,payment_method,note,created_at,created_by')
      .eq('business_id', businessId).eq('customer_id', customer.id).order('created_at', { ascending: false }).limit(100)
    if (loadError) setError(friendlyError(loadError)); else setEntries(data as Entry[])
  }, [businessId, customer.id])
  useEffect(() => { load() }, [load])

  async function pay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const { data, error: payError } = await supabase.rpc('record_customer_payment', {
      target_business_id: businessId, target_customer_id: customer.id, payment_amount: Number(form.get('amount')),
      method: String(form.get('method')), payment_note: String(form.get('note') || '') || null,
    })
    setBusy(false)
    if (payError) { setError(friendlyError(payError)); return }
    setBalance(Number(data)); formElement.reset(); load(); onChanged()
  }

  return <Modal title={customer.name} onClose={onClose} wide>
    <div className="detail-grid">
      <div><span>Phone</span><strong>{customer.phone || '—'}</strong></div>
      <div><span>Credit limit</span><strong>{customer.credit_limit ? money(customer.credit_limit) : 'No limit'}</strong></div>
      <div><span>Balance owed</span><strong className={balance > 0 ? 'neg' : ''}>{money(Math.max(0, balance))}{balance < 0 ? ` (customer has ${money(-balance)} credit)` : ''}</strong></div>
    </div>
    {customer.notes && <p className="hint">{customer.notes}</p>}
    <ErrorNotice message={error} />
    {balance > 0 && <form className="inline-form" onSubmit={pay}>
      <h3>Receive payment</h3>
      <div className="form-row">
        <label>Amount<input name="amount" type="number" min="0.01" max={balance} step="0.01" required defaultValue={balance} /></label>
        <label>Method<select name="method" defaultValue="mpesa"><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="other">Other</option></select></label>
        <label>Note / code<input name="note" maxLength={300} /></label>
        <button className="button" disabled={busy}>{busy ? 'Saving…' : 'Record payment'}</button>
      </div>
    </form>}
    <h3>Account history</h3>
    {!entries && !error ? <Loading /> : entries && entries.length === 0 ? <p className="muted">No credit sales or payments yet.</p> : entries &&
      <table className="data-table compact"><thead><tr><th>Date</th><th>Entry</th><th className="num">Amount</th><th>By</th></tr></thead>
        <tbody>{entries.map(e => <tr key={e.id}>
          <td data-label="Date">{dateTime(e.created_at)}</td>
          <td data-label="Entry">{titleCase(e.entry_type)}{e.payment_method ? ` · ${paymentLabel(e.payment_method)}` : ''}{e.note && <small>{e.note}</small>}</td>
          <td data-label="Amount" className={`num ${Number(e.amount) > 0 ? 'neg' : 'pos'}`}>{Number(e.amount) > 0 ? '+' : '−'}{money(Math.abs(Number(e.amount)))}</td>
          <td data-label="By">{e.created_by ? staffName(e.created_by) : '—'}</td>
        </tr>)}</tbody></table>}
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onEdit}>Edit customer</button></div>
  </Modal>
}
