import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'

type Account = { businessId: string; businessName: string }
type Product = { id: string; name: string; category: string; sku: string | null; cost: number; price: number; stock: number; reorder_level: number; vat_rate: number }
type CartItem = Product & { quantity: number }
type Receipt = { number: string; date: Date; payment: string; items: CartItem[]; total: number }

const money = (value: number) => `KSh ${value.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
const iconFor = (category: string) => ({ food: '🍲', drinks: '🥤', grocery: '🛒', bread: '🍞', milk: '🥛', general: '📦' }[category.toLowerCase()] || '📦')

export function POS({ account, user }: { account: Account; user: User }) {
  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<CartItem[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [payment, setPayment] = useState('cash')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showCart, setShowCart] = useState(false)
  const [showStock, setShowStock] = useState(false)
  const [receipt, setReceipt] = useState<Receipt | null>(null)

  const loadProducts = useCallback(async () => {
    const { data, error: loadError } = await supabase.from('products')
      .select('id,name,category,sku,cost,price,stock,reorder_level,vat_rate')
      .eq('business_id', account.businessId).eq('active', true).order('name')
    if (loadError) { setError(loadError.message); return }
    setProducts((data || []).map(product => ({ ...product, cost: Number(product.cost), price: Number(product.price), stock: Number(product.stock), reorder_level: Number(product.reorder_level), vat_rate: Number(product.vat_rate) })))
  }, [account.businessId])

  useEffect(() => {
    loadProducts()
    const channel = supabase.channel(`products-${account.businessId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products', filter: `business_id=eq.${account.businessId}` }, loadProducts)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [account.businessId, loadProducts])

  const categories = useMemo(() => ['All', ...new Set(products.map(product => product.category || 'General'))], [products])
  const filtered = products.filter(product => (category === 'All' || product.category === category) && product.name.toLowerCase().includes(search.toLowerCase()))
  const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0)
  const quantity = cart.reduce((sum, item) => sum + item.quantity, 0)

  function add(product: Product) {
    if (product.stock <= 0) return
    setCart(current => {
      const existing = current.find(item => item.id === product.id)
      if (existing) return current.map(item => item.id === product.id ? { ...item, quantity: Math.min(item.quantity + 1, item.stock) } : item)
      return [...current, { ...product, quantity: 1 }]
    })
  }
  function change(id: string, difference: number) {
    setCart(current => current.map(item => item.id === id ? { ...item, quantity: Math.max(0, Math.min(item.stock, item.quantity + difference)) } : item).filter(item => item.quantity > 0))
  }

  async function completeSale() {
    if (!cart.length || busy) return
    setBusy(true); setError('')
    const soldItems = cart.map(item => ({ ...item }))
    const { data, error: saleError } = await supabase.rpc('complete_pos_sale', {
      target_business_id: account.businessId,
      chosen_payment_method: payment,
      cart_items: cart.map(item => ({ product_id: item.id, quantity: item.quantity })),
    })
    if (saleError) { setError(saleError.message); setBusy(false); return }
    setReceipt({ number: data?.[0]?.receipt_number || 'Receipt', date: new Date(), payment, items: soldItems, total })
    setCart([]); setShowCart(false); await loadProducts(); setBusy(false)
  }

  async function addStock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const { error: insertError } = await supabase.from('products').insert({
      business_id: account.businessId,
      name: String(form.get('name') || '').trim(), category: String(form.get('category') || 'General').trim() || 'General',
      sku: String(form.get('sku') || '').trim() || null, cost: Number(form.get('cost')), price: Number(form.get('price')),
      stock: Number(form.get('stock')), reorder_level: Number(form.get('reorder')), vat_rate: 16,
    })
    if (insertError) setError(insertError.message)
    else { event.currentTarget.reset(); setShowStock(false); await loadProducts() }
    setBusy(false)
  }

  function printReceipt() { window.print() }

  return <main className="pos-shell">
    <section className="pos-products">
      <header className="pos-header"><div><strong>RADARI POS</strong><span>{account.businessName}</span></div><div className="pos-actions"><button onClick={() => setShowStock(true)}>+ Add stock</button><button onClick={() => supabase.auth.signOut()}>Sign out</button><button className="mobile-cart" onClick={() => setShowCart(true)}>Cart ({quantity})</button></div></header>
      <div className="category-strip">{categories.map(item => <button className={category === item ? 'active' : ''} onClick={() => setCategory(item)} key={item}>{item}</button>)}</div>
      <div className="product-search"><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search products or scan barcode…" /></div>
      {error && <div className="pos-error">{error}</div>}
      <div className="product-grid">{filtered.map(product => <button key={product.id} disabled={product.stock <= 0} className={`product-tile ${product.stock <= product.reorder_level ? 'low' : ''}`} onClick={() => add(product)}><span className="product-icon">{iconFor(product.category)}</span><strong>{product.name}</strong><b>{money(product.price)}</b><small>{product.stock <= 0 ? 'Out of stock' : `${product.stock} in stock`}</small></button>)}</div>
      {!products.length && <div className="empty-products"><h2>No stock yet</h2><p>Add your first product to begin selling.</p><button onClick={() => setShowStock(true)}>Add stock</button></div>}
    </section>
    <aside className={`pos-cart ${showCart ? 'show' : ''}`}><div className="cart-title"><h2>Current sale</h2><button onClick={() => setShowCart(false)}>×</button></div><div className="cart-list">{cart.length === 0 ? <div className="empty-cart">🛒<p>Select a product to add it here.</p></div> : cart.map(item => <div className="cart-line" key={item.id}><div><strong>{item.name}</strong><small>{money(item.price)} each</small></div><div className="quantity"><button onClick={() => change(item.id, -1)}>−</button><b>{item.quantity}</b><button onClick={() => change(item.id, 1)}>+</button></div><b>{money(item.price * item.quantity)}</b></div>)}</div><div className="cart-footer"><div className="sale-total"><span>Total</span><strong>{money(total)}</strong></div><div className="payment-options">{['cash', 'mpesa', 'credit'].map(method => <button className={payment === method ? 'active' : ''} onClick={() => setPayment(method)} key={method}>{method === 'cash' ? '💵 Cash' : method === 'mpesa' ? '📱 M-Pesa' : '📝 Credit'}</button>)}</div><div className="checkout-actions"><button onClick={() => setCart([])}>Clear</button><button className="complete-sale" disabled={!cart.length || busy} onClick={completeSale}>{busy ? 'Saving…' : 'Complete sale'}</button></div></div></aside>

    {showStock && <div className="pos-modal"><form className="stock-form" onSubmit={addStock}><button type="button" className="modal-close" onClick={() => setShowStock(false)}>×</button><h2>Add stock item</h2><label>Product name<input name="name" required /></label><label>Category<input name="category" placeholder="General" /></label><label>SKU (optional)<input name="sku" /></label><div className="form-pair"><label>Cost price<input name="cost" type="number" min="0" step="0.01" required /></label><label>Selling price<input name="price" type="number" min="0" step="0.01" required /></label></div><div className="form-pair"><label>Opening stock<input name="stock" type="number" min="0" step="0.001" required /></label><label>Low stock level<input name="reorder" type="number" min="0" step="0.001" defaultValue="5" required /></label></div>{error && <div className="pos-error">{error}</div>}<button className="save-stock" disabled={busy}>{busy ? 'Saving…' : 'Save product'}</button></form></div>}
    {receipt && <div className="pos-modal receipt-modal"><section className="receipt-paper"><div className="receipt-print"><h2>RADARI POS</h2><strong>{account.businessName}</strong><p>{receipt.date.toLocaleString('en-KE')}</p><p>Receipt: {receipt.number}</p><hr />{receipt.items.map(item => <div className="receipt-line" key={item.id}><span>{item.name} × {item.quantity}</span><b>{money(item.price * item.quantity)}</b></div>)}<hr /><div className="receipt-line total"><span>TOTAL</span><b>{money(receipt.total)}</b></div><p>Payment: {receipt.payment.toUpperCase()}</p><p>Thank you!</p></div><div className="receipt-buttons"><button onClick={printReceipt}>Print</button><button onClick={() => setReceipt(null)}>Done</button></div></section></div>}
  </main>
}
