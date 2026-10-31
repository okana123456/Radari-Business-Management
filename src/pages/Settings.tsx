import { ChangeEvent, FormEvent, useEffect, useState } from 'react'
import { FunctionsHttpError } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { Business, useAccount } from '../lib/account'
import { can, roleLabel } from '../lib/roles'
import { loadTillConnection, TillConnection } from '../lib/tillPayments'
import { BUSINESS_TYPES, dateTime, friendlyError, money } from '../lib/format'
import { ErrorNotice, PageHeader } from '../components/ui'
import { ReceiptView } from '../components/Receipt'

/** Shrinks an uploaded logo to at most 240px so it stays small in the database and on receipts. */
function resizeLogo(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('The image could not be read.'))
    reader.onload = () => {
      const image = new Image()
      image.onerror = () => reject(new Error('That file is not a supported image.'))
      image.onload = () => {
        const scale = Math.min(1, 240 / Math.max(image.width, image.height))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale)
        canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height)
        const data = canvas.toDataURL('image/png')
        resolve(data.length > 190000 ? canvas.toDataURL('image/jpeg', 0.85) : data)
      }
      image.src = String(reader.result)
    }
    reader.readAsDataURL(file)
  })
}

export default function Settings() {
  const { business, businessId, memberships, switchBusiness, reloadAccount, role } = useAccount()
  const [draft, setDraft] = useState<Business>(business)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  const [preview, setPreview] = useState(false)

  const set = <K extends keyof Business>(key: K, value: Business[K]) => { setDraft(current => ({ ...current, [key]: value })); setSaved(false) }
  const text = (key: keyof Business) => ({ value: (draft[key] as string | null) || '', onChange: (event: { target: { value: string } }) => set(key, event.target.value as never) })

  async function chooseLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    try { set('logo_data', await resizeLogo(file)) } catch (caught) { setError(caught instanceof Error ? caught.message : 'The image could not be used.') }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false)
    const clean = (value: string | null) => (value || '').trim() || null
    const { error: saveError } = await supabase.from('businesses').update({
      name: draft.name.trim(), business_type: draft.business_type, phone: clean(draft.phone), email: clean(draft.email), address: clean(draft.address),
      kra_pin: clean(draft.kra_pin)?.toUpperCase() || null, receipt_footer: clean(draft.receipt_footer),
      mpesa_till: clean(draft.mpesa_till), mpesa_paybill: clean(draft.mpesa_paybill), mpesa_account: clean(draft.mpesa_account),
      mpesa_pochi: clean(draft.mpesa_pochi), mpesa_send_money: clean(draft.mpesa_send_money),
      logo_data: draft.logo_data, theme_color: draft.theme_color || null,
      default_vat_rate: Number(draft.default_vat_rate), min_price_percent: Number(draft.min_price_percent || 0), day_start_hour: Number(draft.day_start_hour || 0),
      loyalty_enabled: draft.loyalty_enabled, loyalty_spend_per_point: Number(draft.loyalty_spend_per_point), loyalty_point_value: Number(draft.loyalty_point_value),
    }).eq('id', businessId)
    setBusy(false)
    if (saveError) { setError(friendlyError(saveError)); return }
    setSaved(true); reloadAccount()
  }

  return <>
    <PageHeader title="Settings" subtitle="Business details, payments, branding and rules" />
    <form onSubmit={submit} style={{ gap: 16 }}>
      <section className="panel"><h2>Business information</h2>
        <div className="form-pair"><label>Business name<input required minLength={2} maxLength={120} {...text('name')} /></label>
          <label>Business type<select value={draft.business_type} onChange={e => set('business_type', e.target.value)}>{BUSINESS_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label></div>
        <p className="hint">The business type decides which units of measure are suggested when adding products.</p>
        <div className="form-row"><label>Phone<input type="tel" maxLength={30} {...text('phone')} /></label>
          <label>Email<input type="email" maxLength={120} {...text('email')} /></label>
          <label>KRA PIN<input maxLength={20} placeholder="P051234567X" {...text('kra_pin')} /></label></div>
        <label>Address or location<input maxLength={200} placeholder="Moi Avenue, Nairobi" {...text('address')} /></label>
      </section>

      <section className="panel"><h2>M-Pesa payment details</h2>
        <p className="hint" style={{ marginTop: -8 }}>Shown to the cashier at checkout so customers know where to pay. Fill in only the options you use.</p>
        <div className="form-row"><label>Buy Goods till number<input inputMode="numeric" maxLength={20} {...text('mpesa_till')} /></label>
          <label>Paybill number<input inputMode="numeric" maxLength={20} {...text('mpesa_paybill')} /></label>
          <label>Paybill account number<input maxLength={40} {...text('mpesa_account')} /></label></div>
        <div className="form-pair"><label>Pochi la Biashara number<input type="tel" maxLength={20} {...text('mpesa_pochi')} /></label>
          <label>Send money phone number<input type="tel" maxLength={20} {...text('mpesa_send_money')} /></label></div>
      </section>

      <section className="panel"><h2>Branding</h2>
        <div className="form-pair">
          <div style={{ display: 'grid', gap: 8 }}><span style={{ fontWeight: 600, fontSize: '.86rem', color: 'var(--ink-2)' }}>Logo</span>
            <div className="logo-preview">{draft.logo_data ? <img src={draft.logo_data} alt="Business logo" /> : <span className="muted">No logo</span>}
              <div className="page-actions"><label className="button secondary small" style={{ display: 'inline-flex' }}>Upload<input type="file" accept="image/*" onChange={chooseLogo} style={{ display: 'none' }} /></label>
                {draft.logo_data && <button type="button" className="button secondary small" onClick={() => set('logo_data', null)}>Remove</button>}</div></div>
            <p className="hint">Shown in the menu and on receipts.</p></div>
          <label>Brand colour<div style={{ display: 'flex', gap: 8 }}><input type="color" value={draft.theme_color || '#0f4c81'} onChange={e => set('theme_color', e.target.value)} style={{ width: 56, padding: 2, height: 42 }} />
            <input value={draft.theme_color || '#0f4c81'} onChange={e => set('theme_color', e.target.value)} pattern="#[0-9a-fA-F]{6}" maxLength={7} /></div></label>
        </div>
      </section>

      <section className="panel"><h2>Sales and tax rules</h2>
        <div className="form-row">
          <label>Default VAT for new products<select value={String(draft.default_vat_rate)} onChange={e => set('default_vat_rate', Number(e.target.value))}><option value="16">16% standard</option><option value="0">Exempt or not VAT registered</option></select></label>
          <label>Lowest price allowed (% of selling price)<input type="number" min="0" max="100" step="1" value={draft.min_price_percent} onChange={e => set('min_price_percent', Number(e.target.value))} /></label>
          <label>Business day starts at<select value={String(draft.day_start_hour)} onChange={e => set('day_start_hour', Number(e.target.value))}>{Array.from({ length: 10 }, (_, h) => <option key={h} value={h}>{h === 0 ? 'Midnight (default)' : `${h}:00 AM`}</option>)}</select></label>
        </div>
        <p className="hint">Price floor example: 80 means a KSh 100 item cannot be discounted below KSh 80 at the till. Products can override it. Business day example: with 7:00 AM, a sale at 6:30 AM counts towards the previous day's figures.</p>
      </section>

      <section className="panel"><h2>Loyalty programme</h2>
        <label className="check"><input type="checkbox" checked={draft.loyalty_enabled} onChange={e => set('loyalty_enabled', e.target.checked)} /> Customers earn points on sales linked to them</label>
        {draft.loyalty_enabled && <div className="form-pair" style={{ marginTop: 12 }}>
          <label>KSh spent for 1 point<input type="number" min="1" step="1" value={draft.loyalty_spend_per_point} onChange={e => set('loyalty_spend_per_point', Number(e.target.value))} /></label>
          <label>Value of 1 point (KSh)<input type="number" min="0" step="0.01" value={draft.loyalty_point_value} onChange={e => set('loyalty_point_value', Number(e.target.value))} /></label>
        </div>}
        {draft.loyalty_enabled && <p className="hint">Customers earn 1 point per {money(draft.loyalty_spend_per_point)}. 100 points are worth {money(100 * Number(draft.loyalty_point_value))} off.</p>}
      </section>

      <section className="panel"><h2>Receipt</h2>
        <label>Receipt message<textarea rows={2} maxLength={300} placeholder="Thank you for your business." {...text('receipt_footer')} /></label>
        <div className="modal-actions" style={{ justifyContent: 'flex-start' }}><button type="button" className="button secondary" onClick={() => setPreview(true)}>Preview receipt</button></div>
      </section>

      <ErrorNotice message={error} />
      {saved && <div className="notice success" role="status">Settings saved.</div>}
      <div className="modal-actions"><button className="button" disabled={busy}>{busy ? 'Saving' : 'Save settings'}</button></div>
    </form>

    {can(role, 'connectTill') && <TillConnectPanel />}

    {memberships.length > 1 && <section className="panel" style={{ marginTop: 16 }}><h2>Your businesses</h2>
      <ul className="simple-list">{memberships.map(m => <li key={m.businessId}><span><strong>{m.businessName}</strong><small>{roleLabel[m.role]}</small></span>
        {m.businessId === businessId ? <span className="badge good">Current</span> : <button type="button" className="button secondary small" onClick={() => switchBusiness(m.businessId)}>Switch</button>}</li>)}</ul></section>}

    {preview && <ReceiptView business={draft} onClose={() => setPreview(false)} receipt={{
      number: 'R000123', soldAt: new Date().toISOString(), payment: 'split', total: 350, vat: 48.28, cashier: 'Sample cashier', discount: 20,
      payments: [{ method: 'cash', amount: 150 }, { method: 'mpesa', amount: 200, reference: 'SFK12ABC' }], tendered: 200,
      items: [{ name: 'Sugar 1kg', quantity: 1, unitPrice: 200, lineTotal: 200, listPrice: 220 }, { name: 'Bread 400g', quantity: 2, unitPrice: 75, lineTotal: 150 }],
    }} />}
  </>
}

