// Daily (or more frequent) scheduled task. JWT verification is off; the caller must send
// the shared secret in the x-cron-secret header. The secret may be stored as
// SUBSCRIPTION_CRON_SECRET (preferred) or CRON_SECRET (older setup).
import { createClient } from 'npm:@supabase/supabase-js@2'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

function safeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a)
  const right = new TextEncoder().encode(b)
  let difference = left.length ^ right.length
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  }
  return difference === 0
}

const darajaBaseUrl = Deno.env.get('DARAJA_ENV') === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke'

function requiredSecret(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function darajaTimestamp(): string {
  const nairobi = new Date(Date.now() + 3 * 60 * 60 * 1000)
  return nairobi.toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
}

async function verifyStkPayment(checkoutRequestId: string): Promise<'paid' | 'failed' | 'unknown'> {
  const credentials = btoa(`${requiredSecret('DARAJA_CONSUMER_KEY')}:${requiredSecret('DARAJA_CONSUMER_SECRET')}`)
  const tokenResponse = await fetch(`${darajaBaseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  })
  const token = (await tokenResponse.json().catch(() => ({}))).access_token
  if (!token) return 'unknown'
  const shortCode = requiredSecret('DARAJA_SHORTCODE')
  const timestamp = darajaTimestamp()
  const response = await fetch(`${darajaBaseUrl}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortCode,
      Password: btoa(`${shortCode}${requiredSecret('DARAJA_PASSKEY')}${timestamp}`),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    }),
  })
  const result = await response.json().catch(() => ({}))
  if (result.ResultCode === undefined || result.ResultCode === null || result.ResultCode === '') return 'unknown'
  return String(result.ResultCode) === '0' ? 'paid' : 'failed'
}

type CallbackItem = { Name: string; Value?: string | number }

// Finish payments whose callback arrived but could not be verified at the time.
async function verifyPendingPayments(supabase: ReturnType<typeof adminClient>) {
  const { data: pending, error } = await supabase
    .from('payment_requests')
    .select('id,checkout_request_id,amount_kes,verification_attempts,callback_payload')
    .eq('status', 'submitted')
    .not('callback_payload', 'is', null)
    .lt('updated_at', new Date(Date.now() - 60_000).toISOString())
    .order('updated_at')
    .limit(20)
  if (error) throw new Error('Could not load payments awaiting verification')

  let confirmed = 0
  for (const item of pending || []) {
    const verification = await verifyStkPayment(item.checkout_request_id).catch(() => 'unknown' as const)
    const now = new Date().toISOString()
    if (verification === 'paid') {
      const metadata: CallbackItem[] = item.callback_payload?.Body?.stkCallback?.CallbackMetadata?.Item || []
      const value = (name: string) => metadata.find((entry) => entry.Name === name)?.Value
      const { error: confirmError } = await supabase.rpc('confirm_subscription_payment', {
        target_payment_request_id: item.id,
        mpesa_receipt: String(value('MpesaReceiptNumber') || ''),
        paid_phone: String(value('PhoneNumber') || ''),
        paid_amount: Number(value('Amount')),
        paid_time: now,
        callback_payload: item.callback_payload,
      })
      if (!confirmError) confirmed++
      else console.error('subscription-maintenance: confirmation failed for a pending payment')
    } else if (verification === 'failed' || item.verification_attempts >= 30) {
      await supabase.from('payment_requests').update({
        status: 'failed',
        failure_reason: verification === 'failed' ? 'Safaricom did not confirm this payment' : 'Payment verification timed out',
        updated_at: now,
      }).eq('id', item.id).eq('status', 'submitted')
    } else {
      await supabase.from('payment_requests').update({
        verification_attempts: item.verification_attempts + 1, updated_at: now,
      }).eq('id', item.id)
    }
  }

  // STK Pushes with no callback after a day were abandoned on the phone.
  await supabase.from('payment_requests').update({ status: 'expired', updated_at: new Date().toISOString() })
    .in('status', ['created', 'submitted'])
    .is('callback_payload', null)
    .lt('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())

  return confirmed
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  const expectedSecret = Deno.env.get('SUBSCRIPTION_CRON_SECRET') || Deno.env.get('CRON_SECRET') || ''
  const providedSecret = request.headers.get('x-cron-secret') || ''
  if (!expectedSecret || !providedSecret || !safeEqual(providedSecret, expectedSecret)) {
    return json({ error: 'Unauthorized' }, 401)
  }

  try {
    const supabase = adminClient()
    const paymentsConfirmed = await verifyPendingPayments(supabase)

    const { data: changed, error } = await supabase.rpc('refresh_subscription_statuses')
    if (error) throw new Error('Subscription status refresh failed')

    const { count: pendingReminders, error: reminderError } = await supabase
      .from('subscription_notifications')
      .select('id', { count: 'exact', head: true })
      .is('sent_at', null)
      .lte('scheduled_for', new Date().toISOString().slice(0, 10))
    if (reminderError) throw new Error('Reminder lookup failed')

    // Reminders are shown inside the app from the subscription end date. These records
    // remain available for a future SMS or email provider.
    return json({ subscriptionsUpdated: changed || 0, paymentsConfirmed, pendingReminders: pendingReminders || 0 })
  } catch (error) {
    console.error('subscription-maintenance:', error instanceof Error ? error.message : 'unexpected error')
    return json({ error: 'Subscription maintenance failed' }, 500)
  }
})
