import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { businessToday, friendlyError, money, qty } from '../lib/format'
import { Empty, ErrorNotice, PageHeader } from '../components/ui'

type PromoType = '' | 'PERCENTAGE_DISCOUNT' | 'FLAT_PRODUCT' | 'TWO_FOR_ONE'
type Row = { selected: boolean; price: string; stock: string; promo: PromoType; promoId: string; promoValue: string }
const HEADERS = ['store_id', 'product_id', 'price', 'stock', 'promotion_id', 'percentage', 'discounted_price', 'two_for_one', 'promotion_start_date', 'promotion_end_date', 'enabled']
const DRAFT_KEY = 'radari.glovoDraft'

export default function Glovo() {
  const { businessId, business, products, reloadAccount } = useAccount()
  const [storeId, setStoreId] = useState(business.glovo_store_id || '')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<Record<string, Row>>(() => { try { return JSON.parse(window.localStorage.getItem(DRAFT_KEY) || '{}') } catch { return {} } })
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [preview, setPreview] = useState<string[][] | null>(null)
  const [error, setError] = useState('')
  const active = useMemo(() => products.filter(p => p.active), [products])
  const term = search.trim().toLowerCase()
  const shown = active.filter(p => !term || p.name.toLowerCase().includes(term) || p.sku?.toLowerCase().includes(term))
  const row = (id: string): Row => rows[id] || { selected: false, price: '', stock: '', promo: '', promoId: '', promoValue: '' }
  const update = (id: string, change: Partial<Row>) => setRows(current => {
    const next = { ...current, [id]: { ...row(id), ...change } }
    try { window.localStorage.setItem(DRAFT_KEY, JSON.stringify(next)) } catch { /* storage unavailable */ }
    return next
  })
  const selected = active.filter(p => row(p.id).selected)
  const anyPromo = selected.some(p => row(p.id).promo)
  const formatDate = (d: string) => d ? d.split('-').reverse().join('/') : ''

  function build(): string[][] | null {
    setError('')
    if (!storeId.trim()) { setError('Enter your Glovo store ID first.'); return null }
    if (!selected.length) { setError('Select at least one product.'); return null }
    for (const p of selected) {
      const r = row(p.id)
      if (r.promo && !r.promoId.trim()) { setError(`Enter a promotion ID for ${p.name}.`); return null }
      if ((r.promo === 'PERCENTAGE_DISCOUNT' || r.promo === 'FLAT_PRODUCT') && !(Number(r.promoValue) > 0)) { setError(`Enter the discount for ${p.name}.`); return null }
    }
    const startDate = formatDate(start || businessToday()), endDate = formatDate(end || start || businessToday())
    return [HEADERS, ...selected.map(p => {
      const r = row(p.id)
      return [storeId.trim(), p.sku || p.id, (r.price ? Number(r.price) : p.price).toFixed(2), r.stock !== '' ? String(Math.max(0, Math.floor(Number(r.stock)))) : String(Math.max(0, Math.floor(p.stock))),
        r.promo ? r.promoId.trim() : '', r.promo === 'PERCENTAGE_DISCOUNT' ? Number(r.promoValue).toFixed(2) : '', r.promo === 'FLAT_PRODUCT' ? Number(r.promoValue).toFixed(2) : '',
        r.promo === 'TWO_FOR_ONE' ? '1' : '', r.promo ? startDate : '', r.promo ? endDate : '', r.promo ? (enabled ? 'true' : 'false') : '']
    })]
  }

  async function download() {
    const table = build()
    if (!table) return
    if (storeId.trim() !== (business.glovo_store_id || '')) {
      const { error: saveError } = await supabase.from('businesses').update({ glovo_store_id: storeId.trim() }).eq('id', businessId)
      if (saveError) setError(friendlyError(saveError)); else reloadAccount()
    }
    const csv = table.map(r => r.map(v => v.includes(',') ? `"${v}"` : v).join(',')).join('\n')
    const link = document.createElement('a')
    link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    link.download = `Glovo_${storeId.trim()}_${businessToday()}.csv`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
  }

  return <>
    <PageHeader title="Glovo export" subtitle="Build the daily inventory file to upload to your Glovo SFTP folder (Input_<partner_name>/)" actions={<>
      <button type="button" className="button secondary" onClick={() => { const t = build(); if (t) setPreview(t.slice(0, 11)) }}>Preview</button>
      <button type="button" className="button" onClick={download}>Download CSV</button></>} />
    <ErrorNotice message={error} />
    <div className="panel"><div className="form-row">
      <label>Glovo store ID<input value={storeId} onChange={e => setStoreId(e.target.value)} maxLength={60} placeholder="Provided in your Glovo onboarding email" /></label>
      <label>Promotion start<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
      <label>Promotion end<input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label>
      <label>Promotion status<select value={enabled ? 'on' : 'off'} onChange={e => setEnabled(e.target.value === 'on')}><option value="on">Active</option><option value="off">Paused</option></select></label>
    </div>
      <p className="hint">Promotion dates apply to every product with a promotion. Leave them blank for today only. Price and stock overrides are optional; blank uses the Radari price and stock.</p>
    </div>
    <div className="toolbar">
      <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products" aria-label="Search products" />
      <span className="muted">{selected.length} selected{anyPromo ? ', with promotions' : ''}</span>
      <button type="button" className="button secondary small" onClick={() => shown.forEach(p => update(p.id, { selected: true }))}>Select all shown</button>
      <button type="button" className="button secondary small" onClick={() => active.forEach(p => row(p.id).selected && update(p.id, { selected: false }))}>Clear</button>
    </div>
    {shown.length === 0 ? <Empty title="No products" /> :
      <div className="table-wrap"><table className="data-table compact">
        <thead><tr><th aria-label="Select" /><th>Product</th><th className="num">Radari price</th><th className="num">Radari stock</th><th>Glovo price</th><th>Glovo stock</th><th>Promotion</th><th>Promo ID</th><th>Discount</th></tr></thead>
        <tbody>{shown.map(p => { const r = row(p.id); return <tr key={p.id} className={r.selected ? 'row-selected' : ''}>
          <td><input type="checkbox" checked={r.selected} onChange={e => update(p.id, { selected: e.target.checked })} aria-label={`Select ${p.name}`} /></td>
          <td data-label="Product"><strong>{p.name}</strong><small>{p.sku ? `SKU ${p.sku}` : 'No SKU: the Radari ID is used'}</small></td>
          <td data-label="Radari price" className="num">{money(p.price)}</td><td data-label="Radari stock" className="num">{qty(p.stock)}</td>
          <td data-label="Glovo price"><input type="number" min="0" step="0.01" value={r.price} placeholder="Same" onChange={e => update(p.id, { price: e.target.value })} style={{ width: 100 }} /></td>
          <td data-label="Glovo stock"><input type="number" min="0" step="1" value={r.stock} placeholder="Same" onChange={e => update(p.id, { stock: e.target.value })} style={{ width: 80 }} /></td>
          <td data-label="Promotion"><select value={r.promo} onChange={e => update(p.id, { promo: e.target.value as PromoType, selected: true })}><option value="">None</option><option value="PERCENTAGE_DISCOUNT">Percentage off</option><option value="FLAT_PRODUCT">Fixed promo price</option><option value="TWO_FOR_ONE">Buy one get one free</option></select></td>
          <td data-label="Promo ID"><input value={r.promoId} disabled={!r.promo} onChange={e => update(p.id, { promoId: e.target.value })} placeholder="promo_001" style={{ width: 110 }} /></td>
          <td data-label="Discount"><input type="number" min="0" step="0.01" value={r.promoValue} disabled={r.promo !== 'PERCENTAGE_DISCOUNT' && r.promo !== 'FLAT_PRODUCT'} placeholder={r.promo === 'PERCENTAGE_DISCOUNT' ? '%' : r.promo === 'FLAT_PRODUCT' ? 'KSh' : '-'} onChange={e => update(p.id, { promoValue: e.target.value })} style={{ width: 90 }} /></td>
        </tr> })}</tbody>
      </table></div>}
    {preview && <section className="panel" style={{ marginTop: 16 }}><div className="panel-head"><h2>Preview (first 10 rows)</h2><button type="button" className="button secondary small" onClick={() => setPreview(null)}>Close</button></div>
      <div className="table-wrap"><table className="data-table compact"><thead><tr>{preview[0].map(h => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{preview.slice(1).map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} data-label={preview[0][j]}>{v || '-'}</td>)}</tr>)}</tbody></table></div></section>}
  </>
}
