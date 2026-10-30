import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Product, PRODUCT_COLUMNS, toProduct, useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { businessToday, dateOnly, dateTime, downloadCsv, friendlyError, money, qty, taxCategoryLabel, taxCategoryRate, titleCase, unitsFor } from '../lib/format'
import { Empty, ErrorNotice, Loading, Modal, PageHeader, Pager, Stat } from '../components/ui'

type Movement = { id: string; product_id: string; movement_type: string; reason: string | null; quantity: number; stock_after: number; unit_cost: number | null; note: string | null; created_by: string | null; created_at: string }
const ADJUST_REASONS: [string, string][] = [['count_correction', 'Stock count correction'], ['damaged', 'Damaged'], ['expired', 'Expired'], ['lost', 'Lost or stolen'], ['returned', 'Returned to stock'], ['other', 'Other']]
const daysUntil = (date: string) => Math.ceil((new Date(`${date}T00:00:00`).getTime() - new Date(`${businessToday()}T00:00:00`).getTime()) / 86400000)

export function useCategories() {
  const { businessId, products } = useAccount()
  const [saved, setSaved] = useState<string[]>([])
  const load = useCallback(async () => {
    const { data } = await supabase.from('product_categories').select('name').eq('business_id', businessId).order('name')
    setSaved((data || []).map(row => row.name as string))
  }, [businessId])
  useEffect(() => { load() }, [load])
  const all = useMemo(() => [...new Set([...saved, ...products.map(p => p.category)])].sort((a, b) => a.localeCompare(b)), [saved, products])
  return { categories: all, reload: load }
}

