import { corsHeaders, json } from '../_shared/cors.ts'
import { adminClient, userClient } from '../_shared/clients.ts'
import { normalizeKenyanPhone, requestStkPush } from '../_shared/daraja.ts'

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

