import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

function userClient(authorization: string) {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } },
  )
}

const darajaEnvironment = Deno.env.get('DARAJA_ENV') === 'production' ? 'production' : 'sandbox'
const darajaBaseUrl = darajaEnvironment === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke'

function requiredSecret(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

function normalizeKenyanPhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (/^254[17]\d{8}$/.test(digits)) return digits
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`
  throw new Error('Enter a valid Kenyan M-Pesa number')
}

function darajaTimestamp(): string {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
}

async function darajaAccessToken(): Promise<string> {
  const credentials = btoa(`${requiredSecret('DARAJA_CONSUMER_KEY')}:${requiredSecret('DARAJA_CONSUMER_SECRET')}`)
  const response = await fetch(`${darajaBaseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  })
  const result = await response.json()
  if (!response.ok || !result.access_token) throw new Error('Daraja authentication failed')
  return result.access_token
}

async function requestStkPush(phone: string, amount: number, accountReference: string) {
  const shortCode = requiredSecret('DARAJA_SHORTCODE')
  const currentTimestamp = darajaTimestamp()
  const password = btoa(`${shortCode}${requiredSecret('DARAJA_PASSKEY')}${currentTimestamp}`)
  const token = await darajaAccessToken()
  const response = await fetch(`${darajaBaseUrl}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: currentTimestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: shortCode,
      PhoneNumber: phone,
      CallBackURL: requiredSecret('DARAJA_CALLBACK_URL'),
      AccountReference: accountReference.slice(0, 12),
      TransactionDesc: 'Radari POS subscription',
    }),
  })
  const result = await response.json()
  if (!response.ok || result.ResponseCode !== '0') {
    throw new Error(result.errorMessage || result.ResponseDescription || 'STK Push failed')
  }
  return result
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const authorization = request.headers.get('Authorization') || ''
    if (!authorization.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)

    const supabase = userClient(authorization)
    const admin = adminClient()
    const { data: authData, error: authError } = await supabase.auth.getUser()
    if (authError || !authData.user) return json({ error: 'Invalid session' }, 401)

    const { businessId, phone } = await request.json()
    if (!businessId || !phone) return json({ error: 'Business and phone are required' }, 400)

    const { data: membership } = await supabase
      .from('business_memberships')
      .select('role,status')
      .eq('business_id', businessId)
      .eq('user_id', authData.user.id)
      .eq('role', 'owner')
      .eq('status', 'active')
      .maybeSingle()
    if (!membership) return json({ error: 'Only the business owner can pay' }, 403)

    const { data: subscription, error: subscriptionError } = await supabase
      .from('subscriptions')
      .select('plan_id,plans(price_kes)')
      .eq('business_id', businessId)
      .single()
    if (subscriptionError || !subscription) throw new Error('Subscription was not found')

    const plan = Array.isArray(subscription.plans) ? subscription.plans[0] : subscription.plans
    const amount = Number(plan?.price_kes)
    if (!amount) throw new Error('Subscription price is invalid')

    const normalizedPhone = normalizeKenyanPhone(phone)
    const { data: paymentRequest, error: requestError } = await admin
      .from('payment_requests')
      .insert({
        business_id: businessId,
        requested_by: authData.user.id,
        phone: normalizedPhone,
        amount_kes: amount,
        status: 'created',
      })
      .select('id')
      .single()
    if (requestError) throw requestError

    try {
      const stk = await requestStkPush(normalizedPhone, amount, `RADARI-${paymentRequest.id.slice(0, 6)}`)
      const { error: updateError } = await admin
        .from('payment_requests')
        .update({
          merchant_request_id: stk.MerchantRequestID,
          checkout_request_id: stk.CheckoutRequestID,
          status: 'submitted',
          updated_at: new Date().toISOString(),
        })
        .eq('id', paymentRequest.id)
      if (updateError) throw updateError
      return json({
        paymentRequestId: paymentRequest.id,
        checkoutRequestId: stk.CheckoutRequestID,
        message: 'Check your phone and enter your M-Pesa PIN.',
      })
    } catch (error) {
      await admin.from('payment_requests').update({
        status: 'failed', failure_reason: error.message, updated_at: new Date().toISOString(),
      }).eq('id', paymentRequest.id)
      throw error
    }
  } catch (error) {
    return json({ error: error.message || 'Payment request failed' }, 400)
  }
})

