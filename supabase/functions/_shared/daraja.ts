const environment = Deno.env.get('DARAJA_ENV') === 'production' ? 'production' : 'sandbox'
const baseUrl = environment === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke'

function required(name: string): string {
  const value = Deno.env.get(name)
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

export function normalizeKenyanPhone(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (/^254[17]\d{8}$/.test(digits)) return digits
  if (/^0[17]\d{8}$/.test(digits)) return `254${digits.slice(1)}`
  if (/^[17]\d{8}$/.test(digits)) return `254${digits}`
  throw new Error('Enter a valid Kenyan M-Pesa number')
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)
}

async function accessToken(): Promise<string> {
  const credentials = btoa(`${required('DARAJA_CONSUMER_KEY')}:${required('DARAJA_CONSUMER_SECRET')}`)
  const response = await fetch(`${baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  })
  const result = await response.json()
  if (!response.ok || !result.access_token) throw new Error('Daraja authentication failed')
  return result.access_token
}

export async function requestStkPush(phone: string, amount: number, accountReference: string) {
  const shortCode = required('DARAJA_SHORTCODE')
  const currentTimestamp = timestamp()
  const password = btoa(`${shortCode}${required('DARAJA_PASSKEY')}${currentTimestamp}`)
  const token = await accessToken()
  const response = await fetch(`${baseUrl}/mpesa/stkpush/v1/processrequest`, {
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
      CallBackURL: required('DARAJA_CALLBACK_URL'),
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

