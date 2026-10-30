import { useCallback, useEffect, useState } from 'react'
import { useAccount } from '../lib/account'
import { DateRange, dateOnly, downloadCsv, friendlyError, money, presetRange } from '../lib/format'
import { DateRangePicker, ErrorNotice, Loading, PageHeader } from '../components/ui'
import { fetchReport, Report } from './Dashboard'

export default function ProfitLoss() {
  const { businessId, business } = useAccount()
  const [range, setRange] = useState<DateRange>(presetRange('month'))
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setReport(null); setError('')
    try { setReport(await fetchReport(businessId, range)) } catch (caught) { setError(friendlyError(caught, 'The statement could not be loaded.')) }
  }, [businessId, range])
  useEffect(() => { load() }, [load])

  const pct = (n: number) => report && report.net_sales ? `${((n / report.net_sales) * 100).toFixed(1)}%` : ''
  function exportCsv() {
    if (!report) return
    downloadCsv(`radari-profit-and-loss-${range.from}-to-${range.to}.csv`, [
      ['Profit and loss statement', business.name], ['Period', `${range.from} to ${range.to}`], [],
      ['Sales including VAT', report.revenue], ['Less VAT', -report.vat], ['Net sales', report.net_sales], ['Cost of goods sold', -report.cost_of_sales], ['Gross profit', report.gross_profit], [],
      ['Operating expenses'], ...report.expense_categories.map(c => [`  ${c.category}`, -c.total]), ['Total expenses', -report.expenses], [], ['Net profit', report.net_profit],
    ])
  }

  return <>
    <PageHeader title="Profit and loss" subtitle="Income statement" actions={<>
      <button type="button" className="button secondary" disabled={!report} onClick={() => window.print()}>Print</button>
      <button type="button" className="button" disabled={!report} onClick={exportCsv}>Export</button></>} />
    <DateRangePicker value={range} onChange={setRange} long />
    <ErrorNotice message={error} onRetry={load} />
    {!report ? <Loading /> : <section className="panel">
      <div className="panel-head"><div><h2>{business.name}</h2><p className="muted" style={{ margin: '4px 0 0', fontSize: '.86rem' }}>{dateOnly(range.from)} to {dateOnly(range.to)}</p></div></div>
      <table className="statement"><tbody>
        <tr><td>Sales including VAT</td><td className="num">{money(report.revenue)}</td><td className="num muted" /></tr>
        <tr className="indent"><td>Less VAT collected</td><td className="num">({money(report.vat)})</td><td /></tr>
        <tr className="subtotal"><td>Net sales</td><td className="num">{money(report.net_sales)}</td><td className="num">100%</td></tr>
        <tr className="indent"><td>Less cost of goods sold</td><td className="num">({money(report.cost_of_sales)})</td><td className="num muted">{pct(report.cost_of_sales)}</td></tr>
        <tr className="subtotal"><td>Gross profit</td><td className="num">{money(report.gross_profit)}</td><td className="num">{pct(report.gross_profit)}</td></tr>
        <tr><td colSpan={3} style={{ paddingTop: 16, fontWeight: 700 }}>Operating expenses</td></tr>
        {report.expense_categories.length === 0 && <tr className="indent"><td>No expenses recorded</td><td className="num">{money(0)}</td><td /></tr>}
        {report.expense_categories.map(c => <tr className="indent" key={c.category}><td>{c.category}</td><td className="num">({money(c.total)})</td><td className="num muted">{pct(c.total)}</td></tr>)}
        <tr className="subtotal"><td>Total expenses</td><td className="num">({money(report.expenses)})</td><td className="num">{pct(report.expenses)}</td></tr>
        <tr className="total"><td>Net profit</td><td className={`num ${report.net_profit < 0 ? 'neg' : ''}`}>{money(report.net_profit)}</td><td className="num">{pct(report.net_profit)}</td></tr>
      </tbody></table>
      <p className="hint">Discounts given ({money(report.discounts)}) and points redeemed ({money(report.loyalty_discount)}) are already deducted from sales. {report.voided_count > 0 && `${report.voided_count} voided sale${report.voided_count === 1 ? ' is' : 's are'} excluded.`}</p>
    </section>}
  </>
}