export default function Inventory() {
  const { role, products, productsLoaded, productsError, reloadProducts, businessId, upsertProducts } = useAccount()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<'products' | 'movements'>('products')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [filter, setFilter] = useState<'all' | 'low' | 'out' | 'archived'>('all')
  const [expiry, setExpiry] = useState<'all' | 'expired' | '30' | '90'>('all')
  const [editing, setEditing] = useState<Product | 'new' | null>(params.get('new') ? 'new' : null)
  const [adjusting, setAdjusting] = useState<Product | null>(null)
  const [restocking, setRestocking] = useState<Product | null>(null)
  const [restockMode, setRestockMode] = useState(false)
  const [history, setHistory] = useState<Product | null>(null)
  const [importing, setImporting] = useState(false)
  const [bulkVat, setBulkVat] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const { categories, reload: reloadCategories } = useCategories()
  const editable = can(role, 'editStock')
  const seeCost = role !== 'cashier'

  const term = search.trim().toLowerCase()
  const visible = products.filter(p => {
    if (filter === 'archived' ? p.active : !p.active) return false
    if (filter === 'low' && !(p.is_low_stock && p.stock > 0)) return false
    if (filter === 'out' && p.stock > 0) return false
    if (category !== 'All' && p.category !== category) return false
    if (expiry !== 'all') {
      if (!p.expiry_date) return false
      const days = daysUntil(p.expiry_date)
      if (expiry === 'expired' ? days >= 0 : days < 0 || days > Number(expiry)) return false
    }
    return !term || p.name.toLowerCase().includes(term) || p.sku?.toLowerCase().includes(term) || p.barcode?.includes(term)
  })
  const activeProducts = products.filter(p => p.active)
  const stockValue = activeProducts.reduce((sum, p) => sum + p.stock * p.cost, 0)
  const retailValue = activeProducts.reduce((sum, p) => sum + p.stock * p.price, 0)
  const lowCount = activeProducts.filter(p => p.is_low_stock && p.stock > 0).length
  const outCount = activeProducts.filter(p => p.stock <= 0).length
  const expiringCount = activeProducts.filter(p => p.expiry_date && p.stock > 0 && daysUntil(p.expiry_date) <= 30).length

  function closeEditor() { setEditing(null); if (params.get('new')) { params.delete('new'); setParams(params, { replace: true }) } }

  function exportCsv() {
    downloadCsv('radari-inventory.csv', [
      ['Name', 'Category', 'SKU', 'Barcode', 'Unit', 'Stock', 'Reorder level', ...(seeCost ? ['Cost'] : []), 'Price', 'Tax category', 'Batch', 'Expiry', ...(seeCost ? ['Stock value'] : [])],
      ...visible.map(p => [p.name, p.category, p.sku, p.barcode, p.unit, p.stock, p.reorder_level, ...(seeCost ? [p.cost] : []), p.price, p.tax_category, p.batch_number, p.expiry_date, ...(seeCost ? [Math.round(p.stock * p.cost * 100) / 100] : [])]),
    ])
  }

  async function archiveSelected(active: boolean) {
    if (!selected.size) return
    if (!window.confirm(`${active ? 'Restore' : 'Archive'} ${selected.size} product${selected.size === 1 ? '' : 's'}? ${active ? '' : 'Archived products are hidden from the till but their sales history is kept.'}`)) return
    setError('')
    const ids = [...selected]
    const { data, error: updateError } = await supabase.from('products').update({ active }).eq('business_id', businessId).in('id', ids).select(PRODUCT_COLUMNS)
    if (updateError) { setError(friendlyError(updateError)); return }
    upsertProducts((data || []).map(toProduct))
    setSelected(new Set()); setSelecting(false)
  }

  function toggle(id: string) { setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next }) }

  return <>
    <PageHeader title="Inventory" subtitle={`${activeProducts.length} active products`} actions={<>
      {editable && <button type="button" className={`button ${restockMode ? '' : 'secondary'}`} onClick={() => setRestockMode(on => !on)}>{restockMode ? 'Exit restock mode' : 'Quick restock'}</button>}
      <button type="button" className="button secondary" onClick={exportCsv} disabled={!visible.length}>Export</button>
      {editable && <button type="button" className="button secondary" onClick={() => setImporting(true)}>Import</button>}
      {can(role, 'bulkVat') && <button type="button" className="button secondary" onClick={() => setBulkVat(true)}>Bulk VAT</button>}
      {editable && <button type="button" className="button secondary" onClick={() => { setSelecting(on => !on); setSelected(new Set()) }}>{selecting ? 'Cancel selection' : 'Select'}</button>}
      {editable && <button type="button" className="button" onClick={() => setEditing('new')}>Add product</button>}
    </>} />

    <div className="stat-grid">
      {seeCost && <Stat label="Stock value at cost" value={money(stockValue)} />}
      <Stat label="Stock value at selling price" value={money(retailValue)} />
      <Stat label="Low stock" value={lowCount} tone={lowCount ? 'warning' : undefined} hint={lowCount ? <button type="button" className="link-button" onClick={() => { setTab('products'); setFilter('low') }}>Show</button> : 'None'} />
      <Stat label="Out of stock" value={outCount} tone={outCount ? 'critical' : undefined} hint={outCount ? <button type="button" className="link-button" onClick={() => { setTab('products'); setFilter('out') }}>Show</button> : 'None'} />
      <Stat label="Expiring within 30 days" value={expiringCount} tone={expiringCount ? 'warning' : undefined} hint={expiringCount ? <button type="button" className="link-button" onClick={() => { setTab('products'); setExpiry('30') }}>Show</button> : 'None'} />
    </div>

    {restockMode && <div className="bulk-bar"><span><strong>Restock mode.</strong> Tap a product to add stock to it.</span><button type="button" className="button secondary small" onClick={() => setRestockMode(false)}>Done</button></div>}
    {selecting && <div className="bulk-bar"><span>{selected.size} selected</span><div className="page-actions">
      <button type="button" className="button secondary small" onClick={() => setSelected(new Set(visible.map(p => p.id)))}>Select all shown</button>
      {filter === 'archived'
        ? <button type="button" className="button small" disabled={!selected.size} onClick={() => archiveSelected(true)}>Restore selected</button>
        : <button type="button" className="button danger small" disabled={!selected.size} onClick={() => archiveSelected(false)}>Archive selected</button>}
    </div></div>}

    <div className="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'products'} className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}>Products</button>
      {role !== 'cashier' && <button type="button" role="tab" aria-selected={tab === 'movements'} className={tab === 'movements' ? 'active' : ''} onClick={() => setTab('movements')}>Stock movements</button>}
    </div>
    <ErrorNotice message={error || productsError} onRetry={productsError ? reloadProducts : undefined} />

    {tab === 'movements' ? <MovementLog products={products} /> : <>
      <div className="toolbar">
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, SKU or barcode" aria-label="Search products" />
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Category"><option value="All">All categories</option>{categories.map(c => <option key={c}>{c}</option>)}</select>
        <select value={filter} onChange={e => setFilter(e.target.value as typeof filter)} aria-label="Stock level">
          <option value="all">All stock levels</option><option value="low">Low stock</option><option value="out">Out of stock</option><option value="archived">Archived</option>
        </select>
        <select value={expiry} onChange={e => setExpiry(e.target.value as typeof expiry)} aria-label="Expiry">
          <option value="all">Any expiry</option><option value="expired">Expired</option><option value="30">Expiring in 30 days</option><option value="90">Expiring in 90 days</option>
        </select>
      </div>
      {!productsLoaded ? <Loading /> : visible.length === 0 ? <Empty title={products.length ? 'No products match these filters' : 'No products yet'}>
        {editable && !products.length && <button type="button" className="button" onClick={() => setEditing('new')}>Add your first product</button>}
      </Empty> :
        <div className="table-wrap"><table className={`data-table ${restockMode ? 'clickable' : ''}`}>
          <thead><tr>{selecting && <th aria-label="Select" />}<th>Product</th><th>Category</th><th className="num">Stock</th>{seeCost && <th className="num">Cost</th>}<th className="num">Price</th><th>Expiry</th><th aria-label="Actions" /></tr></thead>
          <tbody>{visible.map(p => {
            const days = p.expiry_date ? daysUntil(p.expiry_date) : null
            return <tr key={p.id} className={`${p.stock <= 0 ? 'row-critical' : p.is_low_stock ? 'row-warning' : ''} ${selected.has(p.id) ? 'row-selected' : ''}`}
              onClick={restockMode ? () => setRestocking(p) : selecting ? () => toggle(p.id) : undefined}>
              {selecting && <td><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} onClick={e => e.stopPropagation()} aria-label={`Select ${p.name}`} /></td>}
              <td data-label="Product"><strong>{p.name}</strong><small>{[p.sku && `SKU ${p.sku}`, p.barcode && `Barcode ${p.barcode}`, p.batch_number && `Batch ${p.batch_number}`].filter(Boolean).join(' · ') || p.unit}</small></td>
              <td data-label="Category">{p.category}</td>
              <td data-label="Stock" className="num">{qty(p.stock)}{p.unit !== 'Piece' ? ` ${p.unit.toLowerCase()}` : ''}{p.stock <= 0 ? <span className="badge critical">Out</span> : p.is_low_stock ? <span className="badge warning">Low</span> : null}<small>Reorder at {qty(p.reorder_level)}</small></td>
              {seeCost && <td data-label="Cost" className="num">{money(p.cost)}</td>}
              <td data-label="Price" className="num">{money(p.price)}<small>{taxCategoryLabel[p.tax_category] || `${p.vat_rate}% VAT`}</small></td>
              <td data-label="Expiry">{p.expiry_date ? <>{dateOnly(p.expiry_date)}{days! < 0 ? <span className="badge critical">Expired</span> : days! <= 30 ? <span className="badge warning">{days} days</span> : null}</> : <span className="muted">None</span>}</td>
              <td className="row-actions" onClick={e => e.stopPropagation()}>
                {editable && <button type="button" onClick={() => setEditing(p)}>Edit</button>}
                {editable && <button type="button" onClick={() => setRestocking(p)}>Restock</button>}
                {editable && <button type="button" onClick={() => setAdjusting(p)}>Adjust</button>}
                {role !== 'cashier' && <button type="button" onClick={() => setHistory(p)}>History</button>}
              </td>
            </tr>
          })}</tbody>
        </table></div>}
    </>}

    {editing && <ProductForm product={editing === 'new' ? null : editing} categories={categories} onClose={closeEditor} onSaved={reloadCategories} />}
    {adjusting && <AdjustStock product={adjusting} onClose={() => setAdjusting(null)} />}
    {restocking && <Restock product={restocking} onClose={() => setRestocking(null)} />}
    {history && <ProductHistory product={history} onClose={() => setHistory(null)} />}
    {importing && <ImportProducts onClose={() => setImporting(false)} onDone={() => { setImporting(false); reloadProducts(); reloadCategories() }} />}
    {bulkVat && <BulkVat onClose={() => setBulkVat(false)} onDone={() => { setBulkVat(false); reloadProducts() }} />}
  </>
}

