import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { businessToday, dateOnly, DateRange, downloadCsv, friendlyError, money, presetRange, qty } from '../lib/format'
import { DateRangePicker, Empty, ErrorNotice, Loading, Modal, PageHeader, Stat } from '../components/ui'

export type Supplier = { id: string; name: string; contact_person: string | null; phone: string | null; email: string | null; notes: string | null; active: boolean }
type Purchase = { id: string; supplier_id: string | null; reference: string | null; total: number; items_total: number | null; amount_paid: number; purchased_on: string; notes: string | null; created_by: string | null }
type PurchaseItem = { id: string; product_name: string; quantity: number; unit_cost: number; line_total: number; batch_number: string | null; expiry_date: string | null }

export function useSuppliers() {
  const { businessId } = useAccount()
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    const { data, error: loadError } = await supabase.from('suppliers').select('id,name,contact_person,phone,email,notes,active').eq('business_id', businessId).order('name').limit(500)
    if (loadError) setError(friendlyError(loadError)); else setSuppliers(data as Supplier[])
  }, [businessId])
  useEffect(() => { load() }, [load])
  return { suppliers, error, reload: load }
}

export default function Purchases() {
  const { businessId, role } = useAccount()
  const [params, setParams] = useSearchParams()
  const [range, setRange] = useState<DateRange>(presetRange('30days'))
  const [unpaidOnly, setUnpaidOnly] = useState(false)
  const [rows, setRows] = useState<Purchase[] | null>(null)
  const [error, setError] = useState('')
  const [recording, setRecording] = useState(params.get('new') === '1')
  const [open, setOpen] = useState<Purchase | null>(null)
  const { suppliers } = useSuppliers()
  const names = useMemo(() => new Map((suppliers || []).map(s => [s.id, s.name])), [suppliers])

  const load = useCallback(async () => {
    setRows(null); setError('')
    let query = supabase.from('purchases').select('id,supplier_id,reference,total,items_total,amount_paid,purchased_on,notes,created_by')
      .eq('business_id', businessId).order('purchased_on', { ascending: false }).order('created_at', { ascending: false }).limit(500)
    if (!unpaidOnly) query = query.gte('purchased_on', range.from).lte('purchased_on', range.to)
    const { data, error: loadError } = await query
    if (loadError) { setError(friendlyError(loadError)); return }
    const list = (data as Purchase[]).map(p => ({ ...p, total: Number(p.total), amount_paid: Number(p.amount_paid) }))
    setRows(unpaidOnly ? list.filter(p => p.amount_paid < p.total) : list)
  }, [businessId, range, unpaidOnly])
  useEffect(() => { load() }, [load])

  const total = (rows || []).reduce((s, p) => s + p.total, 0)
  const owed = (rows || []).reduce((s, p) => s + p.total - p.amount_paid, 0)
  function close() { setRecording(false); if (params.get('new')) { params.delete('new'); setParams(params, { replace: true }) } }

  return <>
    <PageHeader title="Purchases" subtitle="Receive stock from suppliers" actions={<>
      <button type="button" className="button secondary" disabled={!rows?.length} onClick={() => downloadCsv('radari-purchases.csv', [['Date', 'Supplier', 'Reference', 'Total', 'Paid', 'Balance'], ...(rows || []).map(p => [p.purchased_on, p.supplier_id ? names.get(p.supplier_id) : '', p.reference, p.total, p.amount_paid, p.total - p.amount_paid])])}>Export</button>
      {can(role, 'recordPurchase') && <button type="button" className="button" onClick={() => setRecording(true)}>New purchase</button>}
    </>} />
    {!unpaidOnly && <DateRangePicker value={range} onChange={setRange} />}
    <div className="toolbar"><label className="check"><input type="checkbox" checked={unpaidOnly} onChange={e => setUnpaidOnly(e.target.checked)} /> Show all unpaid purchases</label></div>
    <ErrorNotice message={error} onRetry={load} />
    {!rows ? <Loading /> : <>
      <div className="stat-grid">
        <Stat label="Purchases" value={money(total)} hint={`${rows.length} invoice${rows.length === 1 ? '' : 's'}`} />
        <Stat label="Still owed" value={money(owed)} tone={owed > 0 ? 'warning' : undefined} />
      </div>
      {rows.length === 0 ? <Empty title={unpaidOnly ? 'Nothing is owed to suppliers' : 'No purchases in this period'}><p>Record deliveries here. Stock goes up and cost prices update automatically.</p></Empty> :
        <div className="table-wrap"><table className="data-table clickable">
          <thead><tr><th>Date</th><th>Supplier</th><th>Reference</th><th className="num">Total</th><th className="num">Balance</th></tr></thead>
          <tbody>{rows.map(p => <tr key={p.id} onClick={() => setOpen(p)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setOpen(p) }}>
            <td data-label="Date">{dateOnly(p.purchased_on)}</td>
            <td data-label="Supplier">{p.supplier_id ? names.get(p.supplier_id) || 'Supplier' : 'No supplier'}</td>
            <td data-label="Reference">{p.reference || '-'}</td>
            <td data-label="Total" className="num">{money(p.total)}</td>
            <td data-label="Balance" className="num">{p.total - p.amount_paid > 0 ? <span className="badge warning">{money(p.total - p.amount_paid)}</span> : <span className="badge good">Paid</span>}</td>
          </tr>)}</tbody>
        </table></div>}
    </>}
    {recording && <PurchaseForm onClose={close} onSaved={() => { close(); load() }} />}
    {open && <PurchaseDetail purchase={open} supplierName={open.supplier_id ? names.get(open.supplier_id) : undefined} onClose={() => setOpen(null)} onPaid={() => { setOpen(null); load() }} />}
  </>
}

