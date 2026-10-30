export const money = (value: number | string | null | undefined) => {
  const amount = Math.round(Number(value || 0) * 100) / 100
  const decimals = Number.isInteger(amount) ? 0 : 2
  return `KSh ${amount.toLocaleString('en-KE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

export const qty = (value: number | string | null | undefined) =>
  Number(value || 0).toLocaleString('en-KE', { maximumFractionDigits: 3 })

export const dateTime = (value: string | Date) =>
  new Date(value).toLocaleString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

export const dateOnly = (value: string | Date) =>
  new Date(value).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' })

/** yyyy-mm-dd for the device's local calendar day (Kenyan businesses run on EAT). */
export const isoDay = (value: Date = new Date()) => {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

export type DateRange = { from: string; to: string } // inclusive local days, yyyy-mm-dd

/** Converts an inclusive local day range into [start, end) timestamps for the database. */
export const rangeToTimestamps = (range: DateRange) => {
  const start = new Date(`${range.from}T00:00:00`)
  const end = new Date(`${range.to}T00:00:00`)
  end.setDate(end.getDate() + 1)
  return { start: start.toISOString(), end: end.toISOString() }
}

export const presetRange = (preset: string): DateRange => {
  const today = new Date()
  const day = (offset: number) => { const d = new Date(today); d.setDate(d.getDate() + offset); return isoDay(d) }
  switch (preset) {
    case 'yesterday': return { from: day(-1), to: day(-1) }
    case 'week': { const back = (today.getDay() + 6) % 7; return { from: day(-back), to: day(0) } }
    case '7days': return { from: day(-6), to: day(0) }
    case 'month': return { from: isoDay(new Date(today.getFullYear(), today.getMonth(), 1)), to: day(0) }
    case 'lastmonth': return {
      from: isoDay(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      to: isoDay(new Date(today.getFullYear(), today.getMonth(), 0)),
    }
    case '30days': return { from: day(-29), to: day(0) }
    default: return { from: day(0), to: day(0) }
  }
}

/** Turns database and network errors into messages a shop attendant can act on. */
export function friendlyError(error: unknown, fallback = 'Something went wrong. Please try again.') {
  const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : ''
  if (!message) return fallback
  if (/failed to fetch|network|load failed/i.test(message)) return 'No connection. Check your internet and try again.'
  if (/row-level security|permission denied/i.test(message)) return 'You do not have permission to do that.'
  if (/duplicate key.*sku/i.test(message)) return 'Another product already uses that SKU.'
  if (/customers_business_phone_key/i.test(message)) return 'Another customer already uses that phone number.'
  if (/duplicate key/i.test(message)) return 'That record already exists.'
  if (/JWT|session/i.test(message)) return 'Your session has expired. Please sign in again.'
  if (/violates check constraint|invalid input syntax/i.test(message)) return 'Some details are not valid. Please check the form.'
  return message.length > 200 ? fallback : message
}

export const titleCase = (value: string) => value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

export const paymentLabel = (method: string) =>
  ({ cash: 'Cash', mpesa: 'M-Pesa', credit: 'Credit', split: 'Split', bank: 'Bank', other: 'Other' }[method] || titleCase(method))

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]) {
  const escape = (cell: string | number | null | undefined) => {
    const text = cell === null || cell === undefined ? '' : String(cell)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const blob = new Blob([rows.map(row => row.map(escape).join(',')).join('\n')], { type: 'text/csv' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(link.href), 1000)
}

export const newReference = () =>
  (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)))
