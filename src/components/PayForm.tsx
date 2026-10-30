import { FormEvent, useEffect, useRef, useState } from 'react'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { friendlyError } from '../lib/format'

/** Starts an M-Pesa STK Push for the subscription and waits for the confirmed payment. */
export function PayForm({ businessId, defaultPhone, label, onConfirmed }: { businessId: string; defaultPhone: string; label: string; onConfirmed: () => void }) {
  const [phone, setPhone] = useState(defaultPhone)
  const [busy, setBusy] = useState(false)
  const [waitingFor, setWaitingFor] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const confirmed = useRef(onConfirmed)
  confirmed.current = onConfirmed

  useEffect(() => {
    if (!waitingFor) return
    const started = Date.now()
    const timer = window.setInterval(async () => {
      const { data } = await supabase.from('payment_requests').select('status,failure_reason').eq('id', waitingFor).maybeSingle()
      if (data?.status === 'confirmed') {
        window.clearInterval(timer); setWaitingFor(null); setMessage('Payment confirmed. Thank you!'); confirmed.current()
      } else if (data && ['failed', 'cancelled', 'expired'].includes(data.status)) {
        window.clearInterval(timer); setWaitingFor(null); setMessage('')
        setError(data.failure_reason || 'The payment was not completed. You can try again.')
      } else if (Date.now() - started > 3 * 60 * 1000) {
        window.clearInterval(timer); setWaitingFor(null)
        setMessage('Still waiting for M-Pesa. If you paid, your account will update automatically within a few minutes — refresh this page later.')
      }
    }, 4000)
    return () => window.clearInterval(timer)
  }, [waitingFor])

  async function pay(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('initiate-subscription-payment', { body: { businessId, phone } })
      if (invokeError) {
        if (invokeError instanceof FunctionsHttpError) {
          const details = await invokeError.context.json().catch(() => null)
          throw new Error(details?.error || 'The payment request could not be started.')
        }
        throw invokeError
      }
      if (data?.error) throw new Error(data.error)
      setMessage(data?.message || 'Check your phone and enter your M-Pesa PIN.')
      if (data?.paymentRequestId) setWaitingFor(data.paymentRequestId)
    } catch (caught) { setError(friendlyError(caught, 'The payment request could not be started.')) }
    finally { setBusy(false) }
  }

  return <form onSubmit={pay}>
    <label>M-Pesa phone number<input value={phone} onChange={event => setPhone(event.target.value)} type="tel" inputMode="tel" placeholder="0712 345 678" required /></label>
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice success" role="status">{waitingFor && <span className="spinner" aria-hidden="true" />} {message}</div>}
    <button className="primary submit" disabled={busy || !!waitingFor}>{busy ? 'Sending request…' : waitingFor ? 'Waiting for M-Pesa…' : label}</button>
  </form>
}
