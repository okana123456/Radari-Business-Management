import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { DateRange, dateOnly, friendlyError, money, paymentLabel, presetRange, qty, rangeToTimestamps } from '../lib/format'
import { BarChart, DateRangePicker, ErrorNotice, Loading, PageHeader, RankBars, Stat } from '../components/ui'

export type Report = {
  revenue: number; vat: number; net_sales: number; cost_of_sales: number; gross_profit: number; expenses: number; net_profit: number
  transactions: number; average_sale: number; voided_count: number; voided_total: number; credit_sales: number; purchases: number
  discounts: number; loyalty_discount: number; input_vat: number
  stock_value: number; stock_retail_value: number; low_stock_count: number; expiring_count: number
  outstanding_credit: number; supplier_balance: number; creditor_balance: number
  payment_methods: { method: string; count: number; total: number }[]
  daily: { day: string; revenue: number; transactions: number; gross_profit: number }[]
  daily_expenses: { day: string; amount: number }[]
  hourly: { hour: number; revenue: number; transactions: number }[]
  top_products: { product_id: string; name: string; quantity: number; revenue: number; gross_profit: number }[]
  categories: { category: string; revenue: number; quantity: number }[]
  cashiers: { user_id: string; transactions: number; revenue: number; gross_profit: number; voided: number }[]
  vat_bands: { band: string; gross: number; vat: number; net: number }[]
  expense_categories: { category: string; total: number; count: number }[]
}

export async function fetchReport(businessId: string, range: { from: string; to: string }) {
  const { start, end } = rangeToTimestamps(range)
  const { data, error } = await supabase.rpc('business_report', { target_business_id: businessId, period_start: start, period_end: end })
  if (error) throw error
  return data as Report
}

/** Fills missing days with zero so quiet days show honestly. */
export function fillDays(range: { from: string; to: string }, daily: Report['daily']) {
  const byDay = new Map(daily.map(d => [d.day, d]))
  const out: Report['daily'] = []
  for (const cursor = new Date(`${range.from}T12:00:00`); cursor <= new Date(`${range.to}T12:00:00`); cursor.setDate(cursor.getDate() + 1)) {
    const key = cursor.toISOString().slice(0, 10)
    out.push(byDay.get(key) || { day: key, revenue: 0, transactions: 0, gross_profit: 0 })
  }
  return out
}

const shortDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-KE', { weekday: 'short', day: 'numeric' })