function ProductForm({ product, categories, onClose, onSaved }: { product: Product | null; categories: string[]; onClose: () => void; onSaved: () => void }) {
  const { businessId, business, upsertProducts } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [price, setPrice] = useState(product ? String(product.price) : '')
  const [cost, setCost] = useState(product ? String(product.cost) : '')
  const [taxCategory, setTaxCategory] = useState(product?.tax_category || (Number(business.default_vat_rate) === 0 ? 'exempt' : 'standard'))
  const [serving, setServing] = useState(!!product?.serving_ml)
  const units = unitsFor(business.business_type)
  const vatRate = taxCategoryRate[taxCategory] ?? 16
  const net = Number(price) / (1 + vatRate / 100)
  const margin = Number(price) > 0 && cost !== '' ? Math.round(((net - Number(cost)) / net) * 100) : null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const text = (key: string) => String(form.get(key) || '').trim()
    const numberOrNull = (key: string) => text(key) === '' ? null : Number(text(key))
    const categoryName = text('category') || 'General'
    const fields = {
      name: text('name'), category: categoryName, sku: text('sku') || null, barcode: text('barcode') || null,
      cost: Number(cost), price: Number(price), reorder_level: Number(form.get('reorder') || 0),
      tax_category: taxCategory, vat_rate: vatRate, unit: text('unit') || 'Piece', min_price_percent: numberOrNull('floor'),
      batch_number: text('batch') || null, expiry_date: text('expiry') || null,
      container_ml: serving ? numberOrNull('container') : null, serving_ml: serving ? numberOrNull('serving') : null, serving_price: serving ? numberOrNull('servingPrice') : null,
    }
    if (serving && (!fields.container_ml || !fields.serving_ml || fields.serving_price === null)) { setBusy(false); setError('Enter the bottle size, serving size and serving price, or turn off selling by serving.'); return }
    if (fields.price < fields.cost && !window.confirm('The selling price is below the cost price. Save anyway?')) { setBusy(false); return }
    const request = product
      ? supabase.from('products').update({ ...fields, active: form.get('active') === 'on' }).eq('id', product.id).eq('business_id', businessId)
      : supabase.from('products').insert({ ...fields, business_id: businessId, stock: Number(form.get('stock') || 0) })
    const { data, error: saveError } = await request.select(PRODUCT_COLUMNS).single()
    if (saveError) { setBusy(false); setError(friendlyError(saveError)); return }
    if (!categories.some(c => c.toLowerCase() === categoryName.toLowerCase())) {
      await supabase.from('product_categories').insert({ business_id: businessId, name: categoryName })
    }
    setBusy(false)
    upsertProducts([toProduct(data)])
    onSaved(); onClose()
  }

  return <Modal title={product ? `Edit ${product.name}` : 'Add product'} onClose={onClose} wide>
    <form onSubmit={submit}>
      <div className="form-pair">
        <label>Product name<input name="name" required maxLength={120} defaultValue={product?.name} autoFocus /></label>
        <label>Category<input name="category" list="category-options" maxLength={60} defaultValue={product?.category || ''} placeholder="General" /></label>
      </div>
      <datalist id="category-options">{categories.map(c => <option key={c} value={c} />)}</datalist>
      <div className="form-row">
        <label>SKU<input name="sku" maxLength={60} defaultValue={product?.sku || ''} /></label>
        <label>Barcode<input name="barcode" maxLength={60} inputMode="numeric" defaultValue={product?.barcode || ''} /></label>
        <label>Unit of measure<input name="unit" list="unit-options" maxLength={40} defaultValue={product?.unit || units[0]} /></label>
      </div>
      <datalist id="unit-options">{units.map(u => <option key={u} value={u} />)}</datalist>
      <div className="form-row">
        <label>Cost price (KSh)<input type="number" min="0" step="0.01" required value={cost} onChange={e => setCost(e.target.value)} /></label>
        <label>Selling price incl. VAT (KSh)<input type="number" min="0" step="0.01" required value={price} onChange={e => setPrice(e.target.value)} /></label>
        <label>Tax category<select value={taxCategory} onChange={e => setTaxCategory(e.target.value)}>{Object.entries(taxCategoryLabel).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      </div>
      {margin !== null && <p className={`hint ${margin < 0 ? 'bad' : ''}`}>Gross margin {margin}%, or {money(net - Number(cost))} per {product?.unit.toLowerCase() || 'unit'} before expenses.</p>}
      <div className="form-row">
        {!product && <label>Opening stock<input name="stock" type="number" min="0" step="0.001" defaultValue="0" required /></label>}
        <label>Reorder level<input name="reorder" type="number" min="0" step="0.001" defaultValue={product?.reorder_level ?? 5} required /></label>
        <label>Lowest price allowed (% of price)<input name="floor" type="number" min="0" max="100" step="1" defaultValue={product?.min_price_percent ?? ''} placeholder={`Default ${business.min_price_percent || 0}%`} /></label>
      </div>
      <div className="form-pair">
        <label>Batch or lot number<input name="batch" maxLength={60} defaultValue={product?.batch_number || ''} /></label>
        <label>Expiry date<input name="expiry" type="date" defaultValue={product?.expiry_date || ''} /></label>
      </div>
      <div className="form-section">
        <label className="check"><input type="checkbox" checked={serving} onChange={e => setServing(e.target.checked)} /> Also sell by serving (for example tots from a bottle)</label>
        {serving && <div className="form-row" style={{ marginTop: 10 }}>
          <label>Bottle size (ml)<input name="container" type="number" min="1" step="1" defaultValue={product?.container_ml ?? 750} /></label>
          <label>Serving size (ml)<input name="serving" type="number" min="1" step="1" defaultValue={product?.serving_ml ?? 25} /></label>
          <label>Serving price (KSh)<input name="servingPrice" type="number" min="0" step="0.01" defaultValue={product?.serving_price ?? ''} /></label>
        </div>}
      </div>
      {product && <>
        <p className="hint">Current stock: <strong>{qty(product.stock)}</strong>. Change stock with Restock or Adjust so every change is recorded.</p>
        <label className="check"><input type="checkbox" name="active" defaultChecked={product.active} /> Active (available at the till)</label>
      </>}
      <ErrorNotice message={error} />
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button className="button" disabled={busy}>{busy ? 'Saving' : 'Save product'}</button></div>
    </form>
  </Modal>
}

