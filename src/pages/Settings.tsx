import { FormEvent, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { roleLabel } from '../lib/roles'
import { friendlyError } from '../lib/format'
import { ErrorNotice, PageHeader } from '../components/ui'
import { ReceiptView } from '../components/Receipt'

export default function Settings() {
  const { business, businessId, memberships, switchBusiness, reloadAccount } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  const [draft, setDraft] = useState(business)
  const [preview, setPreview] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setSaved(false)
    const clean = (value: string | null) => (value || '').trim() || null
    const { error: saveError } = await supabase.from('businesses').update({
      name: draft.name.trim(), phone: clean(draft.phone), email: clean(draft.email), address: clean(draft.address),
      kra_pin: clean(draft.kra_pin)?.toUpperCase() || null, receipt_footer: clean(draft.receipt_footer),
    }).eq('id', businessId)
    setBusy(false)
    if (saveError) { setError(friendlyError(saveError)); return }
    setSaved(true); reloadAccount()
  }

  const field = (key: keyof typeof draft) => ({
    value: (draft[key] as string) || '',
    onChange: (event: { target: { value: string } }) => { setDraft({ ...draft, [key]: event.target.value }); setSaved(false) },
  })

  return <>
    <PageHeader title="Settings" subtitle="Business details shown on receipts" />
    <div className="panel-grid">
      <section className="panel">
        <h2>Business and receipt</h2>
        <form onSubmit={submit}>
          <label>Business name<input required minLength={2} maxLength={120} {...field('name')} /></label>
          <div className="form-pair">
            <label>Phone<input type="tel" maxLength={30} {...field('phone')} /></label>
            <label>Email<input type="email" maxLength={120} {...field('email')} /></label>
          </div>
          <label>Address / location<input maxLength={200} placeholder="e.g. Moi Avenue, Nairobi" {...field('address')} /></label>
          <label>KRA PIN<input maxLength={20} placeholder="P051234567X" {...field('kra_pin')} /></label>
          <label>Receipt message<textarea rows={2} maxLength={300} placeholder="Thank you for your business!" {...field('receipt_footer')} /></label>
          <ErrorNotice message={error} />
          {saved && <div className="notice success" role="status">Settings saved.</div>}
          <div className="modal-actions">
            <button type="button" className="button secondary" onClick={() => setPreview(true)}>Preview receipt</button>
            <button className="button" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
          </div>
        </form>
      </section>
      {memberships.length > 1 && <section className="panel">
        <h2>Your businesses</h2>
        <p className="muted">You have access to more than one business. Choose which one to work in on this device.</p>
        <ul className="simple-list">{memberships.map(m => <li key={m.businessId}>
          <span><strong>{m.businessName}</strong><small>{roleLabel[m.role]}</small></span>
          {m.businessId === businessId ? <span className="badge good">✓ Current</span> : <button type="button" className="button secondary small" onClick={() => switchBusiness(m.businessId)}>Switch</button>}
        </li>)}</ul>
      </section>}
    </div>
    {preview && <ReceiptView business={draft} onClose={() => setPreview(false)} receipt={{
      number: 'R000123', soldAt: new Date().toISOString(), payment: 'mpesa', paymentReference: 'SAMPLE123', total: 350, vat: 48.28, cashier: 'Sample cashier',
      items: [{ name: 'Sugar 1kg', quantity: 1, unitPrice: 200, lineTotal: 200 }, { name: 'Bread 400g', quantity: 2, unitPrice: 75, lineTotal: 150 }],
    }} />}
  </>
}
