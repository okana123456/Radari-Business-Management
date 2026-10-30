import { FormEvent, useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { DateRange, dateTime, downloadCsv, friendlyError, money, paymentLabel, presetRange, qty, rangeToTimestamps } from '../lib/format'
import { DateRangePicker, Empty, ErrorNotice, Loading, Modal, PageHeader, Pager, StatusBadge } from '../components/ui'
import { ReceiptData, ReceiptView } from '../components/Receipt'

type Sale = {
  id: string; receipt_number: string; cashier_id: string; total: number; vat_amount: number; total_cost: number
  payment_method: string; payment_reference: string | null; customer_name: string | null; status: string
  sold_at: string; void_reason: string | null; voided_at: string | null; voided_by: string | null
  discount_total: number; loyalty_discount: number; loyalty_points_redeemed: number; credit_due_date: string | null
}
type SaleItem = { id: string; product_name: string; quantity: number; unit_price: number; line_total: number; vat_rate: number; list_price: number | null }
type SalePayment = { method: string; amount: number; reference: string | null }
const COLUMNS = 'id,receipt_number,cashier_id,total,vat_amount,total_cost,payment_method,payment_reference,customer_name,status,sold_at,void_reason,voided_at,voided_by,discount_total,loyalty_discount,loyalty_points_redeemed,credit_due_date'
const PAGE = 25

export default function Sales() {
  const { businessId, role, staffName, user } = useAccount()
  const [range, setRange] = useState<DateRange>(presetRange('today'))
  const [method, setMethod] = useState('all')
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<Sale[] | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Sale | null>(null)

  const load = useCallback(async () => {
    setRows(null); setError('')
    const { start, end } = rangeToTimestamps(range)
    let query = supabase.from('sales').select(COLUMNS).eq('business_id', businessId)
      .gte('sold_at', start).lt('sold_at', end).order('sold_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE)
    if (method !== 'all') query = query.eq('payment_method', method)
    if (status !== 'all') query = query.eq('status', status)
    const term = search.trim().replace(/[%,()]/g, '')
    if (term) query = query.or(`receipt_number.ilike.%${term}%,customer_name.ilike.%${term}%,payment_reference.ilike.%${term}%`)
    const { data, error: loadError } = await query
    if (loadError) setError(friendlyError(loadError)); else setRows(data as Sale[])
  }, [businessId, range, method, status, search, page])

  useEffect(() => { const timer = window.setTimeout(load, search ? 300 : 0); return () => window.clearTimeout(timer) }, [load, search])
  useEffect(() => { setPage(0) }, [range, method, status, search])

  const shown = rows?.slice(0, PAGE) || []
  const pageTotal = shown.filter(s => s.status === 'completed').reduce((sum, s) => sum + Number(s.total), 0)

  function exportCsv() {
    downloadCsv(`radari-sales-${range.from}-to-${range.to}-page${page + 1}.csv`, [
      ['Receipt', 'Date', 'Status', 'Payment', 'Reference', 'Customer', 'Cashier', 'Total', 'VAT'],
      ...shown.map(s => [s.receipt_number, dateTime(s.sold_at), s.status, paymentLabel(s.payment_method), s.payment_reference, s.customer_name, staffName(s.cashier_id), s.total, s.vat_amount]),
    ])
  }

  return <>
    <PageHeader title="Sales" subtitle={role === 'cashier' ? 'Sales you have made' : 'All sales and receipts'}
      actions={<button type="button" className="button secondary" onClick={exportCsv} disabled={!shown.length}>Export page</button>} />
    <DateRangePicker value={range} onChange={setRange} />
    <div className="toolbar">
      <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Receipt no., customer or M-Pesa code" aria-label="Search sales" />
      <select value={method} onChange={e => setMethod(e.target.value)} aria-label="Payment method"><option value="all">All payments</option><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="card">Card</option><option value="credit">Credit</option><option value="split">Split</option></select>
      <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status"><option value="all">All statuses</option><option value="completed">Completed</option><option value="voided">Voided</option></select>
    </div>
    <ErrorNotice message={error} onRetry={load} />
    {!rows && !error ? <Loading /> : rows && shown.length === 0 ? <Empty title="No sales in this period" /> : rows && <>
      <p className="hint">{shown.length} sale{shown.length === 1 ? '' : 's'} on this page · {money(pageTotal)} completed</p>
      <div className="table-wrap"><table className="data-table clickable">
        <thead><tr><th>Receipt</th><th>Date</th><th>Payment</th><th>Customer</th><th>Cashier</th><th className="num">Total</th><th>Status</th></tr></thead>
        <tbody>{shown.map(s => <tr key={s.id} onClick={() => setOpen(s)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setOpen(s) }}>
          <td data-label="Receipt"><strong>{s.receipt_number}</strong></td>
          <td data-label="Date">{dateTime(s.sold_at)}</td>
          <td data-label="Payment">{paymentLabel(s.payment_method)}{s.payment_reference && <small>{s.payment_reference}</small>}</td>
          <td data-label="Customer">{s.customer_name || '—'}</td>
          <td data-label="Cashier">{staffName(s.cashier_id)}</td>
          <td data-label="Total" className="num">{money(s.total)}</td>
          <td data-label="Status"><StatusBadge status={s.status} /></td>
        </tr>)}</tbody>
      </table></div>
      <Pager page={page} hasMore={rows.length > PAGE} onPage={setPage} />
    </>}
    {open && <SaleDetail sale={open} canVoid={can(role, 'voidSale') || (role === 'cashier' && open.cashier_id === user.id && Date.now() - new Date(open.sold_at).getTime() < 15 * 60 * 1000)} onClose={() => setOpen(null)} onVoided={() => { setOpen(null); load() }} />}
  </>
}

function SaleDetail({ sale, canVoid, onClose, onVoided }: { sale: Sale; canVoid: boolean; onClose: () => void; onVoided: () => void }) {
  const { businessId, business, staffName, reloadProducts } = useAccount()
  const [items, setItems] = useState<SaleItem[] | null>(null)
  const [payments, setPayments] = useState<SalePayment[]>([])
  const [error, setError] = useState('')
  const [printing, setPrinting] = useState(false)
  const [voiding, setVoiding] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.from('sale_items').select('id,product_name,quantity,unit_price,line_total,vat_rate,list_price')
      .eq('business_id', businessId).eq('sale_id', sale.id)
      .then(({ data, error: loadError }) => { if (loadError) setError(friendlyError(loadError)); else setItems(data as SaleItem[]) })
    supabase.from('sale_payments').select('method,amount,reference').eq('business_id', businessId).eq('sale_id', sale.id)
      .then(({ data }) => setPayments((data || []).map(p => ({ ...p, amount: Number(p.amount) })) as SalePayment[]))
  }, [businessId, sale.id])

  const receipt: ReceiptData | null = items && {
    number: sale.receipt_number, soldAt: sale.sold_at, payment: sale.payment_method, total: Number(sale.total), vat: Number(sale.vat_amount),
    items: items.map(i => ({ name: i.product_name, quantity: Number(i.quantity), unitPrice: Number(i.unit_price), lineTotal: Number(i.line_total), listPrice: i.list_price === null ? null : Number(i.list_price) })),
    payments, discount: Number(sale.discount_total || 0), loyaltyDiscount: Number(sale.loyalty_discount || 0), pointsRedeemed: sale.loyalty_points_redeemed, creditDueDate: sale.credit_due_date,
    cashier: staffName(sale.cashier_id), customer: sale.customer_name, paymentReference: sale.payment_reference, status: sale.status, voidReason: sale.void_reason,
  }

  async function voidSale(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const reason = String(new FormData(event.currentTarget).get('reason') || '')
    const { error: voidError } = await supabase.rpc('void_sale', { target_business_id: businessId, target_sale_id: sale.id, void_reason: reason })
    setBusy(false)
    if (voidError) { setError(friendlyError(voidError)); return }
    reloadProducts()
    onVoided()
  }

  if (printing && receipt) return <ReceiptView business={business} receipt={receipt} reprint onClose={() => setPrinting(false)} />

  return <Modal title={`Receipt ${sale.receipt_number}`} onClose={onClose} wide>
    <div className="detail-grid">
      <div><span>Date</span><strong>{dateTime(sale.sold_at)}</strong></div>
      <div><span>Status</span><StatusBadge status={sale.status} /></div>
      <div><span>Payment</span><strong>{payments.length > 1 ? payments.map(p => `${paymentLabel(p.method)} ${money(p.amount)}`).join(', ') : `${paymentLabel(sale.payment_method)}${sale.payment_reference ? ` · ${sale.payment_reference}` : ''}`}</strong></div>
      {Number(sale.discount_total) > 0 && <div><span>Discounts</span><strong>{money(sale.discount_total)}</strong></div>}
      {Number(sale.loyalty_discount) > 0 && <div><span>Points redeemed</span><strong>{sale.loyalty_points_redeemed} ({money(sale.loyalty_discount)})</strong></div>}
      {sale.credit_due_date && <div><span>Credit due</span><strong>{sale.credit_due_date}</strong></div>}
      <div><span>Cashier</span><strong>{staffName(sale.cashier_id)}</strong></div>
      {sale.customer_name && <div><span>Customer</span><strong>{sale.customer_name}</strong></div>}
      <div><span>Total</span><strong>{money(sale.total)}</strong></div>
      {sale.vat_amount > 0 && <div><span>VAT included</span><strong>{money(sale.vat_amount)}</strong></div>}
      {sale.status === 'voided' && <div className="span-all"><span>Voided</span><strong>{sale.voided_at && dateTime(sale.voided_at)}{sale.voided_by ? ` by ${staffName(sale.voided_by)}` : ''} — {sale.void_reason}</strong></div>}
    </div>
    <ErrorNotice message={error} />
    {!items && !error ? <Loading /> : items && <table className="data-table compact">
      <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Total</th></tr></thead>
      <tbody>{items.map(i => <tr key={i.id}><td data-label="Item">{i.product_name}</td><td data-label="Qty" className="num">{qty(i.quantity)}</td><td data-label="Price" className="num">{money(i.unit_price)}</td><td data-label="Total" className="num">{money(i.line_total)}</td></tr>)}</tbody>
    </table>}
    <div className="modal-actions">
      <button type="button" className="button" disabled={!receipt} onClick={() => setPrinting(true)}>Reprint receipt</button>
      {canVoid && sale.status === 'completed' && !voiding && <button type="button" className="button danger" onClick={() => setVoiding(true)}>Void sale</button>}
    </div>
    {voiding && <form className="danger-zone" onSubmit={voidSale}>
      <p><strong>Void this sale?</strong> Stock goes back on the shelf, credit owed is cancelled and loyalty points are reversed. If cash or M-Pesa was received, refund the customer separately. This cannot be undone.</p>
      <label>Reason<input name="reason" required minLength={3} maxLength={300} placeholder="e.g. Customer returned goods" autoFocus /></label>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={() => setVoiding(false)}>Cancel</button><button className="button danger" disabled={busy}>{busy ? 'Voiding' : 'Confirm void'}</button></div>
    </form>}
  </Modal>
}
