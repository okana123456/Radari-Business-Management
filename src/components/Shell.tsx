import { Suspense, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { daysLeft, useAccount } from '../lib/account'
import { can, Permission, roleLabel } from '../lib/roles'
import { dateOnly } from '../lib/format'
import { Loading } from './ui'

type Item = { to: string; label: string; icon: string; permission: Permission; end?: boolean }
const NAV: Item[] = [
  { to: '/app', label: 'Overview', icon: '◧', permission: 'dashboard', end: true },
  { to: '/app/pos', label: 'Sell', icon: '🛒', permission: 'pos' },
  { to: '/app/inventory', label: 'Inventory', icon: '📦', permission: 'inventory' },
  { to: '/app/sales', label: 'Sales', icon: '🧾', permission: 'sales' },
  { to: '/app/expenses', label: 'Expenses', icon: '💸', permission: 'expenses' },
  { to: '/app/customers', label: 'Customers', icon: '👥', permission: 'customers' },
  { to: '/app/suppliers', label: 'Suppliers', icon: '🚚', permission: 'suppliers' },
  { to: '/app/reports', label: 'Reports', icon: '📊', permission: 'reports' },
  { to: '/app/staff', label: 'Staff', icon: '🪪', permission: 'staff' },
  { to: '/app/subscription', label: 'Subscription', icon: '⏱', permission: 'subscription' },
  { to: '/app/settings', label: 'Settings', icon: '⚙', permission: 'settings' },
]

export function Shell() {
  const { business, businessId, role, subscription, user, memberships, switchBusiness } = useAccount()
  const location = useLocation()
  const [moreOpen, setMoreOpen] = useState(false)
  const items = NAV.filter(item => can(role, item.permission))
  const primary = items.slice(0, 4)
  const secondary = items.slice(4)
  const remaining = daysLeft(subscription)
  const inGrace = subscription?.status === 'grace' || (remaining !== null && remaining <= 0)
  const isPos = location.pathname.startsWith('/app/pos')

  return <div className={`app-shell ${isPos ? 'pos-mode' : ''}`}>
    <aside className="sidebar" aria-label="Main navigation">
      <div className="brand"><strong>Radari</strong><span title={business.name}>{business.name}</span></div>
      <nav className="side-nav">{items.map(item =>
        <NavLink key={item.to} to={item.to} end={item.end}><span aria-hidden="true">{item.icon}</span>{item.label}</NavLink>)}
      </nav>
      <div className="side-footer">
        {memberships.length > 1 && <select aria-label="Switch business" value={businessId} onChange={event => switchBusiness(event.target.value)}>
          {memberships.map(m => <option key={m.businessId} value={m.businessId}>{m.businessName}</option>)}</select>}
        <small>{String(user.email)}</small><small>{roleLabel[role]}</small>
        <button type="button" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </aside>

    <div className="main-column">
      {remaining !== null && (inGrace || remaining <= 5) && <div className={`renew-banner ${inGrace ? 'critical' : ''}`} role="status">
        <span aria-hidden="true">{inGrace ? '⚠' : '⏱'}</span>
        {inGrace
          ? <span>Subscription expired{subscription?.grace_ends_at ? ` — access ends ${dateOnly(subscription.grace_ends_at)}` : ''}.</span>
          : <span>Subscription renews in {remaining} day{remaining === 1 ? '' : 's'} ({dateOnly(subscription!.current_period_end!)}).</span>}
        {can(role, 'paySubscription') ? <NavLink to="/app/subscription">Renew now</NavLink> : <span>Ask the owner to renew.</span>}
      </div>}
      <main className="page" id="main">
        <Suspense fallback={<Loading />}><Outlet /></Suspense>
      </main>
    </div>

    <nav className="bottom-nav" aria-label="Main navigation">
      {primary.map(item => <NavLink key={item.to} to={item.to} end={item.end} onClick={() => setMoreOpen(false)}>
        <span aria-hidden="true">{item.icon}</span>{item.label}</NavLink>)}
      <button type="button" className={moreOpen ? 'active' : ''} onClick={() => setMoreOpen(open => !open)} aria-expanded={moreOpen}>
        <span aria-hidden="true">☰</span>More</button>
    </nav>
    {moreOpen && <div className="more-sheet" onClick={() => setMoreOpen(false)}>
      <div className="more-panel" onClick={event => event.stopPropagation()}>
        <div className="more-head"><strong>{business.name}</strong><small>{String(user.email)} · {roleLabel[role]}</small></div>
        {memberships.length > 1 && <select aria-label="Switch business" value={businessId} onChange={event => { setMoreOpen(false); switchBusiness(event.target.value) }}>
          {memberships.map(m => <option key={m.businessId} value={m.businessId}>{m.businessName}</option>)}</select>}
        {secondary.map(item => <NavLink key={item.to} to={item.to} onClick={() => setMoreOpen(false)}><span aria-hidden="true">{item.icon}</span>{item.label}</NavLink>)}
        <button type="button" onClick={() => supabase.auth.signOut()}>Sign out</button>
      </div>
    </div>}
  </div>
}
