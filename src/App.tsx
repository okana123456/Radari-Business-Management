import { FormEvent, lazy, ReactElement, useCallback, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import { AccountProvider, Business, BUSINESS_COLUMNS, loadMemberships, Membership, pickMembership, rememberBusiness, Subscription, subscriptionActive, useAccount } from './lib/account'
import { can, homePath, Permission } from './lib/roles'
import { friendlyError, money, setBusinessDayStart } from './lib/format'
import { Shell } from './components/Shell'
import { PayForm } from './components/PayForm'

const Dashboard = lazy(() => import('./pages/Dashboard'))
const POS = lazy(() => import('./pages/POS'))
const Inventory = lazy(() => import('./pages/Inventory'))
const Sales = lazy(() => import('./pages/Sales'))
const Expenses = lazy(() => import('./pages/Expenses'))
const Customers = lazy(() => import('./pages/Customers'))
const Suppliers = lazy(() => import('./pages/Suppliers'))
const Purchases = lazy(() => import('./pages/Purchases'))
const Categories = lazy(() => import('./pages/Categories'))
const Credit = lazy(() => import('./pages/Credit'))
const Creditors = lazy(() => import('./pages/Creditors'))
const Loyalty = lazy(() => import('./pages/Loyalty'))
const Accounts = lazy(() => import('./pages/Accounts'))
const Tax = lazy(() => import('./pages/Tax'))
const ProfitLoss = lazy(() => import('./pages/ProfitLoss'))
const Glovo = lazy(() => import('./pages/Glovo'))
const TillPayments = lazy(() => import('./pages/TillPayments'))
const Reports = lazy(() => import('./pages/Reports'))
const Staff = lazy(() => import('./pages/Staff'))
const SubscriptionPage = lazy(() => import('./pages/Subscription'))
const Settings = lazy(() => import('./pages/Settings'))

const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

class NoBusinessError extends Error {}

/** Joins any businesses that invited this user, then creates their own business if they signed up as an owner. */
async function provisionAccount(user: User): Promise<Membership[]> {
  await supabase.rpc('accept_pending_invitations').then(() => undefined, () => undefined)
  const existing = await loadMemberships()
  if (existing.length) return existing
  const metadata = user.user_metadata || {}
  const businessName = String(metadata.business_name || '').trim()
  if (!businessName) throw new NoBusinessError('No business is linked to this account yet. If your employer invited you, ask them to check that they used this exact email address, then sign in again.')
  const baseSlug = String(metadata.business_slug || slugify(businessName)) || 'business'
  const { error } = await supabase.rpc('create_business_account', {
    business_name: businessName,
    business_slug: `${baseSlug}-${user.id.slice(0, 6)}`,
    owner_name: String(metadata.full_name || user.email || 'Business Owner'),
    owner_phone: String(metadata.phone || ''),
  })
  if (error) throw error
  return loadMemberships()
}

function Landing() {
  return <main className="landing">
    <nav className="landing-nav"><strong>Radari</strong><div className="nav-links"><Link to="/login">Sign in</Link><Link className="nav-cta" to="/signup">Create account</Link></div></nav>
    <section className="hero"><span className="eyebrow">Point of sale and business management</span><h1>Sales, stock and profit for Kenyan businesses.</h1>
      <p>Run your till, stock, credit, expenses, staff and VAT records from any phone or computer. KSh 1,500 every 30 days, paid by M-Pesa.</p>
      <Link className="primary" to="/signup">Create your account</Link></section>
    <section className="feature-grid">
      {[['Point of sale', 'Cash, M-Pesa, card, credit and split payments with printable receipts.'],
        ['Stock control', 'Purchases, batches, expiry dates, adjustments and a full audit trail.'],
        ['Finance', 'Expenses, creditors, chart of accounts, profit and loss, and VAT returns.'],
        ['Staff and roles', 'Owners, admins, stock managers, cashiers and accountants each see only what they need.']].map(([title, text]) =>
        <div key={title}><strong>{title}</strong><p>{text}</p></div>)}
    </section>
  </main>
}

function Signup() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [staffMode, setStaffMode] = useState(params.get('staff') === '1')
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    const form = new FormData(event.currentTarget)
    const fullName = String(form.get('fullName') || '').trim(), phone = String(form.get('phone') || '').trim()
    const businessName = staffMode ? '' : String(form.get('businessName') || '').trim(), email = String(form.get('email') || '').trim().toLowerCase()
    try {
      const { data, error: signupError } = await supabase.auth.signUp({
        email, password: String(form.get('password') || ''),
        options: { emailRedirectTo: `${window.location.origin}/login`, data: staffMode ? { full_name: fullName, phone } : { full_name: fullName, phone, business_name: businessName, business_slug: slugify(businessName) } },
      })
      if (signupError) throw signupError
      if (data.session && data.user) navigate('/app')
      else setMessage('Check your email and confirm your account. Then return here and sign in.')
    } catch (caught) { setError(friendlyError(caught, 'Account creation failed')) }
    finally { setBusy(false) }
  }
  return <main className="centered"><section className="card form-card">
    <span className="eyebrow">{staffMode ? 'Join your workplace' : 'Create your business account'}</span>
    <h1>{staffMode ? 'Create your staff login' : 'Start with Radari POS'}</h1>
    <p className="intro">{staffMode ? 'Use the same email address your employer invited. You will join their business when you sign in.' : 'Create your account, then activate it securely with M-Pesa.'}</p>
    <div className="segmented" role="radiogroup" aria-label="Account type">
      <button type="button" role="radio" aria-checked={!staffMode} className={!staffMode ? 'active' : ''} onClick={() => setStaffMode(false)}>I own a business</button>
      <button type="button" role="radio" aria-checked={staffMode} className={staffMode ? 'active' : ''} onClick={() => setStaffMode(true)}>I was invited as staff</button>
    </div>
    <form onSubmit={submit}>
      <label>Full name<input name="fullName" autoComplete="name" required maxLength={120} /></label>
      <label>Phone number<input name="phone" type="tel" placeholder="0712 345 678" autoComplete="tel" required maxLength={30} /></label>
      {!staffMode && <label>Business name<input name="businessName" autoComplete="organization" required minLength={2} maxLength={120} /></label>}
      <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
      <label>Password<input name="password" type="password" minLength={8} autoComplete="new-password" required /></label>
      {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice success" role="status">{message}</div>}
      <button className="primary submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button>
    </form>
    <p className="form-footer">Already registered? <Link to="/login">Sign in</Link></p>
  </section></main>
}