function Restock({ product, onClose }: { product: Product; onClose: () => void }) {
  const { businessId, reloadProducts } = useAccount()
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const { error: rpcError } = await supabase.rpc('record_purchase', {
      target_business_id: businessId, target_supplier_id: null,
      items: [{ product_id: product.id, quantity: Number(amount), unit_cost: Number(form.get('cost')),
        batch_number: String(form.get('batch') || '') || null, expiry_date: String(form.get('expiry') || '') || null }],
      purchase_reference: 'Quick restock', paid_amount: null, purchase_date: businessToday(), purchase_notes: null, invoice_total: null,
    })
    setBusy(false)
    if (rpcError) { setError(friendlyError(rpcError)); return }
    reloadProducts(); onClose()
  }
  return <Modal title={`Restock ${product.name}`} onClose={onClose}>
    <form onSubmit={submit}>
      <p className="hint">Current stock: <strong>{qty(product.stock)} {product.unit.toLowerCase()}</strong>. This is recorded as a paid purchase with no supplier. Use Purchases for supplier invoices.</p>
      <label>Quantity to add<input type="number" min="0.001" step="0.001" required value={amount} onChange={e => setAmount(e.target.value)} autoFocus /></label>
      <div className="page-actions">{[5, 10, 20, 50].map(n => <button type="button" key={n} className="button secondary small" onClick={() => setAmount(String(Number(amount || 0) + n))}>+{n}</button>)}</div>
      <label>Cost per unit (KSh)<input name="cost" type="number" min="0" step="0.01" required defaultValue={product.cost} /></label>
      <div className="form-pair">
        <label>Batch or lot number<input name="batch" maxLength={60} /></label>
        <label>Expiry date<input name="expiry" type="date" /></label>
      </div>
      {amount && <p className="hint">New stock will be <strong>{qty(product.stock + Number(amount))}</strong>.</p>}
      <ErrorNotice message={error} />
      <button className="button" disabled={busy || !Number(amount)}>{busy ? 'Saving' : 'Confirm restock'}</button>
    </form>
  </Modal>
}

