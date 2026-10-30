import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { canServe, Product, useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { businessToday, friendlyError, money, newReference, paymentLabel, qty } from '../lib/format'
import { ReceiptData, ReceiptView } from '../components/Receipt'
import { Loading, Modal } from '../components/ui'

type Mode = 'unit' | 'serving'
type CartItem = { key: string; product: Product; mode: Mode; quantity: number; price: number }
type CustomerOption = { id: string; name: string; phone: string | null; balance: number; credit_limit: number; loyalty_points: number }
type Method = 'cash' | 'mpesa' | 'card' | 'credit' | 'split'
type Split = { cash: string; mpesa: string; card: string; credit: string }
const round2 = (n: number) => Math.round(n * 100) / 100
const basePrice = (p: Product, mode: Mode) => mode === 'serving' ? Number(p.serving_price || 0) : p.price
const stockUse = (p: Product, mode: Mode, quantity: number) => mode === 'serving' ? quantity * Number(p.serving_ml) / Number(p.container_ml) : quantity

export default function POS() {
  const { businessId, business, role, products, productsLoaded, productsError, reloadProducts, upsertProducts, user } = useAccount()
  const [cart, setCart] = useState<CartItem[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [method, setMethod] = useState<Method>('cash')
  const [tendered, setTendered] = useState('')
  const [reference, setReference] = useState('')
  const [split, setSplit] = useState<Split>({ cash: '', mpesa: '', card: '', credit: '' })
  const [dueDate, setDueDate] = useState('')
  const [customer, setCustomer] = useState<CustomerOption | null>(null)
  const [redeem, setRedeem] = useState('')
  const [pickCustomer, setPickCustomer] = useState(false)
  const [choose, setChoose] = useState<Product | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showCart, setShowCart] = useState(false)
  const [receipt, setReceipt] = useState<ReceiptData | null>(null)
  const [lastSale, setLastSale] = useState<{ id: string; number: string; at: number } | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [switching, setSwitching] = useState(false)
  const saleReference = useRef<string | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)

  useEffect(() => { saleReference.current = null }, [cart, method, customer, reference, split, redeem, dueDate])

  const active = useMemo(() => products.filter(p => p.active), [products])
  const categories = useMemo(() => ['All', ...[...new Set(active.map(p => p.category || 'General'))].sort()], [active])
  const term = search.trim().toLowerCase()
  const filtered = active.filter(p => (category === 'All' || p.category === category)
    && (!term || p.name.toLowerCase().includes(term) || p.sku?.toLowerCase() === term || p.barcode === term))
  const floorPct = (p: Product) => p.min_price_percent ?? Number(business.min_price_percent || 0)

  const subtotal = round2(cart.reduce((sum, item) => sum + round2(item.price * item.quantity), 0))
  const saved = round2(cart.reduce((sum, item) => sum + round2((basePrice(item.product, item.mode) - item.price) * item.quantity), 0))
  const vatRaw = cart.reduce((sum, item) => { const line = item.price * item.quantity; return sum + line * item.product.vat_rate / (100 + item.product.vat_rate) }, 0)
  const points = Math.max(0, Math.floor(Number(redeem || 0)))
  const loyaltyDiscount = business.loyalty_enabled && customer ? round2(points * Number(business.loyalty_point_value)) : 0
  const total = round2(subtotal - loyaltyDiscount)
  const vat = subtotal > 0 ? round2(vatRaw * total / subtotal) : 0
  const count = cart.reduce((sum, item) => sum + item.quantity, 0)
  const splitTotal = round2(Object.values(split).reduce((sum, v) => sum + Number(v || 0), 0))
  const usesCredit = method === 'credit' || (method === 'split' && Number(split.credit) > 0)
  const change = method === 'cash' && Number(tendered) > total ? round2(Number(tendered) - total) : 0

  function stockLeft(product: Product, excludeKey?: string) {
    const used = cart.filter(i => i.product.id === product.id && i.key !== excludeKey).reduce((s, i) => s + stockUse(i.product, i.mode, i.quantity), 0)
    return product.stock - used
  }

  function add(product: Product, mode: Mode) {
    const live = products.find(p => p.id === product.id) || product
    const key = `${live.id}:${mode}`
    const existing = cart.find(i => i.key === key)
    const need = stockUse(live, mode, 1)
    if (stockLeft(live) < need - 1e-9) { setError(`Not enough ${live.name} in stock`); return }
    setError('')
    setCart(current => existing
      ? current.map(i => i.key === key ? { ...i, product: live, quantity: i.quantity + 1 } : i)
      : [...current, { key, product: live, mode, quantity: 1, price: basePrice(live, mode) }])
  }

  function tap(product: Product) {
    if (product.stock <= 0) return
    if (canServe(product)) setChoose(product)
    else add(product, 'unit')
  }

  function setQuantity(key: string, value: number) {
    setCart(current => current.flatMap(item => {
      if (item.key !== key) return [item]
      if (!Number.isFinite(value) || value <= 0) return []
      const per = stockUse(item.product, item.mode, 1)
      const max = Math.floor((stockLeft(item.product, key) / per) * 1000) / 1000
      return [{ ...item, quantity: Math.min(Math.round(value * 1000) / 1000, max) }]
    }))
  }

  function setPrice(key: string, value: string) {
    setCart(current => current.map(item => item.key === key ? { ...item, price: value === '' ? 0 : Math.max(0, Number(value)) } : item))
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || !term) return
    const exact = active.find(p => p.barcode === search.trim() || p.sku?.toLowerCase() === term)
    const match = exact || (filtered.length === 1 ? filtered[0] : null)
    if (match) { add(match, 'unit'); setSearch('') }
  }

  function fillSplit(field: keyof Split) {
    const others = (Object.keys(split) as (keyof Split)[]).filter(k => k !== field).reduce((s, k) => s + Number(split[k] || 0), 0)
    setSplit({ ...split, [field]: String(Math.max(0, round2(total - others))) })
  }

  function validate(): string | null {
    for (const item of cart) {
      const base = basePrice(item.product, item.mode)
      const floor = round2(base * floorPct(item.product) / 100)
      if (item.price > base) return `${item.product.name}: the price cannot be higher than ${money(base)}`
      if (item.price < floor) return `${item.product.name} cannot be sold below ${money(floor)}`
    }
    if (points > 0 && !customer) return 'Choose the customer who is redeeming points'
    if (customer && points > customer.loyalty_points) return `${customer.name} has only ${customer.loyalty_points} points`
    if (loyaltyDiscount > subtotal) return 'The points are worth more than this sale'
    if (method === 'split' && splitTotal !== total) return `The payment parts add up to ${money(splitTotal)}, but the total is ${money(total)}`
    if (usesCredit && !customer) return 'Choose a customer for the credit part of this sale'
    if (method === 'cash' && tendered && Number(tendered) < total) return 'Cash received is less than the total'
    return null
  }

  async function completeSale() {
    if (!cart.length || busy) return
    const problem = validate()
    if (problem) { setError(problem); if (/customer/i.test(problem)) setPickCustomer(true); return }
    setBusy(true); setError('')
    saleReference.current ||= newReference()
    const sold = cart.map(item => ({ ...item }))
    const paymentLines = method === 'split'
      ? (Object.keys(split) as (keyof Split)[]).filter(k => Number(split[k]) > 0).map(k => ({ method: k, amount: round2(Number(split[k])), reference: k === 'mpesa' ? reference.trim() || null : null }))
      : null
    const { data, error: saleError } = await supabase.rpc('complete_pos_sale', {
      target_business_id: businessId,
      chosen_payment_method: method === 'split' ? 'cash' : method,
      cart_items: cart.map(item => ({ product_id: item.product.id, quantity: item.quantity, mode: item.mode,
        unit_price: item.price !== basePrice(item.product, item.mode) ? round2(item.price) : null })),
      client_reference: saleReference.current,
      target_customer_id: customer?.id || null,
      payment_reference: (method === 'mpesa' || method === 'card') && reference.trim() ? reference.trim() : null,
      payment_lines: paymentLines,
      credit_due_date: usesCredit && dueDate ? dueDate : null,
      redeem_points: business.loyalty_enabled && customer ? points : 0,
    })
    setBusy(false)
    if (saleError) {
      setError(friendlyError(saleError, 'The sale was not saved. Please try again.'))
      if (/stock|available/i.test(saleError.message)) reloadProducts()
      return
    }
    const result = Array.isArray(data) ? data[0] : data
    if (!result?.already_recorded) {
      const used = new Map<string, number>()
      for (const item of sold) used.set(item.product.id, (used.get(item.product.id) || 0) + stockUse(item.product, item.mode, item.quantity))
      upsertProducts([...used.entries()].map(([id, amount]) => { const p = sold.find(i => i.product.id === id)!.product; const stock = Math.round((p.stock - amount) * 1000) / 1000; return { ...p, stock, is_low_stock: stock <= p.reorder_level } }))
    }
    setLastSale({ id: result.sale_id, number: result.receipt_number, at: Date.now() })
    setReceipt({
      number: result?.receipt_number || '', soldAt: new Date().toISOString(), payment: method, total: Number(result?.total ?? total), vat,
      items: sold.map(item => ({ name: item.mode === 'serving' ? `${item.product.name} (serving)` : item.product.name, quantity: item.quantity, unitPrice: item.price, lineTotal: round2(item.price * item.quantity), listPrice: basePrice(item.product, item.mode) })),
      payments: paymentLines || (total > 0 ? [{ method, amount: total, reference: (method === 'mpesa' || method === 'card') ? reference.trim() || null : null }] : []),
      discount: saved, loyaltyDiscount, pointsRedeemed: points, tendered: method === 'cash' && tendered ? Number(tendered) : null,
      creditDueDate: usesCredit && dueDate ? dueDate : null,
      cashier: String(user.user_metadata?.full_name || user.email || ''), customer: customer?.name,
    })
    setCart([]); setReference(''); setTendered(''); setCustomer(null); setRedeem(''); setDueDate('')
    setSplit({ cash: '', mpesa: '', card: '', credit: '' }); setMethod('cash'); setShowCart(false)
    searchInput.current?.focus()
  }

  const mpesaLines = [
    business.mpesa_till && ['Buy Goods till', business.mpesa_till],
    business.mpesa_paybill && ['Paybill', `${business.mpesa_paybill}${business.mpesa_account ? `, account ${business.mpesa_account}` : ''}`],
    business.mpesa_pochi && ['Pochi la Biashara', business.mpesa_pochi],
    business.mpesa_send_money && ['Send money to', business.mpesa_send_money],
  ].filter(Boolean) as [string, string][]
  const canCancel = lastSale && Date.now() - lastSale.at < 15 * 60 * 1000

  return <div className="pos-shell">
    <section className="pos-products">
      <header className="pos-header">
        <div><strong>Point of sale</strong><span>{business.name}</span></div>
        <div className="pos-actions">
          {canCancel && <button type="button" onClick={() => setCancelling(true)}>Cancel last sale</button>}
          <button type="button" onClick={() => setSwitching(true)}>Switch user</button>
          {can(role, 'editStock') && <Link to="/app/inventory?new=1">New product</Link>}
        </div>
      </header>
      <div className="product-search">
        <input ref={searchInput} type="search" value={search} onChange={event => setSearch(event.target.value)} onKeyDown={onSearchKey}
          placeholder="Search by name, or scan a barcode and press Enter" aria-label="Search products" autoComplete="off" />
      </div>
      <div className="category-strip">{categories.map(item =>
        <button type="button" className={category === item ? 'active' : ''} onClick={() => setCategory(item)} key={item}>{item}</button>)}</div>
      {error && <div className="pos-error" role="alert">{error}</div>}
      {productsError && <div className="pos-error" role="alert">{productsError} <button type="button" className="link-button" onClick={reloadProducts}>Retry</button></div>}
      {!productsLoaded && !productsError ? <Loading label="Loading products" /> :
        <div className="product-grid">{filtered.map(product =>
          <button type="button" key={product.id} disabled={product.stock <= 0}
            className={`product-tile ${product.stock > 0 && product.is_low_stock ? 'low' : ''}`} onClick={() => tap(product)}>
            <strong>{product.name}</strong>
            <div className="tile-foot"><b>{money(product.price)}</b>
              <small>{product.stock <= 0 ? 'Out of stock' : `${qty(product.stock)} in stock${product.is_low_stock ? ', low' : ''}`}</small></div>
          </button>)}
        </div>}
      {productsLoaded && !active.length && <div className="empty-products"><p><strong>No products yet.</strong></p>
        {can(role, 'editStock') ? <Link className="button" to="/app/inventory?new=1">Add your first product</Link> : <p>Ask the owner or stock manager to add products.</p>}</div>}
      {productsLoaded && active.length > 0 && !filtered.length && <div className="empty-products"><p>No products match "{search}".</p></div>}
    </section>

    <button type="button" className="mobile-cart" onClick={() => setShowCart(true)}>View sale · {qty(count)} item{count === 1 ? '' : 's'} · {money(total)}</button>

    <aside className={`pos-cart ${showCart ? 'show' : ''}`} aria-label="Current sale">
      <div className="cart-title"><h2>Current sale</h2><button type="button" className="button secondary small" onClick={() => setShowCart(false)}>Back to products</button></div>
      <div className="cart-list">{cart.length === 0
        ? <div className="empty-cart">Tap a product to add it to the sale.</div>
        : cart.map(item => {
          const base = basePrice(item.product, item.mode)
          return <div className="cart-line" key={item.key}>
            <div className="line-name"><strong>{item.product.name}{item.mode === 'serving' ? ' (serving)' : ''}</strong>
              <small>{money(base)} each{item.price < base ? `, sold at ${money(item.price)}` : ''}</small></div>
            <div className="line-total">{money(item.price * item.quantity)}</div>
            <div className="line-controls">
              <div className="quantity">
                <button type="button" aria-label={`Remove one ${item.product.name}`} onClick={() => setQuantity(item.key, item.quantity - 1)}>-</button>
                <input type="number" inputMode="decimal" min="0" step="any" aria-label={`Quantity of ${item.product.name}`} value={item.quantity}
                  onChange={event => setQuantity(item.key, Number(event.target.value))} />
                <button type="button" aria-label={`Add one ${item.product.name}`} onClick={() => setQuantity(item.key, item.quantity + 1)}>+</button>
              </div>
              <label className="line-price">Price<input type="number" inputMode="decimal" min="0" step="0.01" value={item.price}
                onChange={event => setPrice(item.key, event.target.value)} aria-label={`Price of ${item.product.name}`} /></label>
            </div>
          </div>
        })}
      </div>
      <div className="cart-footer">
        <div className="sale-summary">
          {saved > 0 && <div><span>Discounts</span><span>-{money(saved)}</span></div>}
          {loyaltyDiscount > 0 && <div><span>Points redeemed ({points})</span><span>-{money(loyaltyDiscount)}</span></div>}
          {vat > 0 && <div><span>VAT included</span><span>{money(vat)}</span></div>}
        </div>
        <div className="sale-total"><span>Total</span><strong>{money(total)}</strong></div>
        <button type="button" className={`customer-pick ${usesCredit && !customer ? 'required' : ''}`} onClick={() => setPickCustomer(true)}>
          {customer ? <><span>{customer.name}{customer.balance > 0 ? ` · owes ${money(customer.balance)}` : ''}{business.loyalty_enabled ? ` · ${customer.loyalty_points} pts` : ''}</span>
            <span className="link-button" onClick={event => { event.stopPropagation(); setCustomer(null); setRedeem('') }}>Remove</span></>
            : <span>{usesCredit ? 'Choose customer (required for credit)' : 'Add customer (optional)'}</span>}
        </button>
        {customer && business.loyalty_enabled && customer.loyalty_points > 0 && <div className="pay-panel"><div className="pay-row"><span>Redeem</span>
          <input type="number" min="0" max={customer.loyalty_points} step="1" value={redeem} placeholder={`Up to ${customer.loyalty_points} points`} onChange={event => setRedeem(event.target.value)} aria-label="Points to redeem" /></div></div>}
        <div className="payment-options" role="radiogroup" aria-label="Payment method">{(['cash', 'mpesa', 'card', 'credit', 'split'] as Method[]).map(m =>
          <button type="button" role="radio" aria-checked={method === m} className={method === m ? 'active' : ''} onClick={() => setMethod(m)} key={m}>{paymentLabel(m)}</button>)}
        </div>
        {method === 'cash' && <div className="pay-panel"><div className="pay-row"><span>Received</span>
          <input type="number" inputMode="decimal" min="0" step="1" value={tendered} placeholder={String(total)} onChange={event => setTendered(event.target.value)} aria-label="Cash received" /></div>
          {change > 0 && <div className="pay-row"><span>Change</span><strong>{money(change)}</strong></div>}</div>}
        {(method === 'mpesa' || (method === 'split' && Number(split.mpesa) > 0)) && <div className="pay-panel">
          {mpesaLines.length ? <div className="mpesa-details">{mpesaLines.map(([label, value]) => <div key={label}>{label}: <strong>{value}</strong></div>)}
            <div>Amount: <strong>{money(method === 'split' ? Number(split.mpesa) : total)}</strong></div></div>
            : <div className="muted">Add your till or paybill in Settings to show it here.</div>}
          <div className="pay-row"><span>Code</span><input value={reference} maxLength={40} onChange={event => setReference(event.target.value.toUpperCase())} placeholder="M-Pesa confirmation code" aria-label="M-Pesa code" /></div>
        </div>}
        {method === 'card' && <div className="pay-panel"><div className="pay-row"><span>Ref</span><input value={reference} maxLength={40} onChange={event => setReference(event.target.value)} placeholder="Card slip reference (optional)" aria-label="Card reference" /></div></div>}
        {method === 'split' && <div className="pay-panel">
          {(['cash', 'mpesa', 'card', 'credit'] as (keyof Split)[]).map(k => <div className="pay-row" key={k}><span>{paymentLabel(k)}</span>
            <div style={{ display: 'flex', gap: 6 }}><input type="number" inputMode="decimal" min="0" step="0.01" value={split[k]} onChange={event => setSplit({ ...split, [k]: event.target.value })} aria-label={`${paymentLabel(k)} amount`} />
              <button type="button" className="button secondary small" onClick={() => fillSplit(k)}>Fill</button></div></div>)}
          <div className={splitTotal === total ? 'muted' : 'hint bad'}>Entered {money(splitTotal)} of {money(total)}</div>
        </div>}
        {usesCredit && <div className="pay-panel"><div className="pay-row"><span>Due date</span>
          <input type="date" min={businessToday()} value={dueDate} onChange={event => setDueDate(event.target.value)} aria-label="Credit due date" /></div></div>}
        <div className="checkout-actions">
          <button type="button" onClick={() => { setCart([]); setError('') }} disabled={!cart.length || busy}>Clear</button>
          <button type="button" className="complete-sale" disabled={!cart.length || busy} onClick={completeSale}>{busy ? 'Saving' : `Charge ${money(total)}`}</button>
        </div>
      </div>
    </aside>

    {choose && <Modal title={choose.name} onClose={() => setChoose(null)}>
      <div className="radio-cards">
        <button type="button" className="radio-card" onClick={() => { add(choose, 'serving'); setChoose(null) }}>
          <span><strong>Sell by serving · {money(choose.serving_price)}</strong><small>{choose.serving_ml} ml from the open {choose.unit.toLowerCase()}</small></span></button>
        <button type="button" className="radio-card" onClick={() => { add(choose, 'unit'); setChoose(null) }}>
          <span><strong>Sell full {choose.unit.toLowerCase()} · {money(choose.price)}</strong><small>Deducts one {choose.unit.toLowerCase()} from stock</small></span></button>
      </div>
    </Modal>}
    {pickCustomer && <CustomerPicker onClose={() => setPickCustomer(false)} onPick={picked => { setCustomer(picked); setPickCustomer(false); setError('') }} />}
    {cancelling && lastSale && <CancelLast sale={lastSale} onClose={() => setCancelling(false)} onDone={() => { setCancelling(false); setLastSale(null); reloadProducts() }} />}
    {switching && <SwitchUser onClose={() => setSwitching(false)} />}
    {receipt && <ReceiptView business={business} receipt={receipt} onClose={() => setReceipt(null)} />}
  </div>
}

