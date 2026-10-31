// Public endpoint that Safaricom calls for every payment made to a business's till or
// paybill (Daraja C2B). JWT verification is off. The URL ends with a secret token that
// identifies the business: .../functions/v1/till-payment-notify/<token>
// Validation requests (URL ending in /validate) are always accepted.
import { createClient } from 'npm:@supabase/supabase-js@2'

function reply(body: Record<string, unknown> = { ResultCode: 0, ResultDesc: 'Accepted' }): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

function adminClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
}

// Optional extra protection: a comma-separated list of Safaricom callback IP addresses.
function ipAllowed(request: Request): boolean {
  const list = (Deno.env.get('TILL_CALLBACK_ALLOWED_IPS') || '').split(',').map(v => v.trim()).filter(Boolean)
  if (!list.length) return true
  const forwarded = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim()
  return list.includes(forwarded)
}

function parseTransTime(value: unknown): string {
  const text = String(value || '')
  if (/^\d{14}$/.test(text)) {
    return new Date(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+03:00`).toISOString()
  }
  return new Date().toISOString()
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return reply()
  const parts = new URL(request.url).pathname.split('/').filter(Boolean)
  if (parts[parts.length - 1] === 'validate') return reply({ ResultCode: '0', ResultDesc: 'Accepted' })
  const token = parts[parts.length - 1] || ''
  if (!/^[0-9a-f]{48}$/.test(token) || !ipAllowed(request)) return reply()

  try {
    const payload = await request.json().catch(() => null)
    if (!payload?.TransID) return reply()
    const name = [payload.FirstName, payload.MiddleName, payload.LastName].filter(Boolean).join(' ').trim()
    const { data, error } = await adminClient().rpc('record_till_payment', {
      callback_token: token,
      trans_id: String(payload.TransID).trim().toUpperCase(),
      trans_time: parseTransTime(payload.TransTime),
      amount: Number(payload.TransAmount),
      shortcode: payload.BusinessShortCode ? String(payload.BusinessShortCode) : null,
      bill_ref: payload.BillRefNumber ? String(payload.BillRefNumber) : null,
      msisdn: payload.MSISDN ? String(payload.MSISDN) : null,
      payer_name: name || null,
    })
    if (error) throw new Error('Could not record payment')
    if (data !== 'recorded') console.error('till-payment-notify: payment not recorded:', data)
  } catch (error) {
    // Message only: never log payer details or the token.
    console.error('till-payment-notify:', error instanceof Error ? error.message : 'unexpected error')
  }
  // Always acknowledge so Safaricom does not retry indefinitely.
  return reply()
})
