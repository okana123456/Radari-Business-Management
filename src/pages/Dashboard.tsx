import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { dateOnly, friendlyError, money, paymentLabel, presetRange, qty, rangeToTimestamps } from '../lib/format'
import { BarChart, ErrorNotice, Loading, PageHeader, RankBars, Stat } from '../components/ui'

export type Report = {
  revenue: number; vat: number; net_sales: number; cost_of_sales: number; gross_profit: number; expenses: number; net_profit: number
  transactions: number; average_sale: number; voided_count: number; voided_total: number; credit_sales: number; purchases: number
  stock_value: number; stock_retail_value: number; low_stock_count: number; outstanding_credit: number; supplier_balance: number
  payment_methods: { method: string; count: number; total: number }[]
  daily: { day: string; revenue: number; transactions: number; gross_profit: number }[]
  top_products: { product_id: string; name: string; quantity: number; revenue: number; gross_profit: number }[]
  expense_categories: { category: string; total: number; count: number }[]
}

export async function fetchReport(businessId: string, range: { from: string; to: string }) {
  const { start, end } = rangeToTimestamps(range)
  const { data, error } = await supabase.rpc('business_report', { target_business_id: businessId, period_start: start, period_end: end })
  if (error) throw error
  return data as Report
}

/** Fills missing days with zero so the chart shows quiet days honestly. */
export function fillDays(range: { from: string; to: string }, daily: Report['daily']) {
  const byDay = new Map(daily.map(d => [d.day, d]))
  const out: Report['daily'] = []
  for (const cursor = new Date(`${range.from}T12:00:00`); cursor <= new Date(`${range.to}T12:00:00`); cursor.setDate(cursor.getDate() + 1)) {
    const key = cursor.toISOString().slice(0, 10)
    out.push(byDay.get(key) || { day: key, revenue: 0, transactions: 0, gross_profit: 0 })
  }
  return out
}

export default function Dashboard() {
  const { businessId, business, role, products } = useAccount()
  const [today, setToday] = useState<Report | null>(null)
  const [week, setWeek] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const weekRange = presetRange('7days')

  const load = useCallback(async () => {
    setError('')
    try {
      const [todayReport, weekReport] = await Promise.all([fetchReport(businessId, presetRange('today')), fetchReport(businessId, presetRange('7days'))])
      setToday(todayReport); setWeek(weekReport)
    } catch (caught) { setError(friendlyError(caught, 'The overview could not be loaded.')) }
  }, [businessId])

  useEffect(() => { load() }, [load])

  const low = products.filter(p => p.active && p.is_low_stock).sort((a, b) => a.stock - b.stock).slice(0, 8)
  const hour = new Date().getHours()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return <>
    <PageHeader title={greeting} subtitle={`${business.name} · ${dateOnly(new Date())}`} actions={<>
      {can(role, 'pos') && <Link className="button" to="/app/pos">Open till</Link>}
      <button type="button" className="button secondary" onClick={load}>Refresh</button>
    </>} />
    <ErrorNotice message={error} onRetry={load} />
    {!today && !error ? <Loading label="Loading today’s figures…" /> : today && <>
      <h2 className="section-title">Today</h2>
      <div className="stat-grid">
        <Stat label="Sales" value={money(today.revenue)} hint={`${today.transactions} transaction${today.transactions === 1 ? '' : 's'}${today.voided_count ? ` · ${today.voided_count} voided` : ''}`} />
        <Stat label="Gross profit" value={money(today.gross_profit)} hint={today.revenue ? `${Math.round((today.gross_profit / Math.max(1, today.net_sales)) * 100)}% margin (excl. VAT)` : 'No sales yet'} tone={today.gross_profit < 0 ? 'critical' : undefined} />
        <Stat label="Expenses" value={money(today.expenses)} hint={<Link to="/app/expenses">Record expense</Link>} />
        <Stat label="Net profit" value={money(today.net_profit)} tone={today.net_profit < 0 ? 'critical' : 'good'} />
      </div>
      <div className="stat-grid">
        <Stat label="Stock value (cost)" value={money(today.stock_value)} hint={`${money(today.stock_retail_value)} at selling price`} />
        <Stat label="Low-stock items" value={today.low_stock_count} tone={today.low_stock_count ? 'warning' : undefined} hint={<Link to="/app/inventory">View inventory</Link>} />
        <Stat label="Owed by customers" value={money(Math.max(0, today.outstanding_credit))} hint={<Link to="/app/customers">Customers</Link>} />
        <Stat label="Owed to suppliers" value={money(today.supplier_balance)} hint={<Link to="/app/suppliers">Suppliers</Link>} />
      </div>
      {today.payment_methods.length > 0 && <div className="pill-row">{today.payment_methods.map(m =>
        <span key={m.method} className="pill">{paymentLabel(m.method)} <strong>{money(m.total)}</strong> · {m.count}</span>)}</div>}
    </>}

    <div className="panel-grid">
      <section className="panel">
        <h2>Sales, last 7 days</h2>
        {!week ? <Loading /> : <BarChart label="Daily sales for the last 7 days" format={money}
          data={fillDays(weekRange, week.daily).map(d => ({ key: d.day, label: new Date(`${d.day}T12:00:00`).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric' }), value: Number(d.revenue), detail: `${d.transactions} sales · ${money(d.gross_profit)} gross profit` }))} />}
      </section>
      <section className="panel">
        <h2>Best sellers, last 7 days</h2>
        {!week ? <Loading /> : <RankBars format={money} rows={week.top_products.slice(0, 5).map(p => ({ key: p.product_id || p.name, label: p.name, value: Number(p.revenue), detail: `${qty(p.quantity)} sold` }))} />}
      </section>
      <section className="panel">
        <h2>Running low</h2>
        {low.length === 0 ? <p className="muted">Nothing is below its low-stock level.</p> :
          <ul className="simple-list">{low.map(p => <li key={p.id}><span><strong>{p.name}</strong><small>Alert at {qty(p.reorder_level)}</small></span>
            <span className={`badge ${p.stock <= 0 ? 'critical' : 'warning'}`}>{p.stock <= 0 ? '✕ Out' : `! ${qty(p.stock)} left`}</span></li>)}</ul>}
        {low.length > 0 && can(role, 'recordPurchase') && <Link className="button secondary small" to="/app/suppliers?purchase=1">Record a delivery</Link>}
      </section>
    </div>
  </>
}
