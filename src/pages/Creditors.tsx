import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { dateOnly, friendlyError, money, paymentLabel } from '../lib/format'
import { Empty, ErrorNotice, Loading, Modal, PageHeader, Stat, StatusBadge } from '../components/ui'

type Creditor = { id: string; name: string; phone: string | null; description: string | null; amount: number; due_date: string | null; created_at: string; paid: number; balance: number }
type Payment = { id: string; amount: number; method: string; note: string | null; paid_on: string }

export default function Creditors() {
  const { businessId } = useAccount()
  const [rows, setRows] = useState<Creditor[] | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [open, setOpen] = useState<Creditor | null>(null)
  const [showPaid, setShowPaid] = useState(false)

  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase.from('creditor_balances').select('id,name,phone,description,amount,due_date,created_at,paid,balance')
      .eq('business_id', businessId).order('created_at', { ascending: false }).limit(500)
    if (loadError) setError(friendlyError(loadError))
    else setRows((data as Creditor[]).map(r => ({ ...r, amount: Number(r.amount), paid: Number(r.paid), balance: Number(r.balance) })))
  }, [businessId])
  useEffect(() => { load() }, [load])

  const shown = (rows || []).filter(r => showPaid || r.balance > 0)
  const owed = (rows || []).reduce((s, r) => s + r.balance, 0)
  const paid = (rows || []).reduce((s, r) => s + r.paid, 0)
  const today = new Date().toISOString().slice(0, 10)

  return <>
    <PageHeader title="Creditors" subtitle="Loans and other money the business owes (supplier invoices are under Purchases)" actions={<button type="button" className="button" onClick={() => setAdding(true)}>Add creditor</button>} />
    <ErrorNotice message={error} onRetry={load} />
    {!rows ? <Loading /> : <>
      <div className="stat-grid"><Stat label="Total owed" value={money(owed)} tone={owed > 0 ? 'warning' : undefined} /><Stat label="Paid so far" value={money(paid)} /></div>
      <div className="toolbar"><label className="check"><input type="checkbox" checked={showPaid} onChange={e => setShowPaid(e.target.checked)} /> Include fully paid</label></div>
      {shown.length === 0 ? <Empty title="No outstanding creditors" /> :
        <div className="table-wrap"><table className="data-table clickable">
          <thead><tr><th>Creditor</th><th>Description</th><th className="num">Owed</th><th className="num">Paid</th><th className="num">Balance</th><th>Due</th></tr></thead>
          <tbody>{shown.map(r => <tr key={r.id} onClick={() => setOpen(r)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setOpen(r) }}>
            <td data-label="Creditor"><strong>{r.name}</strong><small>{r.phone || ''}</small></td>
            <td data-label="Description">{r.description || '-'}</td>
            <td data-label="Owed" className="num">{money(r.amount)}</td>
            <td data-label="Paid" className="num">{money(r.paid)}</td>
            <td data-label="Balance" className={`num ${r.balance > 0 ? 'neg' : ''}`}>{money(r.balance)}</td>
            <td data-label="Due">{r.balance <= 0 ? <StatusBadge status="paid" /> : r.due_date ? <>{dateOnly(r.due_date)}{r.due_date < today && <span className="badge critical">Overdue</span>}</> : '-'}</td>
          </tr>)}</tbody>
        </table></div>}
    </>}
    {adding && <CreditorForm onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load() }} />}
    {open && <CreditorDetail creditor={open} onClose={() => setOpen(null)} onChanged={() => { setOpen(null); load() }} />}
  </>
}

function CreditorForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const text = (k: string) => String(form.get(k) || '').trim() || null
    const { error: saveError } = await supabase.from('creditors').insert({ business_id: businessId, name: String(text('name')), phone: text('phone'), description: text('description'), amount: Number(form.get('amount')), due_date: text('due') })
    setBusy(false)
    if (saveError) setError(friendlyError(saveError)); else onSaved()
  }
  return <Modal title="Add creditor" onClose={onClose}>
    <form onSubmit={submit}>
      <label>Name<input name="name" required maxLength={120} autoFocus placeholder="For example: landlord, bank, a lender" /></label>
      <div className="form-pair"><label>Amount owed (KSh)<input name="amount" type="number" min="0.01" step="0.01" required /></label><label>Due date<input name="due" type="date" /></label></div>
      <label>Phone<input name="phone" type="tel" maxLength={30} /></label>
      <label>Description<input name="description" maxLength={300} /></label>
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Saving' : 'Save'}</button>
    </form>
  </Modal>
}

function CreditorDetail({ creditor, onClose, onChanged }: { creditor: Creditor; onClose: () => void; onChanged: () => void }) {
  const { businessId } = useAccount()
  const [payments, setPayments] = useState<Payment[] | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    supabase.from('creditor_payments').select('id,amount,method,note,paid_on').eq('business_id', businessId).eq('creditor_id', creditor.id).order('paid_on', { ascending: false })
      .then(({ data, error: loadError }) => { if (loadError) setError(friendlyError(loadError)); else setPayments(data as Payment[]) })
  }, [businessId, creditor.id])
  async function pay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const { error: payError } = await supabase.rpc('record_creditor_payment', { target_business_id: businessId, target_creditor_id: creditor.id, payment_amount: Number(form.get('amount')), method: String(form.get('method')), payment_note: String(form.get('note') || '') || null })
    setBusy(false)
    if (payError) setError(friendlyError(payError)); else onChanged()
  }
  return <Modal title={creditor.name} onClose={onClose} wide>
    <div className="detail-grid">
      <div><span>Owed</span><strong>{money(creditor.amount)}</strong></div><div><span>Paid</span><strong>{money(creditor.paid)}</strong></div>
      <div><span>Balance</span><strong className={creditor.balance > 0 ? 'neg' : ''}>{money(creditor.balance)}</strong></div>
      <div><span>Due</span><strong>{creditor.due_date ? dateOnly(creditor.due_date) : 'Not set'}</strong></div>
      {creditor.description && <div className="span-all"><span>Description</span><strong>{creditor.description}</strong></div>}
    </div>
    <ErrorNotice message={error} />
    {creditor.balance > 0 && <form className="inline-form" onSubmit={pay}><h3>Record a payment</h3>
      <div className="form-row"><label>Amount<input name="amount" type="number" min="0.01" max={creditor.balance} step="0.01" defaultValue={creditor.balance} required /></label>
        <label>Method<select name="method" defaultValue="mpesa"><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="other">Other</option></select></label>
        <label>Note<input name="note" maxLength={300} /></label><button className="button" disabled={busy}>{busy ? 'Saving' : 'Record payment'}</button></div></form>}
    <h3>Payments</h3>
    {!payments ? <Loading /> : payments.length === 0 ? <p className="muted">No payments yet.</p> :
      <table className="data-table compact"><thead><tr><th>Date</th><th>Method</th><th>Note</th><th className="num">Amount</th></tr></thead>
        <tbody>{payments.map(p => <tr key={p.id}><td data-label="Date">{dateOnly(p.paid_on)}</td><td data-label="Method">{paymentLabel(p.method)}</td><td data-label="Note">{p.note || '-'}</td><td data-label="Amount" className="num">{money(p.amount)}</td></tr>)}</tbody></table>}
  </Modal>
}
