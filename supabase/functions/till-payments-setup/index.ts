// Owner-only setup for automatic till payment notifications. JWT verification is off at
// the gateway; this function validates the signed-in user itself.
// Actions: save (store Daraja credentials and register callback URLs), disconnect, test (sandbox only).
import { createClient } from 'npm:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
class UserError extends Error {}

const admin = () => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } })
const userClient = (authorization: string) => createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } })
const baseUrl = (environment: string) => environment === 'sandbox' ? 'https://sandbox.safaricom.co.ke' : 'https://api.safaricom.co.ke'

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

async function darajaToken(environment: string, key: string, secret: string) {
  const response = await fetch(`${baseUrl(environment)}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${btoa(`${key}:${secret}`)}` } })
  const result = await response.json().catch(() => ({}))
  if (!response.ok || !result.access_token) throw new UserError('Safaricom rejected the consumer key or secret. Check them and the environment (sandbox or production).')
  return result.access_token as string
}

type Settings = { business_id: string; environment: string; shortcode_type: string; shortcode: string; till_number: string | null; consumer_key: string; consumer_secret: string; callback_token: string }

async function registerUrls(settings: Settings) {
  const token = await darajaToken(settings.environment, settings.consumer_key, settings.consumer_secret)
  const functionsBase = `${Deno.env.get('SUPABASE_URL')}/functions/v1/till-payment-notify`
  const version = settings.environment === 'sandbox' ? 'v1' : 'v2'
  const response = await fetch(`${baseUrl(settings.environment)}/mpesa/c2b/${version}/registerurl`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ShortCode: settings.shortcode, ResponseType: 'Completed', ConfirmationURL: `${functionsBase}/${settings.callback_token}`, ValidationURL: `${functionsBase}/validate` }),
  })
  const result = await response.json().catch(() => ({}))
  const ok = response.ok && String(result.ResponseCode ?? '') === '0'
  return { ok, message: String(result.ResponseDescription || result.errorMessage || (ok ? 'Registered' : 'Registration failed')).slice(0, 200) }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  try {
    const authorization = request.headers.get('Authorization') || ''
    if (!authorization.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
    const supabase = userClient(authorization)
    const { data: authData } = await supabase.auth.getUser()
    if (!authData?.user) return json({ error: 'Invalid session' }, 401)

    const body = await request.json().catch(() => ({}))
    const businessId = String(body.businessId || '')
    const { data: membership } = await supabase.from('business_memberships').select('role')
      .eq('business_id', businessId).eq('user_id', authData.user.id).eq('role', 'owner').eq('status', 'active').maybeSingle()
    if (!membership) return json({ error: 'Only the business owner can manage M-Pesa notifications' }, 403)

    const db = admin()
    const { data: existing } = await db.from('till_settings').select('*').eq('business_id', businessId).maybeSingle()

    if (body.action === 'disconnect') {
      await db.from('till_settings').delete().eq('business_id', businessId)
      return json({ message: 'Disconnected. New payments will no longer appear in Radari.' })
    }

    if (body.action === 'test') {
      if (!existing) throw new UserError('Connect the till first.')
      if (existing.environment !== 'sandbox') throw new UserError('Test payments are only available in sandbox mode. In production, pay KSh 1 to your till from a phone.')
      const token = await darajaToken('sandbox', existing.consumer_key, existing.consumer_secret)
      const response = await fetch(`${baseUrl('sandbox')}/mpesa/c2b/v1/simulate`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ShortCode: existing.shortcode, CommandID: existing.shortcode_type === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline', Amount: Math.max(1, Math.min(70000, Math.round(Number(body.amount) || 10))), Msisdn: '254708374149', BillRefNumber: existing.shortcode_type === 'till' ? null : 'RADARI-TEST' }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok || String(result.ResponseCode ?? '') !== '0') throw new UserError(String(result.errorMessage || result.ResponseDescription || 'The sandbox did not accept the test payment.').slice(0, 200))
      return json({ message: 'Test payment sent. It should appear in Radari within a few seconds.' })
    }

    if (body.action !== 'save') throw new UserError('Unknown action')
    const environment = body.environment === 'sandbox' ? 'sandbox' : 'production'
    const shortcodeType = body.shortcodeType === 'paybill' ? 'paybill' : 'till'
    const shortcode = String(body.shortcode || '').trim()
    const tillNumber = String(body.tillNumber || '').trim() || null
    const consumerKey = String(body.consumerKey || '').trim() || existing?.consumer_key
    const consumerSecret = String(body.consumerSecret || '').trim() || existing?.consumer_secret
    if (!/^[0-9]{5,10}$/.test(shortcode)) throw new UserError('Enter a valid paybill or store number (5 to 10 digits).')
    if (tillNumber && !/^[0-9]{5,10}$/.test(tillNumber)) throw new UserError('Enter a valid till number.')
    if (!consumerKey || !consumerSecret) throw new UserError('Enter the consumer key and consumer secret from your Daraja app.')

    const settings: Settings = {
      business_id: businessId, environment, shortcode_type: shortcodeType, shortcode, till_number: tillNumber,
      consumer_key: consumerKey, consumer_secret: consumerSecret, callback_token: existing?.callback_token || randomToken(),
    }
    const { error: saveError } = await db.from('till_settings').upsert({ ...settings, updated_at: new Date().toISOString() })
    if (saveError) throw new Error('Could not save settings')

    const registration = await registerUrls(settings)
    await db.from('till_settings').update({
      registered_at: registration.ok ? new Date().toISOString() : existing?.registered_at ?? null,
      last_error: registration.ok ? null : registration.message,
    }).eq('business_id', businessId)
    if (!registration.ok) throw new UserError(`Saved, but Safaricom did not register the notification address: ${registration.message}`)
    return json({ message: 'Connected. Payments to your till will now appear in Radari automatically.' })
  } catch (error) {
    if (error instanceof UserError) return json({ error: error.message }, 400)
    console.error('till-payments-setup:', error instanceof Error ? error.message : 'unexpected error')
    return json({ error: 'Something went wrong. Please try again.' }, 500)
  }
})
