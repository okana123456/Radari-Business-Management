// Public endpoint called by Safaricom after an STK Push. JWT verification is off.
// A callback is never trusted on its own: every success is confirmed with the
// Daraja STK Query API before the subscription is activated.
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

async function darajaAccessToken(): Promise<string> {
  const credentials = btoa(`${requiredSecret('DARAJA_CONSUMER_KEY')}:${requiredSecret('DARAJA_CONSUMER_SECRET')}`)
  const response = await fetch(`${darajaBaseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.access_token) throw new Error('Daraja authentication failed')
  return result.access_token
}

type Verification = 'paid' | 'failed' | 'unknown'

async function verifyStkPayment(checkoutRequestId: string): Promise<Verification> {
  const shortCode = requiredSecret('DARAJA_SHORTCODE')
  const timestamp = darajaTimestamp()
  const response = await fetch(`${darajaBaseUrl}/mpesa/stkpushquery/v1/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await darajaAccessToken()}`, 'Content-Type': 'application/json' },
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
const metadataValue = (items: CallbackItem[], name: string) => items.find((item) => item.Name === name)?.Value
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ ResultCode: 0, ResultDesc: 'Accepted' })

  try {
    const payload = await request.json().catch(() => null)
    const callback = payload?.Body?.stkCallback
    if (!callback?.CheckoutRequestID || typeof callback.CheckoutRequestID !== 'string') {
      return json({ ResultCode: 0, ResultDesc: 'Accepted' })
    }

    const supabase = adminClient()
    const { data: paymentRequest, error: findError } = await supabase
      .from('payment_requests')
      .select('id,amount_kes,status')
      .eq('checkout_request_id', callback.CheckoutRequestID)
      .maybeSingle()
    if (findError) throw new Error('Payment request lookup failed')
    if (!paymentRequest) return json({ ResultCode: 0, ResultDesc: 'Unknown request ignored' })
    if (paymentRequest.status !== 'submitted') return json({ ResultCode: 0, ResultDesc: 'Already processed' })

    if (Number(callback.ResultCode) !== 0) {
      await supabase.from('payment_requests').update({
        status: 'failed',
        failure_reason: String(callback.ResultDesc || 'Payment was not completed').slice(0, 200),
        updated_at: new Date().toISOString(),
      }).eq('id', paymentRequest.id).eq('status', 'submitted')
      return json({ ResultCode: 0, ResultDesc: 'Accepted' })
    }

    const items: CallbackItem[] = callback.CallbackMetadata?.Item || []
    const amount = Number(metadataValue(items, 'Amount'))
    const receipt = String(metadataValue(items, 'MpesaReceiptNumber') || '')
    const phone = String(metadataValue(items, 'PhoneNumber') || '')
    const transactionDate = String(metadataValue(items, 'TransactionDate') || '')
    if (!/^[A-Z0-9]{8,12}$/.test(receipt) || amount !== Number(paymentRequest.amount_kes)) {
      await supabase.from('payment_requests').update({
        failure_reason: 'Callback details did not match the request',
        updated_at: new Date().toISOString(),
      }).eq('id', paymentRequest.id)
      return json({ ResultCode: 0, ResultDesc: 'Accepted for review' })
    }

    // Keep the callback so subscription-maintenance can finish verification later if needed.
    await supabase.from('payment_requests').update({
      callback_payload: payload,
      updated_at: new Date().toISOString(),
    }).eq('id', paymentRequest.id)

    let verification: Verification = 'unknown'
    for (let attempt = 0; attempt < 3 && verification === 'unknown'; attempt++) {
      if (attempt > 0) await wait(2500)
      verification = await verifyStkPayment(callback.CheckoutRequestID).catch(() => 'unknown' as Verification)
    }

    if (verification === 'failed') {
      await supabase.from('payment_requests').update({
        status: 'failed', failure_reason: 'Safaricom did not confirm this payment', updated_at: new Date().toISOString(),
      }).eq('id', paymentRequest.id).eq('status', 'submitted')
      return json({ ResultCode: 0, ResultDesc: 'Accepted' })
    }
    if (verification === 'unknown') {
      await supabase.from('payment_requests').update({
        verification_attempts: 1, updated_at: new Date().toISOString(),
      }).eq('id', paymentRequest.id)
      return json({ ResultCode: 0, ResultDesc: 'Accepted for verification' })
    }

    const paidAt = /^\d{14}$/.test(transactionDate)
      ? new Date(`${transactionDate.slice(0, 4)}-${transactionDate.slice(4, 6)}-${transactionDate.slice(6, 8)}T${transactionDate.slice(8, 10)}:${transactionDate.slice(10, 12)}:${transactionDate.slice(12, 14)}+03:00`).toISOString()
      : new Date().toISOString()

    const { error: confirmationError } = await supabase.rpc('confirm_subscription_payment', {
      target_payment_request_id: paymentRequest.id,
      mpesa_receipt: receipt,
      paid_phone: phone,
      paid_amount: amount,
      paid_time: paidAt,
      callback_payload: payload,
    })
    if (confirmationError) throw new Error('Payment confirmation failed')

    return json({ ResultCode: 0, ResultDesc: 'Payment recorded' })
  } catch (error) {
    // Message only: never log the payload, phone numbers or credentials.
    console.error('daraja-callback:', error instanceof Error ? error.message : 'unexpected error')
    return json({ ResultCode: 0, ResultDesc: 'Accepted for review' })
  }
})
