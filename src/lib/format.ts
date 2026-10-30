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

let businessDayStartHour = 0
/** Sales made before this hour count towards the previous business day (bars, restaurants). */
export const setBusinessDayStart = (hour: number) => { businessDayStartHour = Math.min(9, Math.max(0, Math.floor(hour || 0))) }

/** Converts an inclusive business-day range into [start, end) timestamps for the database. */
export const rangeToTimestamps = (range: DateRange) => {
  const start = new Date(`${range.from}T00:00:00`)
  const end = new Date(`${range.to}T00:00:00`)
  end.setDate(end.getDate() + 1)
  start.setHours(start.getHours() + businessDayStartHour)
  end.setHours(end.getHours() + businessDayStartHour)
  return { start: start.toISOString(), end: end.toISOString() }
}

/** Today's business date, honouring the business-day start hour. */
export const businessToday = () => { const d = new Date(); d.setHours(d.getHours() - businessDayStartHour); return isoDay(d) }

export const presetRange = (preset: string): DateRange => {
  const today = new Date(); today.setHours(today.getHours() - businessDayStartHour)
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
    case 'quarter': { const q = Math.floor(today.getMonth() / 3) * 3; return { from: isoDay(new Date(today.getFullYear(), q, 1)), to: day(0) } }
    case 'year': return { from: isoDay(new Date(today.getFullYear(), 0, 1)), to: day(0) }
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
  ({ cash: 'Cash', mpesa: 'M-Pesa', card: 'Card', credit: 'Credit', split: 'Split', bank: 'Bank', other: 'Other' }[method] || titleCase(method))

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

export const taxCategoryLabel: Record<string, string> = { standard: 'Standard (16%)', reduced: 'Reduced (8%)', zero_rated: 'Zero rated (0%)', exempt: 'Exempt' }
export const taxCategoryRate: Record<string, number> = { standard: 16, reduced: 8, zero_rated: 0, exempt: 0 }

export const BUSINESS_TYPES: [string, string][] = [
  ['retail', 'Retail / supermarket / shop'], ['pharmacy', 'Pharmacy / chemist'], ['hardware', 'Hardware / building materials'],
  ['agrovet', 'Agrovet / farm supplies'], ['electronics', 'Electronics / phone shop'], ['restaurant', 'Restaurant / hotel / food'],
  ['bar', 'Bar / wines and spirits'], ['salon', 'Salon / beauty'], ['wholesale', 'Wholesale / distributor'], ['general', 'General business'],
]

const COMMON_UNITS = ['Piece', 'Packet', 'Box', 'Carton', 'Dozen', 'Pair', 'Set', 'Bundle', 'Pack', 'Unit']
export const UNITS_BY_TYPE: Record<string, string[]> = {
  pharmacy: ['Tablet', 'Capsule', 'Strip', 'Blister pack', 'Bottle', 'Syrup bottle', 'Suspension', 'Drops', 'Ampoule', 'Vial', 'Injection', 'Tube', 'Cream', 'Ointment', 'Gel', 'Lotion', 'Spray', 'Inhaler', 'Sachet', 'Test kit', 'Box', 'Piece'],
  hardware: ['Piece', 'Kg', 'Metre', 'Foot', 'Roll', 'Bag', 'Sheet', 'Length', 'Litre', 'Tin', 'Box', 'Set', 'Pair'],
  agrovet: ['Kg', 'Gram', 'Bag', 'Litre', 'Ml', 'Sachet', 'Packet', 'Bottle', 'Tin', 'Piece'],
  bar: ['Bottle', 'Can', 'Glass', 'Crate', 'Carton', 'Tot', 'Litre', 'Piece'],
  restaurant: ['Plate', 'Portion', 'Cup', 'Glass', 'Bottle', 'Can', 'Piece', 'Kg', 'Litre'],
  retail: [...COMMON_UNITS, 'Kg', 'Gram', 'Litre', 'Ml', 'Bottle', 'Can', 'Roll', 'Sachet', 'Tin'],
}
export const unitsFor = (businessType: string) => UNITS_BY_TYPE[businessType] || UNITS_BY_TYPE.retail
