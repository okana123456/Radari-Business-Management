import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Product, PRODUCT_COLUMNS, toProduct, useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { dateTime, downloadCsv, friendlyError, money, qty, titleCase } from '../lib/format'
import { Empty, ErrorNotice, Loading, Modal, PageHeader, Pager, Stat } from '../components/ui'

type Movement = { id: string; product_id: string; movement_type: string; reason: string | null; quantity: number; stock_after: number; unit_cost: number | null; note: string | null; created_by: string | null; created_at: string }
const ADJUST_REASONS: [string, string][] = [['count_correction', 'Stock count correction'], ['damaged', 'Damaged'], ['expired', 'Expired'], ['lost', 'Lost / theft'], ['returned', 'Returned to stock'], ['other', 'Other']]

export default function Inventory() {
  const { role, products, productsLoaded, productsError, reloadProducts } = useAccount()
  const [params, setParams] = useSearchParams()
  const [tab, setTab] = useState<'products' | 'movements'>('products')
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [filter, setFilter] = useState<'all' | 'low' | 'out' | 'archived'>('all')
  const [editing, setEditing] = useState<Product | 'new' | null>(params.get('new') ? 'new' : null)
  const [adjusting, setAdjusting] = useState<Product | null>(null)
  const [history, setHistory] = useState<Product | null>(null)
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const editable = can(role, 'editStock')
  const seeCost = role !== 'cashier'

  const categories = useMemo(() => [...new Set(products.map(p => p.category))].sort(), [products])
  const term = search.trim().toLowerCase()
  const visible = products.filter(p => {
    if (filter === 'archived' ? p.active : !p.active) return false
    if (filter === 'low' && !(p.is_low_stock && p.stock > 0)) return false
    if (filter === 'out' && p.stock > 0) return false
    if (category !== 'All' && p.category !== category) return false
    return !term || p.name.toLowerCase().includes(term) || p.sku?.toLowerCase().includes(term) || p.barcode?.includes(term)
  })
  const activeProducts = products.filter(p => p.active)
  const stockValue = activeProducts.reduce((sum, p) => sum + p.stock * p.cost, 0)
  const retailValue = activeProducts.reduce((sum, p) => sum + p.stock * p.price, 0)
  const lowCount = activeProducts.filter(p => p.is_low_stock && p.stock > 0).length
  const outCount = activeProducts.filter(p => p.stock <= 0).length

  function closeEditor() { setEditing(null); if (params.get('new')) { params.delete('new'); setParams(params, { replace: true }) } }

  function exportCsv() {
    downloadCsv('radari-inventory.csv', [
      ['Name', 'Category', 'SKU', 'Barcode', 'Stock', 'Low stock level', ...(seeCost ? ['Cost'] : []), 'Price', 'VAT %', ...(seeCost ? ['Stock value'] : [])],
      ...visible.map(p => [p.name, p.category, p.sku, p.barcode, p.stock, p.reorder_level, ...(seeCost ? [p.cost] : []), p.price, p.vat_rate, ...(seeCost ? [Math.round(p.stock * p.cost * 100) / 100] : [])]),
    ])
  }

  return <>
    <PageHeader title="Inventory" subtitle={`${activeProducts.length} active products`} actions={<>
      {editable && <button type="button" className="button secondary" onClick={() => setCategoriesOpen(true)}>Categories</button>}
      <button type="button" className="button secondary" onClick={exportCsv} disabled={!visible.length}>Export CSV</button>
      {editable && <button type="button" className="button" onClick={() => setEditing('new')}>+ New product</button>}
    </>} />

    <div className="stat-grid">
      {seeCost && <Stat label="Stock value (cost)" value={money(stockValue)} />}
      <Stat label="Stock value (selling)" value={money(retailValue)} />
      <Stat label="Low stock" value={lowCount} tone={lowCount ? 'warning' : undefined} hint={lowCount ? <button type="button" className="link-button" onClick={() => { setTab('products'); setFilter('low') }}>Show</button> : 'All good'} />
      <Stat label="Out of stock" value={outCount} tone={outCount ? 'critical' : undefined} hint={outCount ? <button type="button" className="link-button" onClick={() => { setTab('products'); setFilter('out') }}>Show</button> : undefined} />
    </div>

    <div className="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'products'} className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}>Products</button>
      {role !== 'cashier' && <button type="button" role="tab" aria-selected={tab === 'movements'} className={tab === 'movements' ? 'active' : ''} onClick={() => setTab('movements')}>Stock movements</button>}
    </div>

    {tab === 'movements' ? <MovementLog products={products} /> : <>
      <div className="toolbar">
        <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, SKU or barcode" aria-label="Search products" />
        <select value={category} onChange={e => setCategory(e.target.value)} aria-label="Category"><option value="All">All categories</option>{categories.map(c => <option key={c}>{c}</option>)}</select>
        <select value={filter} onChange={e => setFilter(e.target.value as typeof filter)} aria-label="Stock filter">
          <option value="all">All active</option><option value="low">Low stock</option><option value="out">Out of stock</option><option value="archived">Archived</option>
        </select>
      </div>
      <ErrorNotice message={productsError} onRetry={reloadProducts} />
      {!productsLoaded ? <Loading /> : visible.length === 0 ? <Empty title={products.length ? 'No products match these filters' : 'No products yet'}>
        {editable && !products.length && <button type="button" className="button" onClick={() => setEditing('new')}>Add your first product</button>}
      </Empty> :
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Product</th><th>Category</th><th className="num">Stock</th>{seeCost && <th className="num">Cost</th>}<th className="num">Price</th>{seeCost && <th className="num">Margin</th>}<th aria-label="Actions" /></tr></thead>
          <tbody>{visible.map(p => <tr key={p.id} className={p.stock <= 0 ? 'row-critical' : p.is_low_stock ? 'row-warning' : ''}>
            <td data-label="Product"><strong>{p.name}</strong><small>{[p.sku && `SKU ${p.sku}`, p.barcode && `⌗ ${p.barcode}`].filter(Boolean).join(' · ') || '—'}</small></td>
            <td data-label="Category">{p.category}</td>
            <td data-label="Stock" className="num">{qty(p.stock)}{p.stock <= 0 ? <span className="badge critical">✕ out</span> : p.is_low_stock ? <span className="badge warning">! low</span> : null}<small>Alert at {qty(p.reorder_level)}</small></td>
            {seeCost && <td data-label="Cost" className="num">{money(p.cost)}</td>}
            <td data-label="Price" className="num">{money(p.price)}{p.vat_rate > 0 && <small>incl. {p.vat_rate}% VAT</small>}</td>
            {seeCost && <td data-label="Margin" className="num">{p.price > 0 ? `${Math.round(((p.price / (1 + p.vat_rate / 100) - p.cost) / (p.price / (1 + p.vat_rate / 100))) * 100)}%` : '—'}</td>}
            <td className="row-actions">
              {editable && <button type="button" onClick={() => setEditing(p)}>Edit</button>}
              {editable && <button type="button" onClick={() => setAdjusting(p)}>Adjust</button>}
              {role !== 'cashier' && <button type="button" onClick={() => setHistory(p)}>History</button>}
            </td>
          </tr>)}</tbody>
        </table></div>}
    </>}

    {editing && <ProductForm product={editing === 'new' ? null : editing} categories={categories} onClose={closeEditor} />}
    {adjusting && <AdjustStock product={adjusting} onClose={() => setAdjusting(null)} />}
    {history && <ProductHistory product={history} onClose={() => setHistory(null)} />}
    {categoriesOpen && <Categories products={products} onClose={() => setCategoriesOpen(false)} />}
  </>
}