function AdjustStock({ product, onClose }: { product: Product; onClose: () => void }) {
  const { businessId, upsertProducts } = useAccount()
  const [direction, setDirection] = useState<'remove' | 'add'>('remove')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const change = (direction === 'add' ? 1 : -1) * Number(amount || 0)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const { data, error: rpcError } = await supabase.rpc('adjust_stock', {
      target_business_id: businessId, target_product_id: product.id, quantity_change: change,
      adjustment_reason: String(form.get('reason')), adjustment_note: String(form.get('note') || '') || null,
    })
    setBusy(false)
    if (rpcError) { setError(friendlyError(rpcError)); return }
    upsertProducts([{ ...product, stock: Number(data), is_low_stock: Number(data) <= product.reorder_level }])
    onClose()
  }
  return <Modal title={`Adjust stock: ${product.name}`} onClose={onClose}>
    <form onSubmit={submit}>
      <p className="hint">Current stock: <strong>{qty(product.stock)}</strong>. Use this for counts, damage, expiry and losses.</p>
      <div className="segmented" role="radiogroup">
        <button type="button" role="radio" aria-checked={direction === 'remove'} className={direction === 'remove' ? 'active' : ''} onClick={() => setDirection('remove')}>Remove stock</button>
        <button type="button" role="radio" aria-checked={direction === 'add'} className={direction === 'add' ? 'active' : ''} onClick={() => setDirection('add')}>Add stock</button>
      </div>
      <label>Quantity<input type="number" min="0.001" step="0.001" required value={amount} onChange={e => setAmount(e.target.value)} autoFocus /></label>
      <label>Reason<select name="reason" required defaultValue={direction === 'add' ? 'count_correction' : 'damaged'}>{ADJUST_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Note<input name="note" maxLength={300} /></label>
      {amount && <p className="hint">New stock will be <strong>{qty(product.stock + change)}</strong>.</p>}
      <ErrorNotice message={error} />
      <button className="button" disabled={busy || !Number(amount)}>{busy ? 'Saving' : 'Save adjustment'}</button>
    </form>
  </Modal>
}