function CancelLast({ sale, onClose, onDone }: { sale: { id: string; number: string }; onClose: () => void; onDone: () => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const reason = String(new FormData(event.currentTarget).get('reason') || '')
    const { error: voidError } = await supabase.rpc('void_sale', { target_business_id: businessId, target_sale_id: sale.id, void_reason: reason })
    setBusy(false)
    if (voidError) setError(friendlyError(voidError)); else onDone()
  }
  return <Modal title={`Cancel receipt ${sale.number}`} onClose={onClose}>
    <form onSubmit={submit}>
      <p className="hint">Stock goes back on the shelf. Refund any cash or M-Pesa received separately. Cashiers can cancel only their own last sale, within 15 minutes.</p>
      <label>Reason<input name="reason" required minLength={3} maxLength={300} autoFocus placeholder="For example: wrong item entered" /></label>
      {error && <div className="notice error">{error}</div>}
      <button className="button danger" disabled={busy}>{busy ? 'Cancelling' : 'Cancel sale'}</button>
    </form>
  </Modal>
}

const RECENT_USERS = 'radari.recentUsers'
function SwitchUser({ onClose }: { onClose: () => void }) {
  const { user } = useAccount()
  let recent: string[] = []
  try { recent = JSON.parse(window.localStorage.getItem(RECENT_USERS) || '[]') } catch { recent = [] }
  const [email, setEmail] = useState(recent.find(e => e !== user.email) || '')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const password = String(new FormData(event.currentTarget).get('password') || '')
    const clean = email.trim().toLowerCase()
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: clean, password })
    setBusy(false)
    if (signInError) { setError(friendlyError(signInError, 'Wrong email or password')); return }
    try { window.localStorage.setItem(RECENT_USERS, JSON.stringify([clean, String(user.email), ...recent].filter((v, i, a) => v && a.indexOf(v) === i).slice(0, 6))) } catch { /* storage unavailable */ }
    window.location.assign('/app/pos')
  }
  return <Modal title="Switch user" onClose={onClose}>
    <form onSubmit={submit}>
      <p className="hint">Signed in as {String(user.email)}. The next person signs in with their own email and password.</p>
      <label>Email<input type="email" required value={email} onChange={event => setEmail(event.target.value)} list="recent-users" autoComplete="username" /></label>
      <datalist id="recent-users">{recent.map(e => <option key={e} value={e} />)}</datalist>
      <label>Password<input name="password" type="password" required autoComplete="current-password" autoFocus={!!email} /></label>
      {error && <div className="notice error">{error}</div>}
      <button className="button" disabled={busy}>{busy ? 'Signing in' : 'Switch user'}</button>
    </form>
  </Modal>
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
      let query = supabase.from('customer_balances').select('id,name,phone,balance,credit_limit,loyalty_points')
        .eq('business_id', businessId).eq('active', true).order('name').limit(30)
      const clean = term.trim().replace(/[%,()]/g, '')
      if (clean) query = query.or(`name.ilike.%${clean}%,phone.ilike.%${clean}%`)
      const { data, error: loadError } = await query
      if (cancelled) return
      if (loadError) setError(friendlyError(loadError))
      setRows((data || []).map(row => ({ ...row, balance: Number(row.balance), credit_limit: Number(row.credit_limit), loyalty_points: Number(row.loyalty_points || 0) })))
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
    onPick({ ...data, balance: 0, credit_limit: Number(data.credit_limit), loyalty_points: 0 })
  }

  return <Modal title={creating ? 'New customer' : 'Choose customer'} onClose={onClose}>
    {error && <div className="notice error">{error}</div>}
    {creating ? <form onSubmit={create}>
      <label>Name<input name="name" required maxLength={120} autoFocus /></label>
      <label>Phone<input name="phone" type="tel" maxLength={30} placeholder="07XXXXXXXX" /></label>
      <label>Credit limit in KSh (0 means no limit)<input name="limit" type="number" min="0" step="1" defaultValue="0" /></label>
      <button className="button">Save and select</button>
      <button type="button" className="text-button" onClick={() => setCreating(false)}>Back to list</button>
    </form> : <>
      <input type="search" autoFocus value={term} onChange={event => setTerm(event.target.value)} placeholder="Search name or phone" aria-label="Search customers" />
      <div className="picker-list">{loading ? <Loading /> : rows.length === 0 ? <p className="muted">No customers found.</p> :
        rows.map(row => <button type="button" key={row.id} onClick={() => onPick(row)}>
          <span><strong>{row.name}</strong><small>{row.phone || 'No phone'}</small></span>
          <span className={row.balance > 0 ? 'owed' : 'muted'}>{row.balance > 0 ? `Owes ${money(row.balance)}` : 'No balance'}</span>
        </button>)}</div>
      <button type="button" className="button secondary block" onClick={() => setCreating(true)}>New customer</button>
    </>}
  </Modal>
}
