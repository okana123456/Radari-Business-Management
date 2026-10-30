import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { dateOnly, friendlyError, isoDay, money, qty } from '../lib/format'
import { Empty, ErrorNotice, Loading, Modal, PageHeader, Pager, Stat } from '../components/ui'

type Supplier = { id: string; name: string; contact_person: string | null; phone: string | null; email: string | null; notes: string | null; active: boolean }
type Purchase = { id: string; supplier_id: string | null; reference: string | null; total: number; amount_paid: number; purchased_on: string; notes: string | null; created_by: string | null }
type PurchaseItem = { id: string; product_name: string; quantity: number; unit_cost: number; line_total: number }
const PAGE = 25

export default function Suppliers() {
  const { businessId, role } = useAccount()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<'purchases' | 'suppliers'>('purchases')
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null)
  const [purchases, setPurchases] = useState<Purchase[] | null>(null)
  const [unpaidOnly, setUnpaidOnly] = useState(false)
  const [page, setPage] = useState(0)
  const [error, setError] = useState('')
  const [recording, setRecording] = useState(params.get('purchase') === '1')
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null)
  const [openPurchase, setOpenPurchase] = useState<Purchase | null>(null)

  const loadSuppliers = useCallback(async () => {
    const { data, error: loadError } = await supabase.from('suppliers').select('id,name,contact_person,phone,email,notes,active')
      .eq('business_id', businessId).order('name').limit(500)
    if (loadError) setError(friendlyError(loadError)); else setSuppliers(data as Supplier[])
  }, [businessId])

  const loadPurchases = useCallback(async () => {
    setPurchases(null)
    const query = supabase.from('purchases').select('id,supplier_id,reference,total,amount_paid,purchased_on,notes,created_by')
      .eq('business_id', businessId).order('purchased_on', { ascending: false }).order('created_at', { ascending: false })
      .range(page * PAGE, page * PAGE + PAGE)
    // Unpaid view: the latest 300 purchases filtered here (balances are a column comparison).
    const { data, error: loadError } = unpaidOnly
      ? await supabase.from('purchases').select('id,supplier_id,reference,total,amount_paid,purchased_on,notes,created_by')
        .eq('business_id', businessId).order('purchased_on', { ascending: false }).limit(300)
      : await query
    if (loadError) { setError(friendlyError(loadError)); return }
    const rows = (data as Purchase[]).map(p => ({ ...p, total: Number(p.total), amount_paid: Number(p.amount_paid) }))
    setPurchases(unpaidOnly ? rows.filter(p => p.amount_paid < p.total) : rows)
  }, [businessId, page, unpaidOnly])

  useEffect(() => { loadSuppliers() }, [loadSuppliers])
  useEffect(() => { loadPurchases() }, [loadPurchases])

  const names = useMemo(() => new Map((suppliers || []).map(s => [s.id, s.name])), [suppliers])
  const shown = unpaidOnly ? purchases || [] : (purchases || []).slice(0, PAGE)
  const unpaidOnPage = shown.reduce((sum, p) => sum + (p.total - p.amount_paid), 0)

  function closeRecording() { setRecording(false); if (params.get('purchase')) { params.delete('purchase'); setParams(params, { replace: true }) } }

  return <>
    <PageHeader title="Suppliers & purchases" subtitle="Restock from suppliers and track what you owe them" actions={<>
      <button type="button" className="button secondary" onClick={() => setEditing('new')}>+ Supplier</button>
      {can(role, 'recordPurchase') && <button type="button" className="button" onClick={() => setRecording(true)}>+ Record purchase</button>}
    </>} />
    <div className="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'purchases'} className={tab === 'purchases' ? 'active' : ''} onClick={() => setTab('purchases')}>Purchases</button>
      <button type="button" role="tab" aria-selected={tab === 'suppliers'} className={tab === 'suppliers' ? 'active' : ''} onClick={() => setTab('suppliers')}>Suppliers</button>
    </div>
    <ErrorNotice message={error} />
    {tab === 'purchases' ? <>
      <div className="toolbar"><label className="check"><input type="checkbox" checked={unpaidOnly} onChange={e => { setUnpaidOnly(e.target.checked); setPage(0) }} /> Only unpaid purchases</label></div>
      {unpaidOnly && purchases && <div className="stat-grid"><Stat label="Owed to suppliers" value={money(unpaidOnPage)} tone={unpaidOnPage ? 'warning' : undefined} hint={`${shown.length} unpaid purchase${shown.length === 1 ? '' : 's'}`} /></div>}
      {!purchases ? <Loading /> : shown.length === 0 ? <Empty title={unpaidOnly ? 'Nothing owed to suppliers' : 'No purchases recorded yet'}>
        {!unpaidOnly && <p>Record deliveries here: stock goes up and cost prices update automatically.</p>}</Empty> : <>
        <div className="table-wrap"><table className="data-table clickable">
          <thead><tr><th>Date</th><th>Supplier</th><th>Reference</th><th className="num">Total</th><th className="num">Balance</th></tr></thead>
          <tbody>{shown.map(p => <tr key={p.id} onClick={() => setOpenPurchase(p)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setOpenPurchase(p) }}>
            <td data-label="Date">{dateOnly(p.purchased_on)}</td>
            <td data-label="Supplier">{p.supplier_id ? names.get(p.supplier_id) || '—' : 'No supplier'}</td>
            <td data-label="Reference">{p.reference || '—'}</td>
            <td data-label="Total" className="num">{money(p.total)}</td>
            <td data-label="Balance" className="num">{p.total - p.amount_paid > 0 ? <span className="badge warning">! {money(p.total - p.amount_paid)}</span> : <span className="badge good">✓ Paid</span>}</td>
          </tr>)}</tbody>
        </table></div>
        {!unpaidOnly && <Pager page={page} hasMore={(purchases?.length || 0) > PAGE} onPage={setPage} />}
      </>}
    </> : !suppliers ? <Loading /> : suppliers.length === 0 ? <Empty title="No suppliers yet"><button type="button" className="button" onClick={() => setEditing('new')}>Add a supplier</button></Empty> :
      <div className="table-wrap"><table className="data-table clickable">
        <thead><tr><th>Supplier</th><th>Contact</th><th>Phone</th><th>Email</th></tr></thead>
        <tbody>{suppliers.map(s => <tr key={s.id} onClick={() => setEditing(s)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') setEditing(s) }} className={s.active ? '' : 'row-muted'}>
          <td data-label="Supplier"><strong>{s.name}</strong>{!s.active && <small>Archived</small>}</td>
          <td data-label="Contact">{s.contact_person || '—'}</td><td data-label="Phone">{s.phone || '—'}</td><td data-label="Email">{s.email || '—'}</td>
        </tr>)}</tbody>
      </table></div>}

    {recording && <PurchaseForm suppliers={(suppliers || []).filter(s => s.active)} onClose={closeRecording} onSaved={() => { closeRecording(); setPage(0); loadPurchases() }} onNewSupplier={() => setEditing('new')} />}
    {editing && <SupplierForm supplier={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); loadSuppliers() }} />}
    {openPurchase && <PurchaseDetail purchase={openPurchase} supplierName={openPurchase.supplier_id ? names.get(openPurchase.supplier_id) : undefined} onClose={() => setOpenPurchase(null)} onPaid={() => { setOpenPurchase(null); loadPurchases() }} />}
  </>
}