const movementLabel = (m: Movement) => m.movement_type === 'adjustment' ? `Adjustment: ${titleCase(m.reason || 'other').toLowerCase()}` : titleCase(m.movement_type)

function ProductHistory({ product, onClose }: { product: Product; onClose: () => void }) {
  const { businessId, staffName } = useAccount()
  const [rows, setRows] = useState<Movement[] | null>(null), [error, setError] = useState('')
  useEffect(() => {
    supabase.from('stock_movements').select('id,product_id,movement_type,reason,quantity,stock_after,unit_cost,note,created_by,created_at')
      .eq('business_id', businessId).eq('product_id', product.id).order('created_at', { ascending: false }).limit(100)
      .then(({ data, error: loadError }) => { if (loadError) setError(friendlyError(loadError)); else setRows(data as Movement[]) })
  }, [businessId, product.id])
  return <Modal title={`Stock history: ${product.name}`} onClose={onClose} wide>
    <ErrorNotice message={error} />
    {!rows && !error ? <Loading /> : rows && rows.length === 0 ? <Empty title="No stock movements yet" /> : rows &&
      <div className="table-wrap"><table className="data-table compact">
        <thead><tr><th>Date</th><th>Type</th><th className="num">Change</th><th className="num">Balance</th><th>By</th></tr></thead>
        <tbody>{rows.map(m => <tr key={m.id}>
          <td data-label="Date">{dateTime(m.created_at)}</td>
          <td data-label="Type">{movementLabel(m)}{m.note && <small>{m.note}</small>}</td>
          <td data-label="Change" className={`num ${Number(m.quantity) < 0 ? 'neg' : 'pos'}`}>{Number(m.quantity) > 0 ? '+' : ''}{qty(m.quantity)}</td>
          <td data-label="Balance" className="num">{qty(m.stock_after)}</td>
          <td data-label="By">{m.created_by ? staffName(m.created_by) : 'System'}</td>
        </tr>)}</tbody>
      </table></div>}
    {rows && rows.length === 100 && <p className="hint">Showing the latest 100 movements.</p>}
  </Modal>
}

