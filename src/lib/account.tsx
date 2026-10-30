import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from './supabase'
import type { Role } from './roles'

export type Business = {
  id: string; name: string; phone: string | null; email: string | null; address: string | null
  kra_pin: string | null; receipt_footer: string | null; timezone: string
}
export type Subscription = { status: string; current_period_start: string | null; current_period_end: string | null; grace_ends_at: string | null }
export type Membership = { businessId: string; businessName: string; role: Role }
export type Product = {
  id: string; name: string; category: string; sku: string | null; barcode: string | null
  cost: number; price: number; stock: number; reorder_level: number; vat_rate: number
  active: boolean; is_low_stock: boolean; updated_at: string
}

export const PRODUCT_COLUMNS = 'id,name,category,sku,barcode,cost,price,stock,reorder_level,vat_rate,active,is_low_stock,updated_at'

export const toProduct = (row: Record<string, unknown>): Product => ({
  id: String(row.id), name: String(row.name), category: String(row.category || 'General'),
  sku: (row.sku as string) || null, barcode: (row.barcode as string) || null,
  cost: Number(row.cost), price: Number(row.price), stock: Number(row.stock), reorder_level: Number(row.reorder_level),
  vat_rate: Number(row.vat_rate), active: row.active !== false,
  is_low_stock: row.is_low_stock === undefined ? Number(row.stock) <= Number(row.reorder_level) : Boolean(row.is_low_stock),
  updated_at: String(row.updated_at || ''),
})

const BUSINESS_PREFERENCE = 'radari.selectedBusiness'

export function subscriptionActive(subscription: Subscription | null) {
  if (!subscription || !['active', 'grace'].includes(subscription.status)) return false
  const until = subscription.grace_ends_at || subscription.current_period_end
  return !!until && new Date(until).getTime() > Date.now()
}

export function daysLeft(subscription: Subscription | null) {
  if (!subscription?.current_period_end) return null
  return Math.ceil((new Date(subscription.current_period_end).getTime() - Date.now()) / 86400000)
}

export async function loadMemberships(): Promise<Membership[]> {
  const { data, error } = await supabase.from('business_memberships')
    .select('business_id, role, businesses(name)').eq('status', 'active')
  if (error) throw error
  return (data || []).map(row => {
    const business = Array.isArray(row.businesses) ? row.businesses[0] : row.businesses
    return { businessId: row.business_id, businessName: business?.name || 'My Business', role: row.role as Role }
  })
}

export function pickMembership(memberships: Membership[]) {
  let preferred: string | null = null
  try { preferred = window.localStorage.getItem(BUSINESS_PREFERENCE) } catch { /* storage unavailable */ }
  return memberships.find(m => m.businessId === preferred)
    || memberships.find(m => m.role === 'owner') || memberships[0] || null
}

export function rememberBusiness(businessId: string) {
  try { window.localStorage.setItem(BUSINESS_PREFERENCE, businessId) } catch { /* storage unavailable */ }
}

type AccountContextValue = {
  user: User
  businessId: string
  role: Role
  business: Business
  subscription: Subscription | null
  memberships: Membership[]
  reloadAccount: () => Promise<void>
  switchBusiness: (businessId: string) => void
  // Shared product catalogue: loaded once, then kept current through Realtime deltas.
  products: Product[]
  productsLoaded: boolean
  productsError: string
  upsertProducts: (rows: Product[]) => void
  reloadProducts: () => Promise<void>
  staffName: (userId: string) => string
}

const AccountContext = createContext<AccountContextValue | null>(null)

export function useAccount() {
  const value = useContext(AccountContext)
  if (!value) throw new Error('useAccount must be used inside AccountProvider')
  return value
}

export function AccountProvider(props: {
  user: User; membership: Membership; memberships: Membership[]; business: Business; subscription: Subscription | null
  onReload: () => Promise<void>; onSwitch: (businessId: string) => void; children: ReactNode
}) {
  const { membership, user } = props
  const businessId = membership.businessId
  const [productMap, setProductMap] = useState<Map<string, Product>>(new Map())
  const [productsLoaded, setProductsLoaded] = useState(false)
  const [productsError, setProductsError] = useState('')
  const [staff, setStaff] = useState<Record<string, string>>({})
  const staffRequested = useRef(false)
  const lastFullLoad = useRef(0)

  const upsertProducts = useCallback((rows: Product[]) => {
    setProductMap(current => {
      const next = new Map(current)
      for (const row of rows) next.set(row.id, row)
      return next
    })
  }, [])

  const reloadProducts = useCallback(async () => {
    lastFullLoad.current = Date.now()
    const rows: Product[] = []
    // Page through in chunks so very large catalogues never time out a single request.
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from('products').select(PRODUCT_COLUMNS)
        .eq('business_id', businessId).order('name').range(from, from + 999)
      if (error) { setProductsError('Products could not be loaded. Check your connection.'); return }
      rows.push(...(data || []).map(toProduct))
      if (!data || data.length < 1000) break
    }
    setProductMap(new Map(rows.map(row => [row.id, row])))
    setProductsError('')
    setProductsLoaded(true)
  }, [businessId])

  useEffect(() => {
    setProductMap(new Map()); setProductsLoaded(false)
    reloadProducts()
    const channel = supabase.channel(`products-${businessId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products', filter: `business_id=eq.${businessId}` }, payload => {
        if (payload.eventType === 'DELETE') {
          const id = (payload.old as { id?: string }).id
          if (id) setProductMap(current => { const next = new Map(current); next.delete(id); return next })
        } else if (payload.new) {
          upsertProducts([toProduct(payload.new as Record<string, unknown>)])
        }
      })
      .subscribe(status => {
        // After a dropped connection, resync once — at most every two minutes — so a
        // flapping network cannot trigger repeated full catalogue downloads.
        if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && Date.now() - lastFullLoad.current > 120_000) reloadProducts()
      })
    return () => { supabase.removeChannel(channel) }
  }, [businessId, reloadProducts, upsertProducts])

  const staffName = useCallback((userId: string) => {
    if (!staffRequested.current) {
      staffRequested.current = true
      supabase.rpc('list_business_staff', { target_business_id: businessId }).then(({ data }) => {
        if (data) setStaff(Object.fromEntries((data as { user_id: string; full_name: string }[]).map(s => [s.user_id, s.full_name])))
      })
    }
    if (userId === user.id) return 'You'
    return staff[userId] || 'Staff'
  }, [businessId, staff, user.id])

  const products = useMemo(() => [...productMap.values()].sort((a, b) => a.name.localeCompare(b.name)), [productMap])

  const value: AccountContextValue = {
    user, businessId, role: membership.role, business: props.business, subscription: props.subscription,
    memberships: props.memberships, reloadAccount: props.onReload, switchBusiness: props.onSwitch,
    products, productsLoaded, productsError, upsertProducts, reloadProducts, staffName,
  }
  return <AccountContext.Provider value={value}>{props.children}</AccountContext.Provider>
}