function Login() {
  const navigate = useNavigate(); const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget)
    try {
      const { error: loginError } = await supabase.auth.signInWithPassword({ email: String(form.get('email') || '').trim().toLowerCase(), password: String(form.get('password') || '') })
      if (loginError) throw loginError
      navigate('/app')
    } catch (caught) { setError(friendlyError(caught, 'Sign in failed')) }
    finally { setBusy(false) }
  }
  async function reset(event: React.MouseEvent<HTMLButtonElement>) {
    const email = (event.currentTarget.form?.elements.namedItem('email') as HTMLInputElement | null)?.value.trim().toLowerCase()
    if (!email) { setError('Enter your email address first, then tap “Forgot password”.'); return }
    setError('')
    await supabase.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/reset-password` })
    setNotice('If that email has an account, a password reset link is on its way.')
  }
  return <main className="centered"><section className="card form-card compact"><span className="eyebrow">Welcome back</span><h1>Sign in to Radari</h1>
    <form onSubmit={submit}>
      <label>Email address<input name="email" type="email" autoComplete="email" required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
      {error && <div className="notice error" role="alert">{error}</div>}{notice && <div className="notice success" role="status">{notice}</div>}
      <button className="primary submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      <button type="button" className="text-button" onClick={reset}>Forgot password?</button>
    </form>
    <p className="form-footer">New to Radari? <Link to="/signup">Create account</Link></p></section></main>
}

function ResetPassword() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const password = String(new FormData(event.currentTarget).get('password') || '')
    const { error: updateError } = await supabase.auth.updateUser({ password })
    setBusy(false)
    if (updateError) setError(friendlyError(updateError, 'The password could not be changed. Request a new reset link.')); else navigate('/app')
  }
  return <main className="centered"><section className="card form-card compact"><span className="eyebrow">Account</span><h1>Choose a new password</h1>
    <form onSubmit={submit}><label>New password<input name="password" type="password" minLength={8} autoComplete="new-password" required /></label>
      {error && <div className="notice error" role="alert">{error}</div>}
      <button className="primary submit" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button></form></section></main>
}

function Activation({ membership, onActivated, user }: { membership: Membership; onActivated: () => void; user: User }) {
  const isOwner = membership.role === 'owner'
  return <main className="centered payment-bg"><section className="card payment-card">
    <span className="eyebrow">{isOwner ? `Activate ${membership.businessName}` : membership.businessName}</span>
    {isOwner ? <>
      <h1>{money(1500)}</h1><p className="intro">Get full Radari access for 30 days. Your account activates automatically after M-Pesa confirms payment.</p>
      <PayForm businessId={membership.businessId} defaultPhone={String(user.user_metadata?.phone || '')} label="Pay KSh 1,500" onConfirmed={onActivated} />
    </> : <><h1>Subscription inactive</h1><p className="intro">This business’s Radari subscription is not active. Ask the owner to renew it, then sign in again.</p>
      <button type="button" className="primary submit" onClick={onActivated}>Check again</button></>}
    <button className="text-button" onClick={() => supabase.auth.signOut()}>Sign out</button>
  </section></main>
}

function Guard({ permission, children }: { permission: Permission; children: ReactElement }) {
  const { role } = useAccount()
  return can(role, permission) ? children : <Navigate to={homePath(role)} replace />
}

function HomeRoute() {
  const { role } = useAccount()
  return can(role, 'dashboard') ? <Dashboard /> : <Navigate to={homePath(role)} replace />
}

type Loaded = { memberships: Membership[]; membership: Membership; business: Business; subscription: Subscription | null }

function AccountRoute({ session }: { session: Session | null }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const userId = session?.user.id

  const refresh = useCallback(async () => {
    if (!session?.user) return
    setError('')
    try {
      const memberships = await provisionAccount(session.user)
      const membership = (selected && memberships.find(m => m.businessId === selected)) || pickMembership(memberships)
      if (!membership) throw new NoBusinessError('No business found for this account.')
      const [businessResult, subscriptionResult] = await Promise.all([
        supabase.from('businesses').select(BUSINESS_COLUMNS).eq('id', membership.businessId).single(),
        supabase.from('subscriptions').select('status,current_period_start,current_period_end,grace_ends_at').eq('business_id', membership.businessId).maybeSingle(),
      ])
      if (businessResult.error) throw businessResult.error
      const business = businessResult.data as unknown as Business
      applyBranding(business)
      setLoaded({ memberships, membership: { ...membership, businessName: businessResult.data.name }, business, subscription: subscriptionResult.data as Subscription | null })
    } catch (caught) { setError(caught instanceof NoBusinessError ? caught.message : friendlyError(caught, 'Your account could not be loaded.')) }
    finally { setLoading(false) }
  }, [session?.user, selected]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { refresh() }, [userId, selected]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!session) return <Navigate to="/login" replace />
  if (loading) return <main className="centered"><div className="loader" role="status"><span className="spinner" aria-hidden="true" /> Loading your business</div></main>
  if (error || !loaded) return <main className="centered"><section className="card"><div className="notice error" role="alert">{error || 'Business account not found'}</div>
    <button type="button" className="primary submit" onClick={() => { setLoading(true); refresh() }}>Try again</button>
    <button className="text-button" onClick={() => supabase.auth.signOut()}>Sign out</button></section></main>
  if (!subscriptionActive(loaded.subscription)) return <Activation membership={loaded.membership} user={session.user} onActivated={refresh} />

  return <AccountProvider user={session.user} membership={loaded.membership} memberships={loaded.memberships} business={loaded.business}
    subscription={loaded.subscription} onReload={refresh} onSwitch={id => { rememberBusiness(id); setLoading(true); setSelected(id) }}>
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<HomeRoute />} />
        <Route path="pos" element={<Guard permission="pos"><POS /></Guard>} />
        <Route path="inventory" element={<Guard permission="inventory"><Inventory /></Guard>} />
        <Route path="sales" element={<Guard permission="sales"><Sales /></Guard>} />
        <Route path="expenses" element={<Guard permission="expenses"><Expenses /></Guard>} />
        <Route path="customers" element={<Guard permission="customers"><Customers /></Guard>} />
        <Route path="suppliers" element={<Guard permission="suppliers"><Suppliers /></Guard>} />
        <Route path="purchases" element={<Guard permission="purchases"><Purchases /></Guard>} />
        <Route path="categories" element={<Guard permission="categories"><Categories /></Guard>} />
        <Route path="credit" element={<Guard permission="credit"><Credit /></Guard>} />
        <Route path="creditors" element={<Guard permission="creditors"><Creditors /></Guard>} />
        <Route path="loyalty" element={<Guard permission="loyalty"><Loyalty /></Guard>} />
        <Route path="accounts" element={<Guard permission="accounting"><Accounts /></Guard>} />
        <Route path="tax" element={<Guard permission="tax"><Tax /></Guard>} />
        <Route path="profit-loss" element={<Guard permission="profit"><ProfitLoss /></Guard>} />
        <Route path="mpesa" element={<Guard permission="tillPayments"><TillPayments /></Guard>} />
        <Route path="glovo" element={<Guard permission="glovo"><Glovo /></Guard>} />
        <Route path="reports" element={<Guard permission="reports"><Reports /></Guard>} />
        <Route path="staff" element={<Guard permission="staff"><Staff /></Guard>} />
        <Route path="subscription" element={<SubscriptionPage />} />
        <Route path="settings" element={<Guard permission="settings"><Settings /></Guard>} />
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Route>
    </Routes>
  </AccountProvider>
}

/** Applies the business's brand colour and business-day start hour. */
function applyBranding(business: Business) {
  const root = document.documentElement
  const colour = business.theme_color && /^#[0-9a-f]{6}$/i.test(business.theme_color) ? business.theme_color : '#0f4c81'
  root.style.setProperty('--accent', colour)
  const [r, g, b] = [1, 3, 5].map(i => parseInt(colour.slice(i, i + 2), 16))
  root.style.setProperty('--accent-ink', (r * 299 + g * 587 + b * 114) / 1000 > 160 ? '#111827' : '#ffffff')
  root.style.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.08)`)
  setBusinessDayStart(Number(business.day_start_hour || 0))
}

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => { window.scrollTo(0, 0) }, [pathname])
  return null
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null), [ready, setReady] = useState(false)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      // Token refreshes keep the same user; only swap state when the user actually changes.
      setSession(current => (event === 'TOKEN_REFRESHED' && current?.user.id === nextSession?.user.id) ? current : nextSession)
      setReady(true)
    })
    return () => data.subscription.unsubscribe()
  }, [])
  if (!ready) return <main className="centered"><div className="loader" role="status">Opening Radari…</div></main>
  return <><ScrollToTop /><Routes>
    <Route path="/" element={session ? <Navigate to="/app" replace /> : <Landing />} />
    <Route path="/signup" element={session ? <Navigate to="/app" replace /> : <Signup />} />
    <Route path="/login" element={session ? <Navigate to="/app" replace /> : <Login />} />
    <Route path="/reset-password" element={<ResetPassword />} />
    <Route path="/app/*" element={<AccountRoute session={session} />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes></>
}