function MovementLog({ products }: { products: Product[] }) {
  const { businessId, staffName } = useAccount()
  const [type, setType] = useState('all')
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<Movement[] | null>(null)
  const [error, setError] = useState('')
  const size = 30
  const names = useMemo(() => new Map(products.map(p => [p.id, p.name])), [products])
  const load = useCallback(async () => {
    setRows(null); setError('')
    let query = supabase.from('stock_movements').select('id,product_id,movement_type,reason,quantity,stock_after,unit_cost,note,created_by,created_at')
      .eq('business_id', businessId).order('created_at', { ascending: false }).range(page * size, page * size + size)
    if (type !== 'all') query = query.eq('movement_type', type)
    const { data, error: loadError } = await query
    if (loadError) setError(friendlyError(loadError)); else setRows(data as Movement[])
  }, [businessId, page, type])
  useEffect(() => { load() }, [load])
  return <>
    <div className="toolbar"><select value={type} onChange={e => { setType(e.target.value); setPage(0) }} aria-label="Movement type">
      <option value="all">All movements</option><option value="sale">Sales</option><option value="purchase">Purchases and restocks</option><option value="adjustment">Adjustments</option><option value="void">Voids</option><option value="opening">Opening stock</option>
    </select></div>
    <ErrorNotice message={error} onRetry={load} />
    {!rows && !error ? <Loading /> : rows && rows.length === 0 ? <Empty title="No stock movements yet" /> : rows && <>
      <div className="table-wrap"><table className="data-table compact">
        <thead><tr><th>Date</th><th>Product</th><th>Type</th><th className="num">Change</th><th className="num">Balance</th><th>By</th></tr></thead>
        <tbody>{rows.slice(0, size).map(m => <tr key={m.id}>
          <td data-label="Date">{dateTime(m.created_at)}</td>
          <td data-label="Product">{names.get(m.product_id) || 'Deleted product'}</td>
          <td data-label="Type">{movementLabel(m)}{m.note && <small>{m.note}</small>}</td>
          <td data-label="Change" className={`num ${Number(m.quantity) < 0 ? 'neg' : 'pos'}`}>{Number(m.quantity) > 0 ? '+' : ''}{qty(m.quantity)}</td>
          <td data-label="Balance" className="num">{qty(m.stock_after)}</td>
          <td data-label="By">{m.created_by ? staffName(m.created_by) : 'System'}</td>
        </tr>)}</tbody>
      </table></div>
      <Pager page={page} hasMore={rows.length > size} onPage={setPage} />
    </>}
  </>
}

type ImportRow = { name: string; category: string; sku: string | null; barcode: string | null; unit: string; cost: number; price: number; stock: number; reorder_level: number; tax_category: string; problem?: string }
const HEADER_ALIASES: Record<string, keyof ImportRow> = {
  name: 'name', product: 'name', 'product name': 'name', category: 'category', sku: 'sku', code: 'sku', barcode: 'barcode', unit: 'unit',
  cost: 'cost', 'cost price': 'cost', 'buying price': 'cost', price: 'price', 'selling price': 'price', stock: 'stock', quantity: 'stock', 'opening stock': 'stock',
  'reorder level': 'reorder_level', reorder: 'reorder_level', 'tax category': 'tax_category', vat: 'tax_category',
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cell = ''; let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (c === '"') quoted = false; else cell += c }
    else if (c === '"') quoted = true
    else if (c === ',') { row.push(cell); cell = '' }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = '' }
    else cell += c
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows.filter(r => r.some(v => v.trim()))
}

