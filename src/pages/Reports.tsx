import { useCallback, useEffect, useState } from 'react'
import { useAccount } from '../lib/account'
import { DateRange, downloadCsv, friendlyError, money, paymentLabel, presetRange, qty } from '../lib/format'
import { BarChart, DateRangePicker, Empty, ErrorNotice, Loading, PageHeader, RankBars, Stat } from '../components/ui'
import { fetchReport, fillDays, Report } from './Dashboard'

const dayLabel = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' })

export default function Reports() {
  const { businessId, products, staffName } = useAccount()
  const [range, setRange] = useState<DateRange>(presetRange('30days'))
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [view, setView] = useState<'chart' | 'table'>('chart')

  const load = useCallback(async () => {
    setReport(null); setError('')
    try { setReport(await fetchReport(businessId, range)) } catch (caught) { setError(friendlyError(caught, 'The report could not be loaded.')) }
  }, [businessId, range])
  useEffect(() => { load() }, [load])

  const days = report ? fillDays(range, report.daily) : []
  const expenseByDay = new Map((report?.daily_expenses || []).map(d => [d.day, Number(d.amount)]))
  const hours = Array.from({ length: 24 }, (_, h) => report?.hourly.find(x => x.hour === h) || { hour: h, revenue: 0, transactions: 0 })
  const firstHour = hours.findIndex(h => h.transactions > 0), lastHour = 23 - [...hours].reverse().findIndex(h => h.transactions > 0)
  const activeHours = firstHour >= 0 ? hours.slice(firstHour, lastHour + 1) : []
  const low = products.filter(p => p.active && p.is_low_stock).sort((a, b) => a.stock - b.stock)

  function exportCsv() {
    if (!report) return
    downloadCsv(`radari-report-${range.from}-to-${range.to}.csv`, [
      ['Radari report', `${range.from} to ${range.to}`], [],
      ['Revenue', report.revenue], ['VAT', report.vat], ['Net sales', report.net_sales], ['Cost of sales', report.cost_of_sales], ['Gross profit', report.gross_profit],
      ['Expenses', report.expenses], ['Net profit', report.net_profit], ['Transactions', report.transactions], ['Average sale', report.average_sale], ['Discounts', report.discounts], [],
      ['Day', 'Revenue', 'Transactions', 'Gross profit', 'Expenses'], ...days.map(d => [d.day, d.revenue, d.transactions, d.gross_profit, expenseByDay.get(d.day) || 0]), [],
      ['Payment method', 'Sales', 'Total'], ...report.payment_methods.map(m => [paymentLabel(m.method), m.count, m.total]), [],
      ['Category', 'Revenue', 'Quantity'], ...report.categories.map(c => [c.category, c.revenue, c.quantity]), [],
      ['Product', 'Quantity', 'Revenue', 'Gross profit'], ...report.top_products.map(p => [p.name, p.quantity, p.revenue, p.gross_profit]), [],
      ['Hour', 'Revenue', 'Transactions'], ...activeHours.map(h => [`${h.hour}:00`, h.revenue, h.transactions]), [],
      ['Staff', 'Sales', 'Revenue', 'Gross profit', 'Voided'], ...report.cashiers.map(c => [staffName(c.user_id), c.transactions, c.revenue, c.gross_profit, c.voided]), [],
      ['Expense category', 'Entries', 'Total'], ...report.expense_categories.map(c => [c.category, c.count, c.total]),
    ])
  }

  return <>
    <PageHeader title="Reports" subtitle="Business performance for any period" actions={<>
      <button type="button" className="button secondary" onClick={() => window.print()} disabled={!report}>Print</button>
      <button type="button" className="button" onClick={exportCsv} disabled={!report}>Export</button></>} />
    <DateRangePicker value={range} onChange={setRange} />
    <ErrorNotice message={error} onRetry={load} />
    {!report ? <Loading label="Calculating" /> : <>
      <div className="stat-grid">
        <Stat label="Gross revenue" value={money(report.revenue)} hint={`${report.transactions} sales, average ${money(report.average_sale)}`} />
        <Stat label="Gross profit" value={money(report.gross_profit)} hint={report.net_sales ? `${Math.round((report.gross_profit / report.net_sales) * 100)}% of net sales` : undefined} tone={report.gross_profit < 0 ? 'critical' : undefined} />
        <Stat label="Total expenses" value={money(report.expenses)} />
        <Stat label="Net profit" value={money(report.net_profit)} tone={report.net_profit < 0 ? 'critical' : 'good'} />
      </div>

      <section className="panel">
        <div className="panel-head"><h2>Sales trend</h2>
          <div className="segmented small"><button type="button" className={view === 'chart' ? 'active' : ''} onClick={() => setView('chart')}>Chart</button><button type="button" className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>Table</button></div></div>
        {view === 'chart'
          ? <BarChart label="Daily revenue" format={money} data={days.map(d => ({ key: d.day, label: dayLabel(d.day), value: Number(d.revenue), detail: `${d.transactions} sales, ${money(d.gross_profit)} gross profit` }))} />
          : <div className="table-wrap"><table className="data-table compact"><thead><tr><th>Day</th><th className="num">Sales</th><th className="num">Revenue</th><th className="num">Gross profit</th><th className="num">Expenses</th><th className="num">Net</th></tr></thead>
            <tbody>{days.map(d => { const e = expenseByDay.get(d.day) || 0; return <tr key={d.day}><td data-label="Day">{d.day}</td><td data-label="Sales" className="num">{d.transactions}</td><td data-label="Revenue" className="num">{money(d.revenue)}</td><td data-label="Gross profit" className="num">{money(d.gross_profit)}</td><td data-label="Expenses" className="num">{money(e)}</td><td data-label="Net" className={`num ${d.gross_profit - e < 0 ? 'neg' : ''}`}>{money(d.gross_profit - e)}</td></tr> })}</tbody></table></div>}
      </section>

      <div className="panel-grid">
        <section className="panel"><h2>Gross profit by day</h2>
          <BarChart label="Daily gross profit" format={money} data={days.map(d => ({ key: d.day, label: dayLabel(d.day), value: Math.max(0, Number(d.gross_profit)) }))} /></section>
        <section className="panel"><h2>Expenses by day</h2>
          <BarChart label="Daily expenses" format={money} data={days.map(d => ({ key: d.day, label: dayLabel(d.day), value: expenseByDay.get(d.day) || 0 }))} /></section>
        <section className="panel"><h2>Sales by category</h2>
          <RankBars format={money} rows={report.categories.map(c => ({ key: c.category, label: c.category, value: Number(c.revenue), detail: `${qty(c.quantity)} sold` }))} /></section>
        <section className="panel"><h2>Top 10 products</h2>
          <RankBars format={money} rows={report.top_products.map(p => ({ key: p.product_id || p.name, label: p.name, value: Number(p.revenue), detail: `${qty(p.quantity)} sold, ${money(p.gross_profit)} profit` }))} /></section>
        <section className="panel"><h2>Sales by hour</h2>
          {activeHours.length ? <BarChart label="Revenue by hour of day" format={money} data={activeHours.map(h => ({ key: String(h.hour), label: `${String(h.hour).padStart(2, '0')}:00`, value: Number(h.revenue), detail: `${h.transactions} sales` }))} /> : <Empty title="No sales in this period" />}</section>
        <section className="panel"><h2>Payment methods</h2>
          {report.payment_methods.length === 0 ? <Empty title="No sales" /> : <table className="data-table compact"><thead><tr><th>Method</th><th className="num">Sales</th><th className="num">Total</th><th className="num">Share</th></tr></thead>
            <tbody>{report.payment_methods.map(m => <tr key={m.method}><td data-label="Method">{paymentLabel(m.method)}</td><td data-label="Sales" className="num">{m.count}</td><td data-label="Total" className="num">{money(m.total)}</td><td data-label="Share" className="num">{report.revenue ? Math.round((m.total / report.revenue) * 100) : 0}%</td></tr>)}</tbody></table>}</section>
      </div>

      <section className="panel"><h2>Staff performance</h2>
        {report.cashiers.length === 0 ? <Empty title="No sales in this period" /> :
          <div className="table-wrap"><table className="data-table compact"><thead><tr><th>Staff member</th><th className="num">Sales</th><th className="num">Revenue</th><th className="num">Average sale</th><th className="num">Gross profit</th><th className="num">Voided</th></tr></thead>
            <tbody>{report.cashiers.map(c => <tr key={c.user_id}><td data-label="Staff">{staffName(c.user_id)}</td><td data-label="Sales" className="num">{c.transactions}</td><td data-label="Revenue" className="num">{money(c.revenue)}</td>
              <td data-label="Average" className="num">{money(c.transactions ? c.revenue / c.transactions : 0)}</td><td data-label="Gross profit" className="num">{money(c.gross_profit)}</td><td data-label="Voided" className={`num ${c.voided ? 'neg' : ''}`}>{c.voided}</td></tr>)}</tbody></table></div>}
      </section>

      <div className="panel-grid">
        <section className="panel"><h2>Expenses by category</h2>
          <RankBars format={money} rows={report.expense_categories.map(c => ({ key: c.category, label: c.category, value: Number(c.total), detail: `${c.count} entr${c.count === 1 ? 'y' : 'ies'}` }))} /></section>
        <section className="panel"><h2>Low stock now</h2>
          {low.length === 0 ? <p className="muted">No products are below their reorder level.</p> :
            <ul className="simple-list">{low.slice(0, 12).map(p => <li key={p.id}><span><strong>{p.name}</strong><small>Reorder at {qty(p.reorder_level)}</small></span><span className={`badge ${p.stock <= 0 ? 'critical' : 'warning'}`}>{p.stock <= 0 ? 'Out' : qty(p.stock)}</span></li>)}</ul>}
          {low.length > 12 && <p className="hint">And {low.length - 12} more in Inventory.</p>}</section>
      </div>
      <div className="stat-grid">
        <Stat label="Discounts given" value={money(report.discounts)} />
        <Stat label="Points redeemed" value={money(report.loyalty_discount)} />
        <Stat label="Credit sales" value={money(report.credit_sales)} />
        <Stat label="Purchases" value={money(report.purchases)} />
      </div>
    </>}
  </>
}