function ProductForm({ product, categories, onClose }: { product: Product | null; categories: string[]; onClose: () => void }) {
  const { businessId, upsertProducts } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [price, setPrice] = useState(product ? String(product.price) : '')
  const [cost, setCost] = useState(product ? String(product.cost) : '')
  const [vat, setVat] = useState(product ? String(product.vat_rate) : '16')
  const net = Number(price) / (1 + Number(vat) / 100)
  const margin = Number(price) > 0 && cost !== '' ? Math.round(((net - Number(cost)) / net) * 100) : null

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const text = (key: string) => String(form.get(key) || '').trim()
    const fields = {
      name: text('name'), category: text('category') || 'General', sku: text('sku') || null, barcode: text('barcode') || null,
      cost: Number(cost), price: Number(price), reorder_level: Number(form.get('reorder') || 0), vat_rate: Number(vat),
    }
    if (fields.price < fields.cost && !window.confirm('The selling price is below the cost price. Save anyway?')) { setBusy(false); return }
    const request = product
      ? supabase.from('products').update({ ...fields, active: form.get('active') === 'on' }).eq('id', product.id).eq('business_id', businessId)
      : supabase.from('products').insert({ ...fields, business_id: businessId, stock: Number(form.get('stock') || 0) })
    const { data, error: saveError } = await request.select(PRODUCT_COLUMNS).single()
    setBusy(false)
    if (saveError) { setError(friendlyError(saveError)); return }
    upsertProducts([toProduct(data)])
    onClose()
  }

  return <Modal title={product ? `Edit ${product.name}` : 'New product'} onClose={onClose}>
    <form onSubmit={submit}>
      <label>Product name<input name="name" required maxLength={120} defaultValue={product?.name} autoFocus /></label>
      <div className="form-pair">
        <label>Category<input name="category" list="category-options" maxLength={60} defaultValue={product?.category || ''} placeholder="General" /></label>
        <label>VAT rate<select value={vat} onChange={e => setVat(e.target.value)}><option value="16">16% (standard)</option><option value="8">8% (fuel)</option><option value="0">0% / exempt</option></select></label>
      </div>
      <datalist id="category-options">{categories.map(c => <option key={c} value={c} />)}</datalist>
      <div className="form-pair">
        <label>SKU<input name="sku" maxLength={60} defaultValue={product?.sku || ''} /></label>
        <label>Barcode<input name="barcode" maxLength={60} inputMode="numeric" defaultValue={product?.barcode || ''} /></label>
      </div>
      <div className="form-pair">
        <label>Cost price (KSh)<input type="number" min="0" step="0.01" required value={cost} onChange={e => setCost(e.target.value)} /></label>
        <label>Selling price (KSh, incl. VAT)<input type="number" min="0" step="0.01" required value={price} onChange={e => setPrice(e.target.value)} /></label>
      </div>
      {margin !== null && <p className={`hint ${margin < 0 ? 'bad' : ''}`}>Gross margin {margin}% · profit {money(net - Number(cost))} per unit before expenses</p>}
      <div className="form-pair">
        {!product && <label>Opening stock<input name="stock" type="number" min="0" step="0.001" defaultValue="0" required /></label>}
        <label>Low-stock alert at<input name="reorder" type="number" min="0" step="0.001" defaultValue={product?.reorder_level ?? 5} required /></label>
      </div>
      {product && <>
        <p className="hint">Current stock: <strong>{qty(product.stock)}</strong>. Use <em>Adjust</em> or record a purchase to change stock — every change is kept in the audit trail.</p>
        <label className="check"><input type="checkbox" name="active" defaultChecked={product.active} /> Active (show at the till)</label>
      </>}
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Saving…' : 'Save product'}</button>
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

  return <Modal title={`Adjust stock — ${product.name}`} onClose={onClose}>
    <form onSubmit={submit}>
      <p className="hint">Current stock: <strong>{qty(product.stock)}</strong>. For deliveries from suppliers, use <em>Suppliers → Record purchase</em> so cost prices update.</p>
      <div className="segmented" role="radiogroup">
        <button type="button" role="radio" aria-checked={direction === 'remove'} className={direction === 'remove' ? 'active' : ''} onClick={() => setDirection('remove')}>Remove stock</button>
        <button type="button" role="radio" aria-checked={direction === 'add'} className={direction === 'add' ? 'active' : ''} onClick={() => setDirection('add')}>Add stock</button>
      </div>
      <label>Quantity<input type="number" min="0.001" step="0.001" required value={amount} onChange={e => setAmount(e.target.value)} autoFocus /></label>
      <label>Reason<select name="reason" required defaultValue={direction === 'add' ? 'count_correction' : 'damaged'}>{ADJUST_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label>Note (optional)<input name="note" maxLength={300} /></label>
      {amount && <p className="hint">New stock will be <strong>{qty(product.stock + change)}</strong></p>}
      <ErrorNotice message={error} />
      <button className="button" disabled={busy || !Number(amount)}>{busy ? 'Saving…' : 'Save adjustment'}</button>
    </form>
  </Modal>
}

