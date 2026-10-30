import { useCallback, useEffect, useState } from 'react'
import { useAccount } from '../lib/account'
import { DateRange, downloadCsv, friendlyError, money, paymentLabel, presetRange, qty } from '../lib/format'
import { BarChart, DateRangePicker, Empty, ErrorNotice, Loading, PageHeader, RankBars, Stat } from '../components/ui'
import { fetchReport, fillDays, Report } from './Dashboard'

export default function Reports() {
  const { businessId, products } = useAccount()
  const [range, setRange] = useState<DateRange>(presetRange('month'))
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [view, setView] = useState<'chart' | 'table'>('chart')

  const load = useCallback(async () => {
    setReport(null); setError('')
    try { setReport(await fetchReport(businessId, range)) } catch (caught) { setError(friendlyError(caught, 'The report could not be loaded.')) }
  }, [businessId, range])
  useEffect(() => { load() }, [load])

  const days = report ? fillDays(range, report.daily) : []
  const low = products.filter(p => p.active && p.is_low_stock).sort((a, b) => a.stock - b.stock)

  function exportCsv() {
    if (!report) return
    downloadCsv(`radari-report-${range.from}-to-${range.to}.csv`, [
      ['Radari report', `${range.from} to ${range.to}`], [],
      ['Revenue (incl. VAT)', report.revenue], ['VAT', report.vat], ['Net sales', report.net_sales], ['Cost of sales', report.cost_of_sales],
      ['Gross profit', report.gross_profit], ['Expenses', report.expenses], ['Net profit', report.net_profit],
      ['Transactions', report.transactions], ['Average sale', report.average_sale], ['Voided sales', report.voided_count], ['Voided value', report.voided_total],
      ['Credit sales', report.credit_sales], ['Purchases', report.purchases], [],
      ['Day', 'Revenue', 'Transactions', 'Gross profit'], ...days.map(d => [d.day, d.revenue, d.transactions, d.gross_profit]), [],
      ['Payment method', 'Transactions', 'Total'], ...report.payment_methods.map(m => [paymentLabel(m.method), m.count, m.total]), [],
      ['Top product', 'Quantity', 'Revenue', 'Gross profit'], ...report.top_products.map(p => [p.name, p.quantity, p.revenue, p.gross_profit]), [],
      ['Expense category', 'Entries', 'Total'], ...report.expense_categories.map(c => [c.category, c.count, c.total]), [],
      ['Low stock product', 'Stock', 'Alert level'], ...low.map(p => [p.name, p.stock, p.reorder_level]),
    ])
  }

  return <>
    <PageHeader title="Reports" subtitle="Profit, VAT, products, payments and expenses" actions={<>
      <button type="button" className="button secondary" onClick={() => window.print()} disabled={!report}>Print</button>
      <button type="button" className="button" onClick={exportCsv} disabled={!report}>Export CSV</button>
    </>} />
    <DateRangePicker value={range} onChange={setRange} />
    <ErrorNotice message={error} onRetry={load} />
    {!report && !error ? <Loading label="Calculating…" /> : report && <div className="report">
      <h2 className="section-title">Profit and loss</h2>
      <div className="stat-grid">
        <Stat label="Revenue" value={money(report.revenue)} hint={`${report.transactions} sales · avg ${money(report.average_sale)}`} />
        <Stat label="Gross profit" value={money(report.gross_profit)} hint={report.net_sales ? `${Math.round((report.gross_profit / report.net_sales) * 100)}% of net sales` : undefined} tone={report.gross_profit < 0 ? 'critical' : undefined} />
        <Stat label="Expenses" value={money(report.expenses)} />
        <Stat label="Net profit" value={money(report.net_profit)} tone={report.net_profit < 0 ? 'critical' : 'good'} />
      </div>
      <table className="statement">
        <tbody>
          <tr><td>Sales (including VAT)</td><td className="num">{money(report.revenue)}</td></tr>
          <tr><td>Less VAT collected</td><td className="num">({money(report.vat)})</td></tr>
          <tr className="subtotal"><td>Net sales</td><td className="num">{money(report.net_sales)}</td></tr>
          <tr><td>Less cost of goods sold</td><td className="num">({money(report.cost_of_sales)})</td></tr>
          <tr className="subtotal"><td>Gross profit</td><td className="num">{money(report.gross_profit)}</td></tr>
          <tr><td>Less expenses</td><td className="num">({money(report.expenses)})</td></tr>
          <tr className="total"><td>Net profit</td><td className="num">{money(report.net_profit)}</td></tr>
        </tbody>
      </table>
      <p className="hint">VAT payable on these sales: <strong>{money(report.vat)}</strong> (output VAT only; deduct input VAT from your purchase invoices when filing on iTax). {report.voided_count > 0 && `${report.voided_count} voided sale${report.voided_count === 1 ? '' : 's'} worth ${money(report.voided_total)} ${report.voided_count === 1 ? 'is' : 'are'} excluded.`}</p>

      <section className="panel">
        <div className="panel-head"><h2>Daily revenue</h2>
          <div className="segmented small"><button type="button" className={view === 'chart' ? 'active' : ''} onClick={() => setView('chart')}>Chart</button><button type="button" className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>Table</button></div></div>
        {view === 'chart'
          ? <BarChart label="Daily revenue" format={money} data={days.map(d => ({ key: d.day, label: new Date(`${d.day}T12:00:00`).toLocaleDateString('en-KE', { day: 'numeric', month: 'short' }), value: Number(d.revenue), detail: `${d.transactions} sales · ${money(d.gross_profit)} gross profit` }))} />
          : <div className="table-wrap"><table className="data-table compact"><thead><tr><th>Day</th><th className="num">Sales</th><th className="num">Revenue</th><th className="num">Gross profit</th></tr></thead>
            <tbody>{days.map(d => <tr key={d.day}><td data-label="Day">{d.day}</td><td data-label="Sales" className="num">{d.transactions}</td><td data-label="Revenue" className="num">{money(d.revenue)}</td><td data-label="Gross profit" className="num">{money(d.gross_profit)}</td></tr>)}</tbody></table></div>}
      </section>

      <div className="panel-grid">
        <section className="panel"><h2>Best-selling products</h2>
          <RankBars format={money} rows={report.top_products.map(p => ({ key: p.product_id || p.name, label: p.name, value: Number(p.revenue), detail: `${qty(p.quantity)} sold · ${money(p.gross_profit)} profit` }))} /></section>
        <section className="panel"><h2>Payment methods</h2>
          {report.payment_methods.length === 0 ? <Empty title="No sales" /> : <table className="data-table compact"><thead><tr><th>Method</th><th className="num">Sales</th><th className="num">Total</th><th className="num">Share</th></tr></thead>
            <tbody>{report.payment_methods.map(m => <tr key={m.method}><td data-label="Method">{paymentLabel(m.method)}</td><td data-label="Sales" className="num">{m.count}</td><td data-label="Total" className="num">{money(m.total)}</td><td data-label="Share" className="num">{report.revenue ? Math.round((m.total / report.revenue) * 100) : 0}%</td></tr>)}</tbody></table>}</section>
        <section className="panel"><h2>Expenses by category</h2>
          <RankBars format={money} rows={report.expense_categories.map(c => ({ key: c.category, label: c.category, value: Number(c.total), detail: `${c.count} entr${c.count === 1 ? 'y' : 'ies'}` }))} /></section>
        <section className="panel"><h2>Low stock now</h2>
          {low.length === 0 ? <p className="muted">No products are below their alert level.</p> :
            <ul className="simple-list">{low.slice(0, 15).map(p => <li key={p.id}><span><strong>{p.name}</strong><small>Alert at {qty(p.reorder_level)}</small></span><span className={`badge ${p.stock <= 0 ? 'critical' : 'warning'}`}>{p.stock <= 0 ? '✕ Out' : `! ${qty(p.stock)}`}</span></li>)}</ul>}
          {low.length > 15 && <p className="hint">and {low.length - 15} more — see Inventory.</p>}</section>
      </div>
      <div className="stat-grid">
        <Stat label="Credit sales in period" value={money(report.credit_sales)} />
        <Stat label="Purchases in period" value={money(report.purchases)} />
        <Stat label="Owed by customers (now)" value={money(Math.max(0, report.outstanding_credit))} />
        <Stat label="Owed to suppliers (now)" value={money(report.supplier_balance)} />
      </div>
    </div>}
  </>
}
