import { Suspense, useEffect, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { daysLeft, useAccount } from '../lib/account'
import { can, Permission, roleLabel } from '../lib/roles'
import { dateOnly } from '../lib/format'
import { Loading } from './ui'

type Item = { to: string; label: string; permission: Permission; end?: boolean }
const GROUPS: { title: string; items: Item[] }[] = [
  { title: 'Sales', items: [
    { to: '/app', label: 'Overview', permission: 'dashboard', end: true },
    { to: '/app/pos', label: 'Point of sale', permission: 'pos' },
    { to: '/app/sales', label: 'Sales history', permission: 'sales' },
    { to: '/app/credit', label: 'Credit sales', permission: 'credit' },
  ] },
  { title: 'Stock', items: [
    { to: '/app/inventory', label: 'Inventory', permission: 'inventory' },
    { to: '/app/categories', label: 'Categories', permission: 'categories' },
    { to: '/app/purchases', label: 'Purchases', permission: 'purchases' },
    { to: '/app/suppliers', label: 'Suppliers', permission: 'suppliers' },
  ] },
  { title: 'Customers', items: [
    { to: '/app/customers', label: 'Customers', permission: 'customers' },
    { to: '/app/loyalty', label: 'Loyalty points', permission: 'loyalty' },
  ] },
  { title: 'Finance', items: [
    { to: '/app/expenses', label: 'Expenses', permission: 'expenses' },
    { to: '/app/creditors', label: 'Creditors', permission: 'creditors' },
    { to: '/app/accounts', label: 'Accounts and journal', permission: 'accounting' },
    { to: '/app/profit-loss', label: 'Profit and loss', permission: 'profit' },
    { to: '/app/tax', label: 'VAT and KRA', permission: 'tax' },
    { to: '/app/reports', label: 'Reports', permission: 'reports' },
  ] },
  { title: 'Administration', items: [
    { to: '/app/glovo', label: 'Glovo export', permission: 'glovo' },
    { to: '/app/staff', label: 'Staff and users', permission: 'staff' },
    { to: '/app/subscription', label: 'Subscription', permission: 'subscription' },
    { to: '/app/settings', label: 'Settings', permission: 'settings' },
  ] },
]
const PRIMARY = ['/app', '/app/pos', '/app/inventory', '/app/sales']

export function Shell() {
  const { business, businessId, role, subscription, user, memberships, switchBusiness } = useAccount()
  const location = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  const groups = GROUPS.map(g => ({ ...g, items: g.items.filter(i => can(role, i.permission)) })).filter(g => g.items.length)
  const all = groups.flatMap(g => g.items)
  const primary = PRIMARY.map(path => all.find(i => i.to === path)).filter(Boolean).slice(0, 4) as Item[]
  const remaining = daysLeft(subscription)
  const inGrace = subscription?.status === 'grace' || (remaining !== null && remaining <= 0)
  const isPos = location.pathname.startsWith('/app/pos')

  useEffect(() => { setMoreOpen(false) }, [location.pathname])

  const switcher = memberships.length > 1 && <select aria-label="Switch business" value={businessId} onChange={event => switchBusiness(event.target.value)}>
    {memberships.map(m => <option key={m.businessId} value={m.businessId}>{m.businessName}</option>)}</select>

  const nav = (onNavigate?: () => void) => groups.map(group => <div className="nav-group" key={group.title}>
    <span>{group.title}</span>
    {group.items.map(item => <NavLink key={item.to} to={item.to} end={item.end} onClick={onNavigate}>{item.label}</NavLink>)}
  </div>)

  return <div className={`app-shell ${isPos ? 'pos-mode' : ''}`}>
    <aside className="sidebar" aria-label="Main navigation">
      <div className="brand">
        {business.logo_data && <img src={business.logo_data} alt="" />}
        <div><strong title={business.name}>{business.name}</strong><span>Radari</span></div>
      </div>
      <nav className="side-nav">{nav()}</nav>
      <div className="side-footer">
        {switcher}
        <small>{String(user.email)}</small><small>{roleLabel[role]}</small>
        <button type="button" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </aside>

    <div className="main-column">
      {remaining !== null && (inGrace || remaining <= 5) && <div className={`renew-banner ${inGrace ? 'critical' : ''}`} role="status">
        {inGrace
          ? <span>Subscription expired{subscription?.grace_ends_at ? `. Access ends ${dateOnly(subscription.grace_ends_at)}` : ''}.</span>
          : <span>Subscription renews in {remaining} day{remaining === 1 ? '' : 's'} ({dateOnly(subscription!.current_period_end!)}).</span>}
        {can(role, 'paySubscription') ? <NavLink to="/app/subscription">Renew now</NavLink> : <span>Ask the owner to renew.</span>}
      </div>}
      <main className="page" id="main">
        <Suspense fallback={<Loading />}><Outlet /></Suspense>
      </main>
    </div>

    <nav className="bottom-nav" aria-label="Main navigation">
      {primary.map(item => <NavLink key={item.to} to={item.to} end={item.end}>
        {item.to === '/app' ? 'Overview' : item.to === '/app/pos' ? 'Sell' : item.to === '/app/inventory' ? 'Stock' : 'Sales'}</NavLink>)}
      <button type="button" className={moreOpen ? 'active' : ''} onClick={() => setMoreOpen(open => !open)} aria-expanded={moreOpen}>Menu</button>
    </nav>
    {moreOpen && <div className="more-sheet" onClick={() => setMoreOpen(false)}>
      <div className="more-panel" onClick={event => event.stopPropagation()}>
        <div className="more-head"><strong>{business.name}</strong><small>{String(user.email)} · {roleLabel[role]}</small></div>
        {switcher}
        {nav(() => setMoreOpen(false))}
        <button type="button" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </div>}
  </div>
}
