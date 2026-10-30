import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Product, useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { friendlyError, money, newReference, qty } from '../lib/format'
import { ReceiptData, ReceiptView } from '../components/Receipt'
import { Loading } from '../components/ui'

type CartItem = { product: Product; quantity: number }
type CustomerOption = { id: string; name: string; phone: string | null; balance: number; credit_limit: number }

const iconFor = (category: string) =>
  ({ food: '🍲', drinks: '🥤', beverages: '🥤', grocery: '🛒', groceries: '🛒', bread: '🍞', bakery: '🍞', milk: '🥛', dairy: '🥛', household: '🧴', snacks: '🍪', hardware: '🔧', stationery: '✏️', general: '📦' } as Record<string, string>)[category.toLowerCase()] || '📦'

export default function POS() {
  const { businessId, business, role, products, productsLoaded, productsError, reloadProducts, upsertProducts, user } = useAccount()
  const [cart, setCart] = useState<CartItem[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [payment, setPayment] = useState<'cash' | 'mpesa' | 'credit'>('cash')
  const [reference, setReference] = useState('')
  const [customer, setCustomer] = useState<CustomerOption | null>(null)
  const [pickCustomer, setPickCustomer] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showCart, setShowCart] = useState(false)
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const saleReference = useRef<string | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  // Any change to what is being sold means a new sale attempt (new idempotency key).
  useEffect(() => { saleReference.current = null }, [cart, payment, customer, reference])

  const active = useMemo(() => products.filter(p => p.active), [products])
  const categories = useMemo(() => ['All', ...[...new Set(active.map(p => p.category || 'General'))].sort()], [active])
  const term = search.trim().toLowerCase()
  const filtered = active.filter(p => (category === 'All' || p.category === category)
    && (!term || p.name.toLowerCase().includes(term) || p.sku?.toLowerCase() === term || p.barcode === term))
  const total = cart.reduce((sum, item) => sum + Math.round(item.product.price * item.quantity * 100) / 100, 0)
  const count = cart.reduce((sum, item) => sum + item.quantity, 0)

  function add(product: Product) {
    const live = products.find(p => p.id === product.id) || product
    if (live.stock <= 0) { setError(`${live.name} is out of stock`); return }
    setError('')
    setCart(current => {
      const existing = current.find(item => item.product.id === live.id)
      if (existing) {
        if (existing.quantity + 1 > live.stock) { setError(`Only ${qty(live.stock)} ${live.name} in stock`); return current }
        return current.map(item => item.product.id === live.id ? { product: live, quantity: item.quantity + 1 } : item)
      }
      return [...current, { product: live, quantity: 1 }]
    })
  }

  function setQuantity(id: string, value: number) {
    setCart(current => current.flatMap(item => {
      if (item.product.id !== id) return [item]
      if (!Number.isFinite(value) || value <= 0) return []
      return [{ ...item, quantity: Math.min(Math.round(value * 1000) / 1000, item.product.stock) }]
    }))
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || !term) return
    const exact = active.find(p => p.barcode === search.trim() || p.sku?.toLowerCase() === term)
    const only = filtered.length === 1 ? filtered[0] : null
    const match = exact || only
    if (match) { add(match); setSearch('') }
  }

  async function completeSale() {
    if (!cart.length || busy) return
    if (payment === 'credit' && !customer) { setPickCustomer(true); return }
    setBusy(true); setError('')
    saleReference.current ||= newReference()
    const sold = cart.map(item => ({ ...item }))
    const { data, error: saleError } = await supabase.rpc('complete_pos_sale', {
      target_business_id: businessId,
      chosen_payment_method: payment,
      cart_items: cart.map(item => ({ product_id: item.product.id, quantity: item.quantity })),
      client_reference: saleReference.current,
      target_customer_id: customer?.id || null,
      payment_reference: payment === 'mpesa' && reference.trim() ? reference.trim() : null,
    })
    setBusy(false)
    if (saleError) {
      setError(friendlyError(saleError, 'The sale was not saved. Please try again.'))
      if (/stock|available/i.test(saleError.message)) reloadProducts()
      return
    }
    const result = Array.isArray(data) ? data[0] : data
    // Reflect the new stock immediately; Realtime confirms it moments later.
    if (!result?.already_recorded) upsertProducts(sold.map(item => ({ ...item.product, stock: item.product.stock - item.quantity })))
    setReceipt({
      number: result?.receipt_number || '—', soldAt: new Date().toISOString(), payment, total: Number(result?.total ?? total),
      vat: sold.reduce((sum, item) => { const line = item.product.price * item.quantity; return sum + line * item.product.vat_rate / (100 + item.product.vat_rate) }, 0),
      items: sold.map(item => ({ name: item.product.name, quantity: item.quantity, unitPrice: item.product.price, lineTotal: Math.round(item.product.price * item.quantity * 100) / 100 })),
      cashier: String(user.user_metadata?.full_name || user.email || ''), customer: customer?.name, paymentReference: payment === 'mpesa' ? reference.trim() || null : null,
    })
    setCart([]); setReference(''); setCustomer(null); setPayment('cash'); setShowCart(false)
    searchInput.current?.focus()
  }

  return <div className="pos-shell">
    <section className="pos-products">
      <header className="pos-header">
        <div><strong>Sell</strong><span>{business.name}</span></div>
        <div className="pos-actions">
          {can(role, 'editStock') && <Link to="/app/inventory?new=1">+ Product</Link>}
          <button type="button" className="mobile-cart" onClick={() => setShowCart(true)}>Cart ({qty(count)}) · {money(total)}</button>
        </div>
      </header>
      <div className="category-strip">{categories.map(item =>
        <button type="button" className={category === item ? 'active' : ''} onClick={() => setCategory(item)} key={item}>{item}</button>)}</div>
      <div className="product-search">
        <input ref={searchInput} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={onSearchKey}
          placeholder="Search, or scan a barcode and press Enter" aria-label="Search products" autoComplete="off" />
      </div>
      {error && <div className="pos-error" role="alert">{error}</div>}
      {productsError && <div className="pos-error" role="alert">{productsError} <button type="button" className="link-button" onClick={reloadProducts}>Retry</button></div>}
      {!productsLoaded && !productsError ? <Loading label="Loading products…" /> :
        <div className="product-grid">{filtered.map(product =>
          <button type="button" key={product.id} disabled={product.stock <= 0}
            className={`product-tile ${product.stock > 0 && product.is_low_stock ? 'low' : ''}`} onClick={() => add(product)}>
            <span className="product-icon" aria-hidden="true">{iconFor(product.category)}</span>
            <strong>{product.name}</strong><b>{money(product.price)}</b>
            <small>{product.stock <= 0 ? 'Out of stock' : `${qty(product.stock)} in stock`}</small>
          </button>)}
        </div>}
      {productsLoaded && !active.length && <div className="empty-products"><h2>No products yet</h2>
        {can(role, 'editStock') ? <><p>Add your first product to begin selling.</p><Link className="button" to="/app/inventory?new=1">Add product</Link></> : <p>Ask the owner or stock manager to add products.</p>}</div>}
      {productsLoaded && active.length > 0 && !filtered.length && <div className="empty-products"><p>No products match “{search}”.</p></div>}
    </section>

    <aside className={`pos-cart ${showCart ? 'show' : ''}`} aria-label="Current sale">
      <div className="cart-title"><h2>Current sale</h2><button type="button" aria-label="Close cart" onClick={() => setShowCart(false)}>×</button></div>
      <div className="cart-list">{cart.length === 0
        ? <div className="empty-cart"><span aria-hidden="true">🛒</span><p>Tap a product to add it here.</p></div>
        : cart.map(item => <div className="cart-line" key={item.product.id}>
          <div><strong>{item.product.name}</strong><small>{money(item.product.price)} each</small></div>
          <div className="quantity">
            <button type="button" aria-label={`Remove one ${item.product.name}`} onClick={() => setQuantity(item.product.id, item.quantity - 1)}>−</button>
            <input type="number" inputMode="decimal" min="0" step="any" aria-label={`Quantity of ${item.product.name}`} value={item.quantity}
              onChange={event => setQuantity(item.product.id, Number(event.target.value))} />
            <button type="button" aria-label={`Add one ${item.product.name}`} disabled={item.quantity >= item.product.stock} onClick={() => setQuantity(item.product.id, item.quantity + 1)}>+</button>
          </div>
          <b>{money(item.product.price * item.quantity)}</b>
        </div>)}
      </div>
      <div className="cart-footer">
        <div className="sale-total"><span>Total</span><strong>{money(total)}</strong></div>
        <div className="payment-options" role="radiogroup" aria-label="Payment method">{(['cash', 'mpesa', 'credit'] as const).map(method =>
          <button type="button" role="radio" aria-checked={payment === method} className={payment === method ? 'active' : ''} onClick={() => setPayment(method)} key={method}>
            {method === 'cash' ? '💵 Cash' : method === 'mpesa' ? '📱 M-Pesa' : '📝 Credit'}</button>)}
        </div>
        {payment === 'mpesa' && <input className="cart-field" value={reference} maxLength={40} onChange={event => setReference(event.target.value.toUpperCase())} placeholder="M-Pesa code (optional)" aria-label="M-Pesa transaction code" />}
        <button type="button" className={`customer-pick ${payment === 'credit' && !customer ? 'required' : ''}`} onClick={() => setPickCustomer(true)}>
          {customer ? <>👤 {customer.name} · owes {money(customer.balance)} <span className="link-button" onClick={event => { event.stopPropagation(); setCustomer(null) }}>remove</span></>
            : payment === 'credit' ? '👤 Choose customer (required for credit)' : '👤 Add customer (optional)'}
        </button>
        <div className="checkout-actions">
          <button type="button" onClick={() => { setCart([]); setError('') }} disabled={!cart.length || busy}>Clear</button>
          <button type="button" className="complete-sale" disabled={!cart.length || busy} onClick={completeSale}>{busy ? 'Saving…' : `Complete sale`}</button>
        </div>
      </div>
    </aside>

    {pickCustomer && <CustomerPicker onClose={() => setPickCustomer(false)} onPick={picked => { setCustomer(picked); setPickCustomer(false) }} />}
    {receipt && <ReceiptView business={business} receipt={receipt} onClose={() => setReceipt(null)} />}
  </div>
}

