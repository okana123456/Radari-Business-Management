import { FormEvent, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'

type BusinessAccount = { businessId: string; businessName: string; phone: string; subscriptionStatus: string }
const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

async function loadBusinessAccount(user: User): Promise<BusinessAccount | null> {
  const { data: membership, error } = await supabase
    .from('business_memberships')
    .select('business_id, businesses(name), subscriptions(status)')
    .eq('user_id', user.id).eq('status', 'active').limit(1).maybeSingle()
  if (error) throw error
  if (!membership) return null
  const business = Array.isArray(membership.businesses) ? membership.businesses[0] : membership.businesses
  const subscription = Array.isArray(membership.subscriptions) ? membership.subscriptions[0] : membership.subscriptions
  return {
    businessId: membership.business_id,
    businessName: business?.name || 'My Business',
    phone: String(user.user_metadata?.phone || ''),
    subscriptionStatus: subscription?.status || 'pending',
  }
}

async function provisionBusiness(user: User): Promise<BusinessAccount> {
  const existing = await loadBusinessAccount(user)
  if (existing) return existing
  const metadata = user.user_metadata || {}
  const businessName = String(metadata.business_name || '').trim()
  if (!businessName) throw new Error('Business details are missing. Please create the account again.')
  const baseSlug = String(metadata.business_slug || slugify(businessName)) || 'business'
  const { error } = await supabase.rpc('create_business_account', {
    business_name: businessName,
    business_slug: `${baseSlug}-${user.id.slice(0, 6)}`,
    owner_name: String(metadata.full_name || user.email || 'Business Owner'),
    owner_phone: String(metadata.phone || ''),
  })
  if (error) throw error
  const created = await loadBusinessAccount(user)
  if (!created) throw new Error('The business account could not be loaded.')
  return created
}

function Landing() {
  return <main className="landing">
    <nav><strong>Radari POS</strong><div className="nav-links"><Link to="/login">Sign in</Link><Link className="nav-cta" to="/signup">Create account</Link></div></nav>
    <section className="hero"><span className="eyebrow">Built for Kenyan businesses</span><h1>See every sale. Know every stock level.</h1><p>Run sales, stock, expenses and business reports from any device for KSh 1,500 every 30 days.</p><Link className="primary" to="/signup">Start using Radari</Link></section>
  </main>
}

function Signup() {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    const form = new FormData(event.currentTarget)
    const fullName = String(form.get('fullName') || '').trim(), phone = String(form.get('phone') || '').trim()
    const businessName = String(form.get('businessName') || '').trim(), email = String(form.get('email') || '').trim().toLowerCase()
    try {
      const { data, error: signupError } = await supabase.auth.signUp({
        email, password: String(form.get('password') || ''),
        options: { emailRedirectTo: `${window.location.origin}/login`, data: { full_name: fullName, phone, business_name: businessName, business_slug: slugify(businessName) } },
      })
      if (signupError) throw signupError
      if (data.session && data.user) { await provisionBusiness(data.user); navigate('/app') }
      else setMessage('Check your email and confirm your account. Then return here and sign in.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Account creation failed') }
    finally { setBusy(false) }
  }
  return <main className="centered"><section className="card form-card">
    <span className="eyebrow">Create your business account</span><h1>Start with Radari POS</h1><p className="intro">Create your account, then activate it securely with M-Pesa.</p>
    <form onSubmit={submit}><label>Full name<input name="fullName" autoComplete="name" required /></label><label>Phone number<input name="phone" type="tel" placeholder="0712 345 678" autoComplete="tel" required /></label><label>Business name<input name="businessName" autoComplete="organization" required /></label><label>Email address<input name="email" type="email" autoComplete="email" required /></label><label>Password<input name="password" type="password" minLength={8} autoComplete="new-password" required /></label>{error && <div className="notice error">{error}</div>}{message && <div className="notice success">{message}</div>}<button className="primary submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'}</button></form>
    <p className="form-footer">Already registered? <Link to="/login">Sign in</Link></p>
  </section></main>
}