type Line = { key: number; productId: string; quantity: string; unitCost: string; batch: string; expiry: string; sellingPrice: string }
const emptyLine = (): Line => ({ key: Date.now() + Math.random(), productId: '', quantity: '', unitCost: '', batch: '', expiry: '', sellingPrice: '' })

export function PurchaseForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { businessId, products, reloadProducts } = useAccount()
  const { suppliers, reload: reloadSuppliers } = useSuppliers()
  const active = products.filter(p => p.active)
  const [lines, setLines] = useState<Line[]>([emptyLine()])
  const [paid, setPaid] = useState('')
  const [invoiceTotal, setInvoiceTotal] = useState('')
  const [newSupplier, setNewSupplier] = useState(false)
  const [supplierId, setSupplierId] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const itemsTotal = lines.reduce((sum, l) => sum + Math.round(Number(l.quantity || 0) * Number(l.unitCost || 0) * 100) / 100, 0)
  const total = invoiceTotal !== '' ? Number(invoiceTotal) : itemsTotal

  const update = (key: number, change: Partial<Line>) => setLines(current => current.map(l => {
    if (l.key !== key) return l
    const next = { ...l, ...change }
    if (change.productId) { const p = products.find(x => x.id === change.productId); if (p && !l.unitCost) next.unitCost = String(p.cost) }
    return next
  }))

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    const items = lines.filter(l => l.productId).map(l => ({
      product_id: l.productId, quantity: Number(l.quantity), unit_cost: Number(l.unitCost),
      batch_number: l.batch.trim() || null, expiry_date: l.expiry || null, selling_price: l.sellingPrice !== '' ? Number(l.sellingPrice) : null,
    }))
    if (!items.length) { setError('Add at least one product.'); return }
    if (items.some(i => !(i.quantity > 0) || !(i.unit_cost >= 0))) { setError('Every line needs a quantity and a cost.'); return }
    setBusy(true)
    const form = new FormData(event.currentTarget)
    const { error: saveError } = await supabase.rpc('record_purchase', {
      target_business_id: businessId, target_supplier_id: supplierId || null, items,
      purchase_reference: String(form.get('reference') || '') || null, paid_amount: paid === '' ? null : Number(paid),
      purchase_date: String(form.get('date')), purchase_notes: String(form.get('notes') || '') || null,
      invoice_total: invoiceTotal === '' ? null : Number(invoiceTotal),
    })
    setBusy(false)
    if (saveError) { setError(friendlyError(saveError)); return }
    reloadProducts(); onSaved()
  }

  return <Modal title="Receive stock" onClose={onClose} wide>
    <form onSubmit={submit}>
      <div className="form-row">
        <label>Supplier<select value={supplierId} onChange={e => setSupplierId(e.target.value)}><option value="">No supplier</option>{(suppliers || []).filter(s => s.active).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Invoice or reference<input name="reference" maxLength={60} placeholder="INV-2026-001" /></label>
        <label>Date<input name="date" type="date" required max={businessToday()} defaultValue={businessToday()} /></label>
      </div>
      <button type="button" className="link-button" style={{ justifySelf: 'start', margin: 0 }} onClick={() => setNewSupplier(true)}>Add a new supplier</button>
      <div className="line-items">
        <div className="line-head"><span>Product</span><span>Quantity</span><span>Cost each</span><span>Batch</span><span>Expiry</span><span>New price</span><span>Total</span><span /></div>
        {lines.map(line => <div className="line-item" key={line.key}>
          <select aria-label="Product" value={line.productId} onChange={e => update(line.key, { productId: e.target.value })}>
            <option value="">Choose product</option>{active.map(p => <option key={p.id} value={p.id}>{p.name} ({qty(p.stock)} in stock)</option>)}
          </select>
          <input aria-label="Quantity" placeholder="Qty" type="number" min="0.001" step="0.001" value={line.quantity} onChange={e => update(line.key, { quantity: e.target.value })} />
          <input aria-label="Cost each" placeholder="Cost" type="number" min="0" step="0.01" value={line.unitCost} onChange={e => update(line.key, { unitCost: e.target.value })} />
          <input aria-label="Batch" placeholder="Batch" maxLength={60} value={line.batch} onChange={e => update(line.key, { batch: e.target.value })} />
          <input aria-label="Expiry" type="date" value={line.expiry} onChange={e => update(line.key, { expiry: e.target.value })} />
          <input aria-label="New selling price" placeholder="Price" type="number" min="0" step="0.01" value={line.sellingPrice} onChange={e => update(line.key, { sellingPrice: e.target.value })} />
          <span className="num">{money(Number(line.quantity || 0) * Number(line.unitCost || 0))}</span>
          <button type="button" className="icon-button" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(current => current.filter(l => l.key !== line.key))}>Remove</button>
        </div>)}
        <button type="button" className="button secondary small" onClick={() => setLines(current => [...current, emptyLine()])}>Add line</button>
      </div>
      <p className="hint">Leave "New price" blank to keep the current selling price. Cost prices update to the weighted average automatically.</p>
      <div className="form-row">
        <div className="total-box"><span>Items total</span><strong>{money(itemsTotal)}</strong></div>
        <label>Invoice total (if different)<input type="number" min="0" step="0.01" value={invoiceTotal} placeholder={String(itemsTotal)} onChange={e => setInvoiceTotal(e.target.value)} /></label>
        <label>Amount paid now<input type="number" min="0" max={total} step="0.01" value={paid} placeholder={`${total} (paid in full)`} onChange={e => setPaid(e.target.value)} /></label>
      </div>
      <label>Notes<input name="notes" maxLength={500} /></label>
      <p className="hint">Leave "Amount paid" blank if paid in full. Enter 0 for goods taken on credit; the balance is tracked as owed to the supplier.</p>
      <ErrorNotice message={error} />
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button" disabled={busy}>{busy ? 'Saving' : 'Confirm and receive stock'}</button></div>
    </form>
    {newSupplier && <SupplierForm supplier={null} onClose={() => setNewSupplier(false)} onSaved={id => { setNewSupplier(false); reloadSuppliers(); if (id) setSupplierId(id) }} />}
  </Modal>
}

