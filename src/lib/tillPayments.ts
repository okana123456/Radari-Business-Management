import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'

export type TillPayment = {
  id: string; trans_id: string; trans_time: string; amount: number; payer_name: string | null; msisdn: string | null
  bill_ref: string | null; status: 'unclaimed' | 'claimed' | 'dismissed'; sale_id: string | null; note: string | null; received_at: string
}
export type TillConnection = { connected: boolean; environment: string; shortcode_type: string; shortcode: string; till_number: string | null; registered_at: string | null; last_error: string | null; last_payment_at: string | null }

export const TILL_COLUMNS = 'id,trans_id,trans_time,amount,payer_name,msisdn,bill_ref,status,sale_id,note,received_at'
export const toTillPayment = (row: Record<string, unknown>): TillPayment => ({ ...(row as unknown as TillPayment), amount: Number(row.amount) })

export async function loadTillConnection(businessId: string): Promise<TillConnection | null> {
  const { data } = await supabase.rpc('till_connection_status', { target_business_id: businessId })
  const row = Array.isArray(data) ? data[0] : data
  return row ? row as TillConnection : null
}

/** Short two-tone chime for a new payment (works after the user has interacted with the page). */
export function playChime() {
  try {
    const Context = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const audio = new Context()
    ;[880, 1320].forEach((frequency, index) => {
      const oscillator = audio.createOscillator(), gain = audio.createGain()
      oscillator.frequency.value = frequency; oscillator.type = 'sine'
      const start = audio.currentTime + index * 0.16
      gain.gain.setValueAtTime(0.0001, start); gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02); gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.28)
      oscillator.connect(gain).connect(audio.destination); oscillator.start(start); oscillator.stop(start + 0.3)
    })
    setTimeout(() => audio.close(), 1000)
  } catch { /* audio unavailable */ }
}

export const payerLabel = (p: TillPayment) => p.payer_name || p.bill_ref || 'M-Pesa customer'

export const minutesAgo = (iso: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000))
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ${minutes % 60} min ago`
}

/** Unused payments received on the till in the last few hours, kept current through Realtime. */
export function useOpenTillPayments(businessId: string, onNew?: (payment: TillPayment) => void) {
  const [connection, setConnection] = useState<TillConnection | null>(null)
  const [payments, setPayments] = useState<TillPayment[]>([])
  const newHandler = useRef(onNew)
  newHandler.current = onNew

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    const { data } = await supabase.from('till_payments').select(TILL_COLUMNS).eq('business_id', businessId)
      .eq('status', 'unclaimed').gte('trans_time', since).order('trans_time', { ascending: false }).limit(30)
    setPayments((data || []).map(toTillPayment))
  }, [businessId])

  useEffect(() => {
    let active = true
    loadTillConnection(businessId).then(c => { if (active) setConnection(c) })
    load()
    const channel = supabase.channel(`till-payments-${businessId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'till_payments', filter: `business_id=eq.${businessId}` }, payload => {
        const payment = toTillPayment(payload.new as Record<string, unknown>)
        setPayments(current => current.some(p => p.id === payment.id) ? current : [payment, ...current].slice(0, 30))
        newHandler.current?.(payment)
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'till_payments', filter: `business_id=eq.${businessId}` }, payload => {
        const payment = toTillPayment(payload.new as Record<string, unknown>)
        setPayments(current => payment.status === 'unclaimed'
          ? (current.some(p => p.id === payment.id) ? current.map(p => p.id === payment.id ? payment : p) : [payment, ...current])
          : current.filter(p => p.id !== payment.id))
      })
      .subscribe()
    return () => { active = false; supabase.removeChannel(channel) }
  }, [businessId, load])

  const remove = useCallback((id: string) => setPayments(current => current.filter(p => p.id !== id)), [])
  return { connection, payments, reload: load, remove }
}
