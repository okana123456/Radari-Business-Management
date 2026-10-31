import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { DateRange, dateTime, downloadCsv, friendlyError, money, presetRange, rangeToTimestamps } from '../lib/format'
import { loadTillConnection, payerLabel, playChime, TILL_COLUMNS, TillConnection, TillPayment, toTillPayment } from '../lib/tillPayments'
import { DateRangePicker, Empty, ErrorNotice, Loading, PageHeader, Stat, StatusBadge } from '../components/ui'

export default function TillPayments() {
  const { businessId, role } = useAccount()
  const [range, setRange] = useState<DateRange>(presetRange('today'))
  const [status, setStatus] = useState('all')
  const [rows, setRows] = useState<TillPayment[] | null>(null)
  const [receipts, setReceipts] = useState<Map<string, string>>(new Map())
  const [connection, setConnection] = useState<TillConnection | null | undefined>(undefined)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setError('')
    const { start, end } = rangeToTimestamps(range)
    let query = supabase.from('till_payments').select(TILL_COLUMNS).eq('business_id', businessId)
      .gte('trans_time', start).lt('trans_time', end).order('trans_time', { ascending: false }).limit(500)
    if (status !== 'all') query = query.eq('status', status)
    const { data, error: loadError } = await query
    if (loadError) { setError(friendlyError(loadError)); return }
    const list = (data || []).map(toTillPayment)
    setRows(list)
    const saleIds = [...new Set(list.map(p => p.sale_id).filter(Boolean))] as string[]
    if (saleIds.length) {
      const { data: sales } = await supabase.from('sales').select('id,receipt_number').eq('business_id', businessId).in('id', saleIds)
      setReceipts(new Map((sales || []).map(s => [s.id as string, s.receipt_number as string])))
    }
  }, [businessId, range, status])

  useEffect(() => { load() }, [load])
  useEffect(() => { loadTillConnection(businessId).then(setConnection) }, [businessId])
  useEffect(() => {
    const channel = supabase.channel(`till-page-${businessId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'till_payments', filter: `business_id=eq.${businessId}` }, payload => {
        if (payload.eventType === 'INSERT') playChime()
        load()
      }).subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [businessId, load])

  async function setPaymentStatus(payment: TillPayment, next: 'dismissed' | 'unclaimed') {
    const note = next === 'dismissed' ? window.prompt('Why is this payment not for a sale? (for example: debt repayment)') : null
    if (next === 'dismissed' && note === null) return
    const { error: rpcError } = await supabase.rpc('set_till_payment_status', { target_business_id: businessId, target_payment_id: payment.id, new_status: next, status_note: note })
    if (rpcError) setError(friendlyError(rpcError)); else load()
  }

  const totals = useMemo(() => {
    const list = rows || []
    const sum = (s: string) => list.filter(p => s === 'all' || p.status === s).reduce((t, p) => t + p.amount, 0)
    return { all: sum('all'), claimed: sum('claimed'), unclaimed: sum('unclaimed'), count: list.length, open: list.filter(p => p.status === 'unclaimed').length }
  }, [rows])

  return <>
    <PageHeader title="M-Pesa payments" subtitle="Payments received on your till or paybill, as reported by Safaricom" actions={
      <button type="button" className="button secondary" disabled={!rows?.length} onClick={() => downloadCsv(`radari-mpesa-${range.from}-to-${range.to}.csv`, [['Time', 'Receipt', 'Amount', 'Payer', 'Account', 'Status', 'Sale receipt', 'Note'], ...(rows || []).map(p => [dateTime(p.trans_time), p.trans_id, p.amount, payerLabel(p), p.bill_ref, p.status, p.sale_id ? receipts.get(p.sale_id) : '', p.note])])}>Export</button>} />
    {connection === null && <div className="notice info" style={{ marginBottom: 16 }}>
      Automatic M-Pesa notifications are not connected. {can(role, 'connectTill') ? <Link className="link-button" to="/app/settings#mpesa">Connect your till</Link> : 'Ask the owner to connect the till in Settings.'}
    </div>}
    {connection && <div className={`notice ${connection.connected ? 'success' : 'error'}`} style={{ marginBottom: 16 }}>
      {connection.connected
        ? `Connected to ${connection.shortcode_type === 'till' ? 'till' : 'paybill'} ${connection.till_number || connection.shortcode}${connection.environment === 'sandbox' ? ' (sandbox)' : ''}. ${connection.last_payment_at ? `Last payment received ${dateTime(connection.last_payment_at)}.` : 'No payments received yet.'}`
        : `Not registered with Safaricom yet${connection.last_error ? `: ${connection.last_error}` : ''}.`}
    </div>}
    <DateRangePicker value={range} onChange={setRange} />
    <div className="toolbar"><select value={status} onChange={e => setStatus(e.target.value)} aria-label="Status">
      <option value="all">All payments</option><option value="unclaimed">Not yet used</option><option value="claimed">Used for a sale</option><option value="dismissed">Set aside</option></select></div>
    <ErrorNotice message={error} onRetry={load} />
    {!rows ? <Loading /> : <>
      <div className="stat-grid">
        <Stat label="Received" value={money(totals.all)} hint={`${totals.count} payment${totals.count === 1 ? '' : 's'}`} />
        <Stat label="Used for sales" value={money(totals.claimed)} />
        <Stat label="Not yet used" value={money(totals.unclaimed)} tone={totals.open ? 'warning' : undefined} hint={`${totals.open} payment${totals.open === 1 ? '' : 's'}`} />
      </div>
      {rows.length === 0 ? <Empty title="No M-Pesa payments in this period" /> :
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Time</th><th>M-Pesa receipt</th><th>Payer</th><th className="num">Amount</th><th>Status</th><th>Sale</th><th aria-label="Actions" /></tr></thead>
          <tbody>{rows.map(p => <tr key={p.id}>
            <td data-label="Time">{dateTime(p.trans_time)}</td>
            <td data-label="Receipt"><strong>{p.trans_id}</strong></td>
            <td data-label="Payer">{payerLabel(p)}{p.msisdn && <small>{p.msisdn.length > 16 ? 'Phone hidden by Safaricom' : p.msisdn}</small>}</td>
            <td data-label="Amount" className="num">{money(p.amount)}</td>
            <td data-label="Status"><StatusBadge status={p.status === 'unclaimed' ? 'pending' : p.status === 'claimed' ? 'completed' : 'cancelled'} label={p.status === 'unclaimed' ? 'Not used' : p.status === 'claimed' ? 'Used' : 'Set aside'} />{p.note && <small>{p.note}</small>}</td>
            <td data-label="Sale">{p.sale_id ? receipts.get(p.sale_id) || 'Sale' : '-'}</td>
            <td className="row-actions">{can(role, 'manageTillPayments') && p.status === 'unclaimed' && <button type="button" onClick={() => setPaymentStatus(p, 'dismissed')}>Set aside</button>}
              {can(role, 'manageTillPayments') && p.status === 'dismissed' && <button type="button" onClick={() => setPaymentStatus(p, 'unclaimed')}>Restore</button>}</td>
          </tr>)}</tbody>
        </table></div>}
      <p className="hint">Payments appear here and at the till within seconds of the customer paying. Use them at checkout from the "Received on till" list. Set aside payments that are not for a sale, such as debt repayments.</p>
    </>}
  </>
}