export function SupplierForm({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved: (id?: string) => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const text = (key: string) => String(form.get(key) || '').trim() || null
    const fields = { name: String(text('name')), contact_person: text('contact'), phone: text('phone'), email: text('email'), notes: text('notes') }
    if (supplier) {
      const { error: saveError } = await supabase.from('suppliers').update({ ...fields, active: form.get('active') === 'on' }).eq('id', supplier.id).eq('business_id', businessId)
      setBusy(false)
      if (saveError) setError(friendlyError(saveError)); else onSaved(supplier.id)
    } else {
      const { data, error: saveError } = await supabase.from('suppliers').insert({ ...fields, business_id: businessId }).select('id').single()
      setBusy(false)
      if (saveError) setError(friendlyError(saveError)); else onSaved(data.id)
    }
  }
  return <Modal title={supplier ? `Edit ${supplier.name}` : 'New supplier'} onClose={onClose}>
    <form onSubmit={submit}>
      <label>Supplier name<input name="name" required maxLength={120} defaultValue={supplier?.name} autoFocus /></label>
      <div className="form-pair">
        <label>Contact person<input name="contact" maxLength={120} defaultValue={supplier?.contact_person || ''} /></label>
        <label>Phone<input name="phone" type="tel" maxLength={30} defaultValue={supplier?.phone || ''} /></label>
      </div>
      <label>Email<input name="email" type="email" maxLength={120} defaultValue={supplier?.email || ''} /></label>
      <label>Notes<input name="notes" maxLength={500} defaultValue={supplier?.notes || ''} /></label>
      {supplier && <label className="check"><input type="checkbox" name="active" defaultChecked={supplier.active} /> Active</label>}
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Saving' : 'Save supplier'}</button>
    </form>
  </Modal>
}