function SupplierForm({ supplier, onClose, onSaved }: { supplier: Supplier | null; onClose: () => void; onSaved: () => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const text = (key: string) => String(form.get(key) || '').trim() || null
    const fields = { name: String(text('name')), contact_person: text('contact'), phone: text('phone'), email: text('email'), notes: text('notes') }
    const { error: saveError } = supplier
      ? await supabase.from('suppliers').update({ ...fields, active: form.get('active') === 'on' }).eq('id', supplier.id).eq('business_id', businessId)
      : await supabase.from('suppliers').insert({ ...fields, business_id: businessId })
    setBusy(false)
    if (saveError) setError(friendlyError(saveError)); else onSaved()
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
      <button className="button" disabled={busy}>{busy ? 'Saving…' : 'Save supplier'}</button>
    </form>
  </Modal>
}

type Line = { key: number; productId: string; quantity: string; unitCost: string }

function PurchaseForm({ suppliers, onClose, onSaved, onNewSupplier }: { suppliers: Supplier[]; onClose: () => void; onSaved: () => void; onNewSupplier: () => void }) {
  const { businessId, products, reloadProducts } = useAccount()
  const active = products.filter(p => p.active)
  const [lines, setLines] = useState<Line[]>([{ key: 1, productId: '', quantity: '', unitCost: '' }])
  const [paid, setPaid] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const total = lines.reduce((sum, l) => sum + Math.round(Number(l.quantity || 0) * Number(l.unitCost || 0) * 100) / 100, 0)

  const update = (key: number, change: Partial<Line>) => setLines(current => current.map(l => {
    if (l.key !== key) return l
    const next = { ...l, ...change }
    if (change.productId && !l.unitCost) next.unitCost = String(products.find(p => p.id === change.productId)?.cost ?? '')
    return next
  }))

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    const items = lines.filter(l => l.productId).map(l => ({ product_id: l.productId, quantity: Number(l.quantity), unit_cost: Number(l.unitCost) }))
    if (!items.length) { setError('Add at least one product.'); return }
    if (items.some(i => !(i.quantity > 0) || !(i.unit_cost >= 0))) { setError('Every line needs a quantity and a unit cost.'); return }
    setBusy(true)
    const form = new FormData(event.currentTarget)
    const { error: saveError } = await supabase.rpc('record_purchase', {
      target_business_id: businessId, target_supplier_id: String(form.get('supplier') || '') || null, items,
      purchase_reference: String(form.get('reference') || '') || null, paid_amount: paid === '' ? total : Number(paid),
      purchase_date: String(form.get('date')), purchase_notes: String(form.get('notes') || '') || null,
    })
    setBusy(false)
    if (saveError) { setError(friendlyError(saveError)); return }
    reloadProducts()
    onSaved()
  }

  return <Modal title="Record purchase / delivery" onClose={onClose} wide>
    <form onSubmit={submit}>
      <div className="form-row">
        <label>Supplier<select name="supplier" defaultValue=""><option value="">— No supplier —</option>{suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
        <label>Invoice / reference<input name="reference" maxLength={60} /></label>
        <label>Date<input name="date" type="date" required max={isoDay()} defaultValue={isoDay()} /></label>
      </div>
      <button type="button" className="link-button" onClick={onNewSupplier}>+ Add a new supplier</button>
      <div className="line-items">
        <div className="line-head"><span>Product</span><span>Quantity</span><span>Unit cost</span><span>Total</span><span /></div>
        {lines.map(line => <div className="line-item" key={line.key}>
          <select aria-label="Product" value={line.productId} onChange={e => update(line.key, { productId: e.target.value })} required={lines.length === 1}>
            <option value="">Choose product…</option>{active.map(p => <option key={p.id} value={p.id}>{p.name} ({qty(p.stock)} in stock)</option>)}
          </select>
          <input aria-label="Quantity" placeholder="Qty" type="number" min="0.001" step="0.001" value={line.quantity} onChange={e => update(line.key, { quantity: e.target.value })} />
          <input aria-label="Unit cost" placeholder="Unit cost" type="number" min="0" step="0.01" value={line.unitCost} onChange={e => update(line.key, { unitCost: e.target.value })} />
          <span className="num">{money(Number(line.quantity || 0) * Number(line.unitCost || 0))}</span>
          <button type="button" className="icon-button" aria-label="Remove line" disabled={lines.length === 1} onClick={() => setLines(current => current.filter(l => l.key !== line.key))}>×</button>
        </div>)}
        <button type="button" className="button secondary small" onClick={() => setLines(current => [...current, { key: Date.now(), productId: '', quantity: '', unitCost: '' }])}>+ Add line</button>
      </div>
      {!active.length && <p className="hint">Create products in Inventory first.</p>}
      <div className="form-row">
        <div className="total-box"><span>Purchase total</span><strong>{money(total)}</strong></div>
        <label>Amount paid now<input type="number" min="0" max={total} step="0.01" value={paid} placeholder={String(total)} onChange={e => setPaid(e.target.value)} /></label>
        <label>Notes<input name="notes" maxLength={500} /></label>
      </div>
      <p className="hint">Leave “amount paid” blank if paid in full. Enter 0 if bought on credit; the balance is tracked as owed to the supplier. Cost prices update to the weighted average.</p>
      <ErrorNotice message={error} />
      <button className="button" disabled={busy || total <= 0 && !lines.some(l => l.productId)}>{busy ? 'Saving…' : 'Save purchase and add stock'}</button>
    </form>
  </Modal>
}

function PurchaseDetail({ purchase, supplierName, onClose, onPaid }: { purchase: Purchase; supplierName?: string; onClose: () => void; onPaid: () => void }) {
  const { businessId, role, staffName } = useAccount()
  const [items, setItems] = useState<PurchaseItem[] | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const balance = purchase.total - purchase.amount_paid

  useEffect(() => {
    supabase.from('purchase_items').select('id,product_name,quantity,unit_cost,line_total').eq('business_id', businessId).eq('purchase_id', purchase.id)
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
      <div><span>Total</span><strong>{money(purchase.total)}</strong></div>
      <div><span>Paid</span><strong>{money(purchase.amount_paid)}</strong></div>
      <div><span>Balance</span><strong className={balance > 0 ? 'neg' : ''}>{money(balance)}</strong></div>
      {purchase.created_by && <div><span>Recorded by</span><strong>{staffName(purchase.created_by)}</strong></div>}
    </div>
    {purchase.notes && <p className="hint">{purchase.notes}</p>}
    <ErrorNotice message={error} />
    {!items && !error ? <Loading /> : items && <table className="data-table compact"><thead><tr><th>Product</th><th className="num">Qty</th><th className="num">Unit cost</th><th className="num">Total</th></tr></thead>
      <tbody>{items.map(i => <tr key={i.id}><td data-label="Product">{i.product_name}</td><td data-label="Qty" className="num">{qty(i.quantity)}</td><td data-label="Unit cost" className="num">{money(i.unit_cost)}</td><td data-label="Total" className="num">{money(i.line_total)}</td></tr>)}</tbody></table>}
    {balance > 0 && can(role, 'payPurchase') && <form className="inline-form" onSubmit={pay}>
      <h3>Record payment to supplier</h3>
      <div className="form-row"><label>Amount<input name="amount" type="number" min="0.01" max={balance} step="0.01" defaultValue={balance} required /></label>
        <button className="button" disabled={busy}>{busy ? 'Saving…' : 'Record payment'}</button></div>
    </form>}
  </Modal>
}