function CustomerPicker({ onPick, onClose }: { onPick: (customer: CustomerOption) => void; onClose: () => void }) {
  const { businessId } = useAccount()
  const [term, setTerm] = useState('')
  const [rows, setRows] = useState<CustomerOption[]>([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(async () => {
      setLoading(true)
      let query = supabase.from('customer_balances').select('id,name,phone,balance,credit_limit')
        .eq('business_id', businessId).eq('active', true).order('name').limit(30)
      const clean = term.trim().replace(/[%,()]/g, '')
      if (clean) query = query.or(`name.ilike.%${clean}%,phone.ilike.%${clean}%`)
      const { data, error: loadError } = await query
      if (cancelled) return
      if (loadError) setError(friendlyError(loadError))
      setRows((data || []).map(row => ({ ...row, balance: Number(row.balance), credit_limit: Number(row.credit_limit) })))
      setLoading(false)
    }, 250)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [businessId, term])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    const form = new FormData(event.currentTarget)
    const { data, error: insertError } = await supabase.from('customers').insert({
      business_id: businessId, name: String(form.get('name')).trim(), phone: String(form.get('phone') || '').trim() || null,
      credit_limit: Number(form.get('limit') || 0),
    }).select('id,name,phone,credit_limit').single()
    if (insertError) { setError(friendlyError(insertError)); return }
    onPick({ ...data, balance: 0, credit_limit: Number(data.credit_limit) })
  }

  return <div className="pos-modal"><section className="stock-form">
    <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>×</button>
    <h2>{creating ? 'New customer' : 'Choose customer'}</h2>
    {error && <div className="pos-error">{error}</div>}
    {creating ? <form onSubmit={create}>
      <label>Name<input name="name" required maxLength={120} autoFocus /></label>
      <label>Phone<input name="phone" type="tel" maxLength={30} /></label>
      <label>Credit limit (0 = no limit)<input name="limit" type="number" min="0" step="1" defaultValue="0" /></label>
      <button className="save-stock">Save and select</button>
      <button type="button" className="text-button" onClick={() => setCreating(false)}>Back to list</button>
    </form> : <>
      <input autoFocus value={term} onChange={event => setTerm(event.target.value)} placeholder="Search name or phone" aria-label="Search customers" />
      <div className="picker-list">{loading ? <Loading /> : rows.length === 0 ? <p className="muted">No customers found.</p> :
        rows.map(row => <button type="button" key={row.id} onClick={() => onPick(row)}>
          <span><strong>{row.name}</strong><small>{row.phone || 'No phone'}</small></span>
          <span className={row.balance > 0 ? 'owed' : ''}>{row.balance > 0 ? `Owes ${money(row.balance)}` : 'No balance'}</span>
        </button>)}</div>
      <button type="button" className="save-stock" onClick={() => setCreating(true)}>+ New customer</button>
    </>}
  </section></div>
}