function ImportProducts({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { businessId, products, business } = useAccount()
  const [rows, setRows] = useState<ImportRow[] | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(0)
  const existing = useMemo(() => new Set(products.flatMap(p => [p.name.toLowerCase(), p.sku?.toLowerCase()].filter(Boolean) as string[])), [products])

  async function readFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    setError(''); setRows(null)
    try {
      let table: unknown[][]
      if (/\.xlsx$/i.test(file.name)) {
        const { readSheet } = await import('read-excel-file/browser')
        table = await readSheet(file) as unknown[][]
      } else table = parseCsv(await file.text())
      if (table.length < 2) throw new Error('The file has no product rows.')
      const headers = table[0].map(h => HEADER_ALIASES[String(h ?? '').trim().toLowerCase()])
      if (!headers.includes('name') || !headers.includes('price')) throw new Error('The first row must include at least "Name" and "Price" columns.')
      const parsed = table.slice(1).slice(0, 2000).map(cells => {
        const r: Record<string, unknown> = {}
        headers.forEach((key, i) => { if (key) r[key] = cells[i] })
        const text = (v: unknown) => String(v ?? '').trim()
        const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0 }
        const tax = text(r.tax_category).toLowerCase()
        const row: ImportRow = {
          name: text(r.name).slice(0, 120), category: text(r.category).slice(0, 60) || 'General', sku: text(r.sku).slice(0, 60) || null,
          barcode: text(r.barcode).slice(0, 60) || null, unit: text(r.unit).slice(0, 40) || 'Piece', cost: num(r.cost), price: num(r.price),
          stock: Math.max(0, num(r.stock)), reorder_level: Math.max(0, num(r.reorder_level)),
          tax_category: tax.includes('exempt') ? 'exempt' : tax.includes('zero') ? 'zero_rated' : tax.includes('8') ? 'reduced' : tax === '0' ? 'exempt' : Number(business.default_vat_rate) === 0 && !tax ? 'exempt' : 'standard',
        }
        if (!row.name) row.problem = 'Missing name'
        else if (row.price <= 0) row.problem = 'Missing price'
        else if (existing.has(row.name.toLowerCase()) || (row.sku && existing.has(row.sku.toLowerCase()))) row.problem = 'Already exists'
        return row
      })
      setRows(parsed)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'The file could not be read.') }
  }

  async function save() {
    if (!rows) return
    const good = rows.filter(r => !r.problem)
    setBusy(true); setError(''); setDone(0)
    for (let i = 0; i < good.length; i += 200) {
      const chunk = good.slice(i, i + 200).map(r => ({ business_id: businessId, name: r.name, category: r.category, sku: r.sku, barcode: r.barcode, unit: r.unit,
        cost: r.cost, price: r.price, stock: r.stock, reorder_level: r.reorder_level, tax_category: r.tax_category, vat_rate: taxCategoryRate[r.tax_category] }))
      const { error: insertError } = await supabase.from('products').insert(chunk)
      if (insertError) { setBusy(false); setError(`${friendlyError(insertError)} (${i} products were imported before this error.)`); return }
      setDone(i + chunk.length)
    }
    const names = [...new Set(good.map(r => r.category))]
    await supabase.from('product_categories').insert(names.map(name => ({ business_id: businessId, name }))).then(() => undefined, () => undefined)
    setBusy(false); onDone()
  }

  const good = rows?.filter(r => !r.problem).length || 0
  return <Modal title="Import products" onClose={onClose} wide>
    <p className="hint">Upload an Excel (.xlsx) or CSV file. The first row must contain column names: <strong>Name</strong> and <strong>Price</strong> are required; Category, SKU, Barcode, Unit, Cost, Stock, Reorder level and Tax category are optional. Opening stock is recorded in the audit trail.</p>
    <input type="file" accept=".xlsx,.csv,text/csv" onChange={readFile} aria-label="Choose file" />
    <ErrorNotice message={error} />
    {rows && <>
      <p className="hint">{good} of {rows.length} rows will be imported.{rows.length - good > 0 && ' Rows with problems are skipped.'}</p>
      <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}><table className="data-table compact">
        <thead><tr><th>Name</th><th>Category</th><th className="num">Cost</th><th className="num">Price</th><th className="num">Stock</th><th>Status</th></tr></thead>
        <tbody>{rows.slice(0, 200).map((r, i) => <tr key={i} className={r.problem ? 'row-muted' : ''}>
          <td data-label="Name">{r.name || '(blank)'}</td><td data-label="Category">{r.category}</td><td data-label="Cost" className="num">{money(r.cost)}</td>
          <td data-label="Price" className="num">{money(r.price)}</td><td data-label="Stock" className="num">{qty(r.stock)}</td>
          <td data-label="Status">{r.problem ? <span className="badge muted">{r.problem}</span> : <span className="badge good">Ready</span>}</td>
        </tr>)}</tbody>
      </table></div>
      <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="button" disabled={busy || !good} onClick={save}>{busy ? `Importing ${done} of ${good}` : `Import ${good} products`}</button></div>
    </>}
  </Modal>
}

function BulkVat({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { businessId } = useAccount()
  const [choice, setChoice] = useState('standard')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function apply() {
    if (!window.confirm(`Set every product to ${taxCategoryLabel[choice]}?`)) return
    setBusy(true); setError('')
    const { error: rpcError } = await supabase.rpc('bulk_set_tax_category', { target_business_id: businessId, new_category: choice })
    setBusy(false)
    if (rpcError) setError(friendlyError(rpcError)); else onDone()
  }
  return <Modal title="Set VAT for all products" onClose={onClose}>
    <div className="radio-cards">{Object.entries(taxCategoryLabel).map(([k, v]) => <label key={k} className="radio-card">
      <input type="radio" name="tax" checked={choice === k} onChange={() => setChoice(k)} /><span><strong>{v}</strong></span></label>)}</div>
    <p className="hint">This changes the VAT rate on every product, including archived ones. Past sales keep the VAT they were sold with.</p>
    <ErrorNotice message={error} />
    <div className="modal-actions"><button type="button" className="button secondary" onClick={onClose}>Cancel</button><button type="button" className="button" disabled={busy} onClick={apply}>{busy ? 'Applying' : 'Apply to all products'}</button></div>
  </Modal>
}