function PurchaseDetail({ purchase, supplierName, onClose, onPaid }: { purchase: Purchase; supplierName?: string; onClose: () => void; onPaid: () => void }) {
  const { businessId, role, staffName } = useAccount()
  const [items, setItems] = useState<PurchaseItem[] | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const balance = purchase.total - purchase.amount_paid
  useEffect(() => {
    supabase.from('purchase_items').select('id,product_name,quantity,unit_cost,line_total,batch_number,expiry_date').eq('business_id', businessId).eq('purchase_id', purchase.id)
      .then(({ data, error: loadError }) => { if (loadError) setError(friendlyError(loadError)); else setItems(data as PurchaseItem[]) })
  }, [businessId, purchase.id])
  async function pay(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const amount = Number(new FormData(event.currentTarget).get('amount'))
    const { error: payError } = await supabase.rpc('record_purchase_payment', { target_business_id: businessId, target_purchase_id: purchase.id, payment_amount: amount })
    setBusy(false)
    if (payError) setError(friendlyError(payError)); else onPaid()
  }
  return <Modal title={`Purchase ${purchase.reference || dateOnly(purchase.purchased_on)}`} onClose={onClose} wide>
    <div className="detail-grid">
      <div><span>Supplier</span><strong>{supplierName || 'No supplier'}</strong></div>
      <div><span>Date</span><strong>{dateOnly(purchase.purchased_on)}</strong></div>
      <div><span>Invoice total</span><strong>{money(purchase.total)}</strong></div>
      {purchase.items_total !== null && Number(purchase.items_total) !== purchase.total && <div><span>Items total</span><strong>{money(purchase.items_total)}</strong></div>}
      <div><span>Paid</span><strong>{money(purchase.amount_paid)}</strong></div>
      <div><span>Balance</span><strong className={balance > 0 ? 'neg' : ''}>{money(balance)}</strong></div>
      {purchase.created_by && <div><span>Recorded by</span><strong>{staffName(purchase.created_by)}</strong></div>}
    </div>
    {purchase.notes && <p className="hint">{purchase.notes}</p>}
    <ErrorNotice message={error} />
    {!items && !error ? <Loading /> : items && <table className="data-table compact"><thead><tr><th>Product</th><th className="num">Quantity</th><th className="num">Cost each</th><th>Batch</th><th>Expiry</th><th className="num">Total</th></tr></thead>
      <tbody>{items.map(i => <tr key={i.id}><td data-label="Product">{i.product_name}</td><td data-label="Quantity" className="num">{qty(i.quantity)}</td><td data-label="Cost each" className="num">{money(i.unit_cost)}</td>
        <td data-label="Batch">{i.batch_number || '-'}</td><td data-label="Expiry">{i.expiry_date ? dateOnly(i.expiry_date) : '-'}</td><td data-label="Total" className="num">{money(i.line_total)}</td></tr>)}</tbody></table>}
    {balance > 0 && can(role, 'payPurchase') && <form className="inline-form" onSubmit={pay}>
      <h3>Record payment to supplier</h3>
      <div className="form-row"><label>Amount<input name="amount" type="number" min="0.01" max={balance} step="0.01" defaultValue={balance} required /></label>
        <button className="button" disabled={busy}>{busy ? 'Saving' : 'Record payment'}</button></div>
    </form>}
  </Modal>
}
