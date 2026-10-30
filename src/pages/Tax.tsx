import { useCallback, useEffect, useState } from 'react'
import { useAccount } from '../lib/account'
import { DateRange, dateOnly, downloadCsv, friendlyError, money, presetRange } from '../lib/format'
import { DateRangePicker, ErrorNotice, Loading, PageHeader, Stat } from '../components/ui'
import { fetchReport, Report } from './Dashboard'

const BAND_LABEL: Record<string, string> = { standard: 'Standard rated (16%)', reduced: 'Reduced rate (8%)', zero_rated: 'Zero rated (0%)', exempt: 'Exempt' }

/** VAT returns are due on the 20th of the month after the tax period. */
function nextVatDue() {
  const now = new Date()
  const due = new Date(now.getFullYear(), now.getMonth(), 20)
  if (now.getDate() > 20) due.setMonth(due.getMonth() + 1)
  const period = new Date(due.getFullYear(), due.getMonth() - 1, 1)
  return { due, period, days: Math.ceil((due.getTime() - new Date(now.toDateString()).getTime()) / 86400000) }
}

export default function Tax() {
  const { businessId, business } = useAccount()
  const [range, setRange] = useState<DateRange>(presetRange('month'))
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setReport(null); setError('')
    try { setReport(await fetchReport(businessId, range)) } catch (caught) { setError(friendlyError(caught, 'The VAT summary could not be loaded.')) }
  }, [businessId, range])
  useEffect(() => { load() }, [load])

  const next = nextVatDue()
  const outputVat = Number(report?.vat || 0)
  const inputVat = Number(report?.input_vat || 0)
  const netVat = outputVat - inputVat
  const bands = ['standard', 'reduced', 'zero_rated', 'exempt'].map(band => {
    const row = report?.vat_bands.find(b => b.band === band)
    return { band, gross: Number(row?.gross || 0), vat: Number(row?.vat || 0), net: Number(row?.net || 0) }
  })

  function exportCsv() {
    downloadCsv(`radari-vat-${range.from}-to-${range.to}.csv`, [
      ['VAT summary', `${range.from} to ${range.to}`], ['Business', business.name], ['KRA PIN', business.kra_pin || ''], [],
      ['Description', 'Sales incl. VAT', 'Taxable value', 'VAT'], ...bands.map(b => [BAND_LABEL[b.band], b.gross.toFixed(2), b.net.toFixed(2), b.vat.toFixed(2)]), [],
      ['Output VAT', outputVat.toFixed(2)], ['Input VAT (from purchases)', inputVat.toFixed(2)], ['Net VAT payable', netVat.toFixed(2)],
    ])
  }

  return <>
    <PageHeader title="VAT and KRA" subtitle="Output VAT from sales, input VAT from purchases and the VAT return figures" actions={<>
      <button type="button" className="button secondary" disabled={!report} onClick={() => window.print()}>Print</button>
      <button type="button" className="button" disabled={!report} onClick={exportCsv}>Export</button></>} />
    {!business.kra_pin && <div className="notice info" style={{ marginBottom: 16 }}>Add your KRA PIN in Settings so it prints on receipts and exports.</div>}
    <DateRangePicker value={range} onChange={setRange} long />
    <ErrorNotice message={error} onRetry={load} />
    {!report ? <Loading /> : <>
      <div className="stat-grid">
        <Stat label="Sales including VAT" value={money(report.revenue)} />
        <Stat label="Output VAT" value={money(outputVat)} />
        <Stat label="Input VAT" value={money(inputVat)} hint="From purchases" />
        <Stat label={netVat >= 0 ? 'Net VAT payable' : 'VAT credit'} value={money(Math.abs(netVat))} tone={netVat > 0 ? 'warning' : 'good'} />
      </div>
      <div className="panel-grid">
        <section className="panel"><h2>VAT return details</h2>
          <div className="table-wrap"><table className="data-table compact">
            <thead><tr><th>Description</th><th className="num">Sales incl. VAT</th><th className="num">Taxable value</th><th className="num">VAT</th></tr></thead>
            <tbody>{bands.map(b => <tr key={b.band}><td data-label="Description">{BAND_LABEL[b.band]}</td><td data-label="Sales" className="num">{money(b.gross)}</td><td data-label="Taxable" className="num">{money(b.net)}</td><td data-label="VAT" className="num">{money(b.vat)}</td></tr>)}</tbody>
            <tfoot><tr><td>Total</td><td className="num">{money(bands.reduce((s, b) => s + b.gross, 0))}</td><td className="num">{money(bands.reduce((s, b) => s + b.net, 0))}</td><td className="num">{money(outputVat)}</td></tr></tfoot>
          </table></div>
        </section>
        <section className="panel"><h2>Tax calendar</h2>
          <ul className="simple-list">
            <li><span><strong>Next VAT return due</strong><small>For {next.period.toLocaleDateString('en-KE', { month: 'long', year: 'numeric' })}</small></span><span>{dateOnly(next.due)}</span></li>
            <li><span><strong>Days until due</strong></span><span className={next.days <= 5 ? 'badge warning' : ''}>{next.days} day{next.days === 1 ? '' : 's'}</span></li>
          </ul>
          <p className="hint">File on iTax by the 20th of each month. Input VAT here is estimated from purchase costs using each product's VAT rate; claim only what your supplier invoices show.</p>
        </section>
      </div>
      <section className="panel"><h2>eTIMS</h2>
        <p className="muted" style={{ margin: 0 }}>Radari receipts are not yet transmitted to KRA eTIMS. Direct eTIMS integration requires a KRA-approved OSCU or VSCU setup for your business. Until then, keep issuing eTIMS invoices through the KRA eTIMS portal or app for customers who need them.</p>
      </section>
    </>}
  </>
}
