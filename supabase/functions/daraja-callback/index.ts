import { adminClient } from '../_shared/clients.ts'
import { json } from '../_shared/cors.ts'

type CallbackItem = { Name: string; Value?: string | number }

function metadataValue(items: CallbackItem[], name: string) {
  return items.find((item) => item.Name === name)?.Value
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ ResultCode: 0, ResultDesc: 'Accepted' })

  try {
    const payload = await request.json()
    const callback = payload?.Body?.stkCallback
    if (!callback?.CheckoutRequestID) return json({ ResultCode: 0, ResultDesc: 'Accepted' })

    const supabase = adminClient()
    const { data: paymentRequest, error: findError } = await supabase
      .from('payment_requests')
      .select('id,business_id,amount_kes,status')
      .eq('checkout_request_id', callback.CheckoutRequestID)
      .maybeSingle()
    if (findError) throw findError
    if (!paymentRequest) return json({ ResultCode: 0, ResultDesc: 'Unknown request ignored' })
    if (paymentRequest.status === 'confirmed') return json({ ResultCode: 0, ResultDesc: 'Already processed' })

    if (Number(callback.ResultCode) !== 0) {
      await supabase.from('payment_requests').update({
        status: 'failed',
        failure_reason: callback.ResultDesc || `Daraja result ${callback.ResultCode}`,
        updated_at: new Date().toISOString(),
      }).eq('id', paymentRequest.id)
      return json({ ResultCode: 0, ResultDesc: 'Accepted' })
    }

    const items: CallbackItem[] = callback.CallbackMetadata?.Item || []
    const amount = Number(metadataValue(items, 'Amount'))
    const receipt = String(metadataValue(items, 'MpesaReceiptNumber') || '')
    const phone = String(metadataValue(items, 'PhoneNumber') || '')
    const transactionDate = String(metadataValue(items, 'TransactionDate') || '')
    if (!receipt || amount !== Number(paymentRequest.amount_kes)) throw new Error('Payment details did not match the request')

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
    if (confirmationError) throw confirmationError

    return json({ ResultCode: 0, ResultDesc: 'Payment recorded' })
  } catch (error) {
    console.error('Daraja callback processing failed', error.message)
    return json({ ResultCode: 0, ResultDesc: 'Accepted for review' })
  }
})