function Login() {
  const navigate = useNavigate(); const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget)
    try {
      const { data, error: loginError } = await supabase.auth.signInWithPassword({ email: String(form.get('email') || '').trim().toLowerCase(), password: String(form.get('password') || '') })
      if (loginError) throw loginError
      await provisionBusiness(data.user); navigate('/app')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Sign in failed') }
    finally { setBusy(false) }
  }
  return <main className="centered"><section className="card form-card compact"><span className="eyebrow">Welcome back</span><h1>Sign in to Radari</h1><form onSubmit={submit}><label>Email address<input name="email" type="email" autoComplete="email" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label>{error && <div className="notice error">{error}</div>}<button className="primary submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button></form><p className="form-footer">New to Radari? <Link to="/signup">Create account</Link></p></section></main>
}

function Activation({ account, onActivated }: { account: BusinessAccount; onActivated: () => void }) {
  const [phone, setPhone] = useState(account.phone), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('')
  useEffect(() => {
    if (!message) return
    const timer = window.setInterval(async () => { const { data } = await supabase.from('subscriptions').select('status').eq('business_id', account.businessId).single(); if (data && ['active', 'grace'].includes(data.status)) { window.clearInterval(timer); onActivated() } }, 5000)
    return () => window.clearInterval(timer)
  }, [account.businessId, message, onActivated])
  async function pay(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('')
    try {
      const { data, error: invokeError } = await supabase.functions.invoke('initiate-subscription-payment', { body: { businessId: account.businessId, phone } })
      if (invokeError) throw invokeError
      if (data?.error) throw new Error(data.error)
      setMessage(data?.message || 'Check your phone and enter your M-Pesa PIN.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Payment request failed') }
    finally { setBusy(false) }
  }
  return <main className="centered payment-bg"><section className="card payment-card"><span className="eyebrow">Activate {account.businessName}</span><h1>KSh 1,500</h1><p className="intro">Get full Radari access for 30 days. Your account activates automatically after M-Pesa confirms payment.</p><form onSubmit={pay}><label>M-Pesa phone number<input value={phone} onChange={(event) => setPhone(event.target.value)} type="tel" required /></label>{error && <div className="notice error">{error}</div>}{message && <div className="notice success">{message}</div>}<button className="primary submit" disabled={busy}>{busy ? 'Sending request…' : 'Pay KSh 1,500'}</button></form><button className="text-button" onClick={() => supabase.auth.signOut()}>Sign out</button></section></main>
}

function Dashboard({ account }: { account: BusinessAccount }) {
  return <main className="dashboard"><header><div><span className="eyebrow">Radari POS</span><h1>{account.businessName}</h1></div><button className="secondary-button" onClick={() => supabase.auth.signOut()}>Sign out</button></header><section className="welcome-panel"><h2>Your business is active</h2><p>The secure account and subscription foundation is ready. Sales, stock and reports are the next module being connected.</p></section></main>
}

function AccountRoute({ session }: { session: Session | null }) {
  const [account, setAccount] = useState<BusinessAccount | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const refresh = async () => { if (!session?.user) return; try { setAccount(await provisionBusiness(session.user)) } catch (caught) { setError(caught instanceof Error ? caught.message : 'Account could not be loaded') } finally { setLoading(false) } }
  useEffect(() => { refresh() }, [session?.user.id])
  if (!session) return <Navigate to="/login" replace />
  if (loading) return <main className="centered"><div className="loader">Loading your business…</div></main>
  if (error || !account) return <main className="centered"><section className="card"><div className="notice error">{error || 'Business account not found'}</div></section></main>
  return ['active', 'grace'].includes(account.subscriptionStatus) ? <Dashboard account={account} /> : <Activation account={account} onActivated={refresh} />
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null), [ready, setReady] = useState(false)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true) })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); setReady(true) })
    return () => data.subscription.unsubscribe()
  }, [])
  if (!ready) return <main className="centered"><div className="loader">Opening Radari…</div></main>
  return <Routes><Route path="/" element={<Landing />} /><Route path="/signup" element={session ? <Navigate to="/app" replace /> : <Signup />} /><Route path="/login" element={session ? <Navigate to="/app" replace /> : <Login />} /><Route path="/app" element={<AccountRoute session={session} />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes>
}