export default function Dashboard() {
  const { businessId, business, role, products, user } = useAccount()
  const [range, setRange] = useState<DateRange>(presetRange('today'))
  const [report, setReport] = useState<Report | null>(null)
  const [week, setWeek] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const weekRange = presetRange('7days')

  const load = useCallback(async () => {
    setError(''); setReport(null)
    try {
      const [main, trend] = await Promise.all([fetchReport(businessId, range), fetchReport(businessId, weekRange)])
      setReport(main); setWeek(trend)
    } catch (caught) { setError(friendlyError(caught, 'The overview could not be loaded.')) }
  }, [businessId, range.from, range.to]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [load])

  const low = products.filter(p => p.active && p.is_low_stock).sort((a, b) => a.stock - b.stock).slice(0, 8)
  const firstName = String(user.user_metadata?.full_name || '').split(' ')[0]
  const isToday = range.from === presetRange('today').from && range.to === range.from
  const periodLabel = isToday ? 'Today' : range.from === range.to ? dateOnly(range.from) : `${dateOnly(range.from)} to ${dateOnly(range.to)}`

  return <>
    <PageHeader title={firstName ? `Welcome back, ${firstName}` : 'Overview'} subtitle={`${business.name} · ${dateOnly(new Date())}`} actions={<button type="button" className="button secondary" onClick={load}>Refresh</button>} />
    <div className="quick-actions">
      {can(role, 'pos') && <Link className="button" to="/app/pos">New sale</Link>}
      {can(role, 'expenses') && <Link className="button secondary" to="/app/expenses?new=1">Add expense</Link>}
      {can(role, 'recordPurchase') && <Link className="button secondary" to="/app/purchases?new=1">Receive stock</Link>}
      {can(role, 'reports') && <Link className="button secondary" to="/app/reports">View reports</Link>}
    </div>
    <DateRangePicker value={range} onChange={setRange} />
    <ErrorNotice message={error} onRetry={load} />
    {!report ? <Loading label="Loading figures" /> : <>
      <h2 className="section-title">{periodLabel}</h2>
      <div className="stat-grid">
        <Stat label="Revenue" value={money(report.revenue)} hint={`${report.transactions} sale${report.transactions === 1 ? '' : 's'}${report.voided_count ? `, ${report.voided_count} voided` : ''}`} />
        <Stat label="Gross profit" value={money(report.gross_profit)} hint={report.net_sales ? `${Math.round((report.gross_profit / report.net_sales) * 100)}% margin, excluding VAT` : 'No sales yet'} tone={report.gross_profit < 0 ? 'critical' : undefined} />
        <Stat label="Expenses" value={money(report.expenses)} />
        <Stat label="Net profit" value={money(report.net_profit)} tone={report.net_profit < 0 ? 'critical' : 'good'} />
      </div>
      {report.payment_methods.length > 0 && <div className="pill-row">{report.payment_methods.map(m =>
        <span key={m.method} className="pill">{paymentLabel(m.method)} <strong>{money(m.total)}</strong> ({m.count})</span>)}</div>}
      <h2 className="section-title">Position now</h2>
      <div className="stat-grid">
        <Stat label="Stock value at cost" value={money(report.stock_value)} hint={`${money(report.stock_retail_value)} at selling price`} />
        <Stat label="Low stock" value={report.low_stock_count} tone={report.low_stock_count ? 'warning' : undefined} hint={<Link to="/app/inventory">Inventory</Link>} />
        <Stat label="Expiring in 30 days" value={report.expiring_count} tone={report.expiring_count ? 'warning' : undefined} />
        <Stat label="Owed by customers" value={money(Math.max(0, report.outstanding_credit))} hint={<Link to="/app/credit">Credit sales</Link>} />
        <Stat label="Owed to suppliers and creditors" value={money(report.supplier_balance + report.creditor_balance)} />
      </div>
    </>}

    <div className="panel-grid">
      <section className="panel">
        <h2>Revenue, last 7 days</h2>
        {!week ? <Loading /> : <BarChart label="Daily revenue for the last 7 days" format={money}
          data={fillDays(weekRange, week.daily).map(d => ({ key: d.day, label: shortDay(d.day), value: Number(d.revenue), detail: `${d.transactions} sales, ${money(d.gross_profit)} gross profit` }))} />}
      </section>
      <section className="panel">
        <h2>Top selling products, last 7 days</h2>
        {!week ? <Loading /> : <RankBars format={money} rows={week.top_products.slice(0, 5).map(p => ({ key: p.product_id || p.name, label: p.name, value: Number(p.revenue), detail: `${qty(p.quantity)} sold` }))} />}
      </section>
      {report && can(role, 'tax') && <section className="panel">
        <div className="panel-head"><h2>VAT, {periodLabel.toLowerCase()}</h2><Link className="link-button" to="/app/tax">Details</Link></div>
        <ul className="simple-list">
          <li><span>VAT collected</span><strong>{money(report.vat)}</strong></li>
          {['standard', 'zero_rated', 'exempt'].map(band => { const b = report.vat_bands.find(x => x.band === band); return <li key={band}><span>{band === 'standard' ? 'Taxable sales (16%)' : band === 'zero_rated' ? 'Zero-rated sales' : 'Exempt sales'}</span><span>{money(b?.gross || 0)}</span></li> })}
        </ul>
      </section>}
      <section className="panel">
        <h2>Running low</h2>
        {low.length === 0 ? <p className="muted">Nothing is below its reorder level.</p> :
          <ul className="simple-list">{low.map(p => <li key={p.id}><span><strong>{p.name}</strong><small>Reorder at {qty(p.reorder_level)}</small></span>
            <span className={`badge ${p.stock <= 0 ? 'critical' : 'warning'}`}>{p.stock <= 0 ? 'Out' : `${qty(p.stock)} left`}</span></li>)}</ul>}
        {low.length > 0 && can(role, 'recordPurchase') && <Link className="button secondary small" to="/app/purchases?new=1">Receive stock</Link>}
      </section>
    </div>
  </>
}
