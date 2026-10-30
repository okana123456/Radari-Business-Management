import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { daysLeft, subscriptionActive, useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { dateOnly, dateTime, friendlyError, money } from '../lib/format'
import { ErrorNotice, PageHeader, Stat, StatusBadge } from '../components/ui'
import { PayForm } from '../components/PayForm'

type Payment = { id: string; provider_receipt: string; amount_kes: number; paid_at: string }
type Request = { id: string; status: string; amount_kes: number; failure_reason: string | null; created_at: string }

export default function Subscription() {
  const { businessId, role, subscription, user, reloadAccount } = useAccount()
  const [payments, setPayments] = useState<Payment[]>([])
  const [requests, setRequests] = useState<Request[]>([])
  const [price, setPrice] = useState(1500)
  const [error, setError] = useState('')
  const remaining = daysLeft(subscription)

  const load = useCallback(async () => {
    const [paid, recent, plan] = await Promise.all([
      supabase.from('payments').select('id,provider_receipt,amount_kes,paid_at').eq('business_id', businessId).order('paid_at', { ascending: false }).limit(24),
      supabase.from('payment_requests').select('id,status,amount_kes,failure_reason,created_at').eq('business_id', businessId).neq('status', 'confirmed').order('created_at', { ascending: false }).limit(5),
      supabase.from('plans').select('price_kes').eq('id', 'standard-monthly').maybeSingle(),
    ])
    if (paid.error) setError(friendlyError(paid.error))
    setPayments((paid.data || []) as Payment[]); setRequests((recent.data || []) as Request[])
    if (plan.data?.price_kes) setPrice(Number(plan.data.price_kes))
  }, [businessId])
  useEffect(() => { load() }, [load])

  return <>
    <PageHeader title="Subscription" subtitle={`Radari Standard · ${money(price)} per 30 days`} />
    <ErrorNotice message={error} />
    <div className="stat-grid">
      <Stat label="Status" value={<StatusBadge status={subscriptionActive(subscription) ? subscription!.status : 'expired'} />} />
      <Stat label="Paid until" value={subscription?.current_period_end ? dateOnly(subscription.current_period_end) : '—'}
        hint={remaining === null ? undefined : remaining > 0 ? `${remaining} day${remaining === 1 ? '' : 's'} left` : 'Expired'} tone={remaining !== null && remaining <= 5 ? 'warning' : undefined} />
      {subscription?.grace_ends_at && remaining !== null && remaining <= 0 && <Stat label="Access ends" value={dateOnly(subscription.grace_ends_at)} tone="critical" hint="3-day grace period" />}
    </div>
    <div className="panel-grid">
      <section className="panel">
        <h2>Renew</h2>
        {can(role, 'paySubscription') ? <>
          <p className="muted">Paying now adds 30 days to the end of your current period, so you never lose days by renewing early.</p>
          <PayForm businessId={businessId} defaultPhone={String(user.user_metadata?.phone || '')} label={`Pay ${money(price)} with M-Pesa`} onConfirmed={() => { reloadAccount(); load() }} />
        </> : <p className="muted">Only the business owner can pay for the subscription.</p>}
      </section>
      <section className="panel">
        <h2>Payment history</h2>
        {payments.length === 0 ? <p className="muted">No payments recorded yet.</p> :
          <table className="data-table compact"><thead><tr><th>Date</th><th>M-Pesa receipt</th><th className="num">Amount</th></tr></thead>
            <tbody>{payments.map(p => <tr key={p.id}><td data-label="Date">{dateTime(p.paid_at)}</td><td data-label="Receipt">{p.provider_receipt}</td><td data-label="Amount" className="num">{money(p.amount_kes)}</td></tr>)}</tbody></table>}
        {requests.length > 0 && <>
          <h3>Recent attempts</h3>
          <ul className="simple-list">{requests.map(r => <li key={r.id}><span><strong>{dateTime(r.created_at)}</strong><small>{r.failure_reason || money(r.amount_kes)}</small></span><StatusBadge status={r.status} /></li>)}</ul>
        </>}
      </section>
    </div>
  </>
}