const movementLabel = (m: Movement) => m.movement_type === 'adjustment' ? `Adjustment · ${titleCase(m.reason || 'other')}` : titleCase(m.movement_type)

function ProductHistory({ product, onClose }: { product: Product; onClose: () => void }) {
  const { businessId, staffName } = useAccount()
  const [rows, setRows] = useState<Movement[] | null>(null), [error, setError] = useState('')
  useEffect(() => {
    supabase.from('stock_movements').select('id,product_id,movement_type,reason,quantity,stock_after,unit_cost,note,created_by,created_at')
      .eq('business_id', businessId).eq('product_id', product.id).order('created_at', { ascending: false }).limit(100)
      .then(({ data, error: loadError }) => { if (loadError) setError(friendlyError(loadError)); else setRows(data as Movement[]) })
  }, [businessId, product.id])
  return <Modal title={`Stock history — ${product.name}`} onClose={onClose} wide>
    <ErrorNotice message={error} />
    {!rows && !error ? <Loading /> : rows && rows.length === 0 ? <Empty title="No stock movements yet" /> : rows &&
      <div className="table-wrap"><table className="data-table compact">
        <thead><tr><th>When</th><th>Type</th><th className="num">Change</th><th className="num">Balance</th><th>By</th></tr></thead>
        <tbody>{rows.map(m => <tr key={m.id}>
          <td data-label="When">{dateTime(m.created_at)}</td>
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
      <option value="all">All movements</option><option value="sale">Sales</option><option value="purchase">Purchases</option><option value="adjustment">Adjustments</option><option value="void">Voids</option><option value="opening">Opening stock</option>
    </select></div>
    <ErrorNotice message={error} onRetry={load} />
    {!rows && !error ? <Loading /> : rows && rows.length === 0 ? <Empty title="No stock movements yet" /> : rows && <>
      <div className="table-wrap"><table className="data-table compact">
        <thead><tr><th>When</th><th>Product</th><th>Type</th><th className="num">Change</th><th className="num">Balance</th><th>By</th></tr></thead>
        <tbody>{rows.slice(0, size).map(m => <tr key={m.id}>
          <td data-label="When">{dateTime(m.created_at)}</td>
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

function Categories({ products, onClose }: { products: Product[]; onClose: () => void }) {
  const { businessId, reloadProducts } = useAccount()
  const [error, setError] = useState(''), [busy, setBusy] = useState('')
  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const p of products) map.set(p.category, (map.get(p.category) || 0) + 1)
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [products])

  async function rename(from: string) {
    const to = window.prompt(`Rename category “${from}” to:`, from)?.trim()
    if (!to || to === from) return
    if (to.length > 60) { setError('Category names can be at most 60 characters.'); return }
    setBusy(from); setError('')
    const { error: updateError } = await supabase.from('products').update({ category: to }).eq('business_id', businessId).eq('category', from)
    setBusy('')
    if (updateError) setError(friendlyError(updateError)); else reloadProducts()
  }

  return <Modal title="Categories" onClose={onClose}>
    <p className="hint">Categories group products at the till. Create one by typing a new name on a product. Renaming moves every product in it.</p>
    <ErrorNotice message={error} />
    {counts.length === 0 ? <Empty title="No categories yet" /> : <ul className="simple-list">{counts.map(([name, count]) => <li key={name}>
      <span><strong>{name}</strong><small>{count} product{count === 1 ? '' : 's'}</small></span>
      <button type="button" className="button secondary small" disabled={!!busy} onClick={() => rename(name)}>{busy === name ? 'Saving…' : 'Rename'}</button>
    </li>)}</ul>}
  </Modal>
}