async function invokeSetup(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke('till-payments-setup', { body })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const details = await error.context.json().catch(() => null)
      throw new Error(details?.error || 'The request failed.')
    }
    throw error
  }
  if (data?.error) throw new Error(data.error)
  return String(data?.message || 'Done')
}

function TillConnectPanel() {
  const { businessId, business } = useAccount()
  const [connection, setConnection] = useState<TillConnection | null | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [type, setType] = useState<'till' | 'paybill'>('till')
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('')

  const refresh = () => loadTillConnection(businessId).then(c => { setConnection(c); if (c) setType(c.shortcode_type as 'till' | 'paybill') })
  useEffect(() => { refresh() }, [businessId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (window.location.hash === '#mpesa') document.getElementById('mpesa')?.scrollIntoView() }, [connection])

  async function run(action: string, body: Record<string, unknown> = {}) {
    setBusy(action); setError(''); setMessage('')
    try { setMessage(await invokeSetup({ businessId, action, ...body })); setEditing(false); await refresh() }
    catch (caught) { setError(friendlyError(caught, 'The request failed.')); await refresh() }
    finally { setBusy('') }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    run('save', {
      environment: form.get('environment'), shortcodeType: type, shortcode: String(form.get('shortcode') || '').trim(),
      tillNumber: String(form.get('tillNumber') || '').trim(), consumerKey: String(form.get('consumerKey') || '').trim(), consumerSecret: String(form.get('consumerSecret') || '').trim(),
    })
  }

  return <section className="panel" id="mpesa" style={{ marginTop: 16 }}>
    <div className="panel-head"><h2>Automatic M-Pesa payment notifications</h2>
      {connection?.connected && <span className="badge good">Connected</span>}</div>
    <p className="hint" style={{ marginTop: -6 }}>When a customer pays your till or paybill, Safaricom notifies Radari and the payment appears at the till within seconds, ready to attach to the sale. This uses your own Daraja app with the C2B product.</p>
    {connection === undefined ? null : connection && !editing ? <>
      <ul className="simple-list">
        <li><span>Type</span><strong>{connection.shortcode_type === 'till' ? 'Buy Goods till' : 'Paybill'}{connection.environment === 'sandbox' ? ' (sandbox)' : ''}</strong></li>
        <li><span>{connection.shortcode_type === 'till' ? 'Store number' : 'Paybill number'}</span><strong>{connection.shortcode}</strong></li>
        {connection.till_number && <li><span>Till number</span><strong>{connection.till_number}</strong></li>}
        <li><span>Registered with Safaricom</span><strong>{connection.registered_at ? dateTime(connection.registered_at) : 'Not yet'}</strong></li>
        <li><span>Last payment received</span><strong>{connection.last_payment_at ? dateTime(connection.last_payment_at) : 'None yet'}</strong></li>
      </ul>
      {connection.last_error && <div className="notice error">Safaricom: {connection.last_error}</div>}
      <div className="page-actions" style={{ marginTop: 12 }}>
        <button type="button" className="button secondary" onClick={() => setEditing(true)}>Change details</button>
        {connection.environment === 'sandbox' && <button type="button" className="button secondary" disabled={!!busy} onClick={() => run('test', { amount: 10 })}>{busy === 'test' ? 'Sending' : 'Send test payment'}</button>}
        <button type="button" className="button secondary" disabled={!!busy} onClick={() => run('save', { environment: connection.environment, shortcodeType: connection.shortcode_type, shortcode: connection.shortcode, tillNumber: connection.till_number })}>{busy === 'save' ? 'Registering' : 'Register again'}</button>
        <button type="button" className="button danger" disabled={!!busy} onClick={() => { if (window.confirm('Stop receiving M-Pesa notifications in Radari?')) run('disconnect') }}>Disconnect</button>
      </div>
    </> : <form onSubmit={submit}>
      <div className="segmented" role="radiogroup">
        <button type="button" role="radio" aria-checked={type === 'till'} className={type === 'till' ? 'active' : ''} onClick={() => setType('till')}>Buy Goods till</button>
        <button type="button" role="radio" aria-checked={type === 'paybill'} className={type === 'paybill' ? 'active' : ''} onClick={() => setType('paybill')}>Paybill</button>
      </div>
      <div className="form-row">
        <label>{type === 'till' ? 'Store number (head office number)' : 'Paybill number'}<input name="shortcode" inputMode="numeric" required pattern="[0-9]{5,10}" defaultValue={connection?.shortcode || (type === 'paybill' ? business.mpesa_paybill || '' : '')} /></label>
        {type === 'till' && <label>Till number customers pay to<input name="tillNumber" inputMode="numeric" pattern="[0-9]{5,10}" defaultValue={connection?.till_number || business.mpesa_till || ''} /></label>}
        <label>Environment<select name="environment" defaultValue={connection?.environment || 'production'}><option value="production">Production (live payments)</option><option value="sandbox">Sandbox (testing)</option></select></label>
      </div>
      <div className="form-pair">
        <label>Daraja consumer key<input name="consumerKey" autoComplete="off" required={!connection} placeholder={connection ? 'Leave blank to keep the saved key' : ''} /></label>
        <label>Daraja consumer secret<input name="consumerSecret" type="password" autoComplete="new-password" required={!connection} placeholder={connection ? 'Leave blank to keep the saved secret' : ''} /></label>
      </div>
      <p className="hint">Get these from your app on developer.safaricom.co.ke after Safaricom approves it for go-live with the M-Pesa Express or C2B product on this shortcode. For a Buy Goods till, Safaricom registers the store (head office) number, which is on your M-Pesa business portal and is different from the till number. Credentials are stored on the server and are never shown to staff. In production, Safaricom allows the notification address to be set once per shortcode; if it was registered elsewhere before, ask Safaricom to clear it first.</p>
      <div className="modal-actions">
        {connection && <button type="button" className="button secondary" onClick={() => setEditing(false)}>Cancel</button>}
        <button className="button" disabled={!!busy}>{busy === 'save' ? 'Connecting' : 'Save and connect'}</button>
      </div>
    </form>}
    <ErrorNotice message={error} />
    {message && <div className="notice success" role="status" style={{ marginTop: 10 }}>{message}</div>}
  </section>
}
