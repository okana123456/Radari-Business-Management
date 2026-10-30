import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { dateOnly, dateTime, downloadCsv, friendlyError, money, presetRange, rangeToTimestamps } from '../lib/format'
import { Empty, ErrorNotice, Loading, Modal, PageHeader, Stat, StatusBadge } from '../components/ui'

type CreditSale = { sale_id: string; receipt_number: string; sold_at: string; customer_id: string; customer_name: string; customer_phone: string | null; items: string; credit_amount: number; paid: number; balance: number; due_date: string | null; status: string }

export default function Credit() {
  const { businessId } = useAccount()
  const [rows, setRows] = useState<CreditSale[] | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('open')
  const [period, setPeriod] = useState('all')
  const [paying, setPaying] = useState<CreditSale | null>(null)

  const load = useCallback(async () => {
    setError('')
    const { data, error: loadError } = await supabase.rpc('credit_sales_status', { target_business_id: businessId })
    if (loadError) setError(friendlyError(loadError))
    else setRows((data as CreditSale[]).map(r => ({ ...r, credit_amount: Number(r.credit_amount), paid: Number(r.paid), balance: Number(r.balance) })))
  }, [businessId])
  useEffect(() => { load() }, [load])

  const term = search.trim().toLowerCase()
  const bounds = period === 'all' ? null : rangeToTimestamps(presetRange(period))
  const shown = (rows || []).filter(r =>
    (status === 'all' || (status === 'open' ? r.status !== 'paid' : r.status === status))
    && (!term || r.customer_name.toLowerCase().includes(term) || (r.customer_phone || '').includes(term) || r.receipt_number.toLowerCase().includes(term))
    && (!bounds || (r.sold_at >= bounds.start && r.sold_at < bounds.end)))
  const outstanding = (rows || []).reduce((s, r) => s + r.balance, 0)
  const collected = (rows || []).reduce((s, r) => s + r.paid, 0)
  const overdue = (rows || []).filter(r => r.status === 'overdue')

  return <>
    <PageHeader title="Credit sales" subtitle="Goods sold on credit and what has been paid against each sale" actions={
      <button type="button" className="button secondary" disabled={!shown.length} onClick={() => downloadCsv('radari-credit-sales.csv', [['Receipt', 'Date', 'Customer', 'Phone', 'Items', 'Credit', 'Paid', 'Balance', 'Due', 'Status'], ...shown.map(r => [r.receipt_number, dateOnly(r.sold_at), r.customer_name, r.customer_phone, r.items, r.credit_amount, r.paid, r.balance, r.due_date, r.status])])}>Export</button>} />
    <ErrorNotice message={error} onRetry={load} />
    {!rows ? <Loading /> : <>
      <div className="stat-grid">
        <Stat label="Outstanding" value={money(outstanding)} tone={outstanding > 0 ? 'warning' : undefined} />
        <Stat label="Collected" value={money(collected)} />
        <Stat label="Overdue" value={money(overdue.reduce((s, r) => s + r.balance, 0))} tone={overdue.length ? 'critical' : undefined} hint={`${overdue.length} sale${overdue.length === 1 ? '' : 's'}`} />
      </div>
      <div className="toolbar">
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search customer, phone or receipt" aria-label="Search credit sales" />
        <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status"><option value="open">Unpaid</option><option value="overdue">Overdue</option><option value="pending">Pending</option><option value="paid">Fully paid</option><option value="all">All</option></select>
        <select value={period} onChange={e => setPeriod(e.target.value)} aria-label="Period"><option value="all">Any date</option><option value="today">Today</option><option value="week">This week</option><option value="month">This month</option><option value="30days">Last 30 days</option></select>
      </div>
      {shown.length === 0 ? <Empty title="No credit sales match these filters" /> :
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Customer</th><th>Receipt</th><th>Items</th><th className="num">Credit</th><th className="num">Paid</th><th className="num">Balance</th><th>Due</th><th>Status</th><th aria-label="Actions" /></tr></thead>
          <tbody>{shown.map(r => <tr key={r.sale_id}>
            <td data-label="Customer"><strong>{r.customer_name}</strong><small>{r.customer_phone || ''}</small></td>
            <td data-label="Receipt">{r.receipt_number}<small>{dateTime(r.sold_at)}</small></td>
            <td data-label="Items">{r.items}</td>
            <td data-label="Credit" className="num">{money(r.credit_amount)}</td>
            <td data-label="Paid" className="num">{money(r.paid)}</td>
            <td data-label="Balance" className={`num ${r.balance > 0 ? 'neg' : ''}`}>{money(r.balance)}</td>
            <td data-label="Due">{r.due_date ? dateOnly(r.due_date) : '-'}</td>
            <td data-label="Status"><StatusBadge status={r.status} label={r.status === 'paid' ? 'Fully paid' : undefined} /></td>
            <td className="row-actions">{r.balance > 0 && <button type="button" onClick={() => setPaying(r)}>Receive payment</button>}</td>
          </tr>)}</tbody>
        </table></div>}
      <p className="hint">Payments are recorded against the customer and applied to their oldest credit sale first.</p>
    </>}
    {paying && <ReceivePayment sale={paying} onClose={() => setPaying(null)} onDone={() => { setPaying(null); load() }} />}
  </>
}

function ReceivePayment({ sale, onClose, onDone }: { sale: CreditSale; onClose: () => void; onDone: () => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const { error: payError } = await supabase.rpc('record_customer_payment', {
      target_business_id: businessId, target_customer_id: sale.customer_id, payment_amount: Number(form.get('amount')),
      method: String(form.get('method')), payment_note: String(form.get('note') || '') || `Payment for ${sale.receipt_number}`,
    })
    setBusy(false)
    if (payError) setError(friendlyError(payError)); else onDone()
  }
  return <Modal title={`Receive payment from ${sale.customer_name}`} onClose={onClose}>
    <form onSubmit={submit}>
      <p className="hint">Receipt {sale.receipt_number}: {money(sale.balance)} outstanding.</p>
      <div className="form-pair">
        <label>Amount<input name="amount" type="number" min="0.01" step="0.01" required defaultValue={sale.balance} autoFocus /></label>
        <label>Method<select name="method" defaultValue="mpesa"><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="other">Other</option></select></label>
      </div>
      <label>Note or M-Pesa code<input name="note" maxLength={300} /></label>
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Saving' : 'Record payment'}</button>
    </form>
  </Modal>
}
