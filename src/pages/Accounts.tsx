import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { businessToday, dateOnly, downloadCsv, friendlyError, money, titleCase } from '../lib/format'
import { Empty, ErrorNotice, Loading, Modal, PageHeader, Stat } from '../components/ui'

type Account = { id: string; code: string; name: string; account_type: string; opening_balance: number; active: boolean; debits: number; credits: number; balance: number }
type Entry = { id: string; entry_date: string; reference: string; description: string; debit_account_id: string; credit_account_id: string; amount: number; created_by: string | null }
const TYPES = ['asset', 'liability', 'equity', 'revenue', 'expense']
const STARTER: [string, string, string][] = [
  ['1000', 'Cash on hand', 'asset'], ['1010', 'M-Pesa account', 'asset'], ['1020', 'Bank account', 'asset'], ['1100', 'Accounts receivable', 'asset'], ['1200', 'Inventory', 'asset'],
  ['2000', 'Accounts payable', 'liability'], ['2100', 'VAT payable', 'liability'], ['2200', 'Loans', 'liability'], ['3000', "Owner's equity", 'equity'],
  ['4000', 'Sales revenue', 'revenue'], ['5000', 'Cost of goods sold', 'expense'], ['6000', 'Rent', 'expense'], ['6100', 'Salaries and wages', 'expense'], ['6200', 'Utilities', 'expense'],
]

export default function Accounts() {
  const { businessId, role, staffName } = useAccount()
  const [tab, setTab] = useState<'accounts' | 'journal'>('accounts')
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [error, setError] = useState('')
  const [addingAccount, setAddingAccount] = useState(false)
  const [addingEntry, setAddingEntry] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setError('')
    const [a, j] = await Promise.all([
      supabase.from('account_balances').select('id,code,name,account_type,opening_balance,active,debits,credits,balance').eq('business_id', businessId).order('code'),
      supabase.from('journal_entries').select('id,entry_date,reference,description,debit_account_id,credit_account_id,amount,created_by').eq('business_id', businessId).order('entry_date', { ascending: false }).order('created_at', { ascending: false }).limit(300),
    ])
    if (a.error || j.error) { setError(friendlyError(a.error || j.error)); return }
    setAccounts((a.data as Account[]).map(x => ({ ...x, opening_balance: Number(x.opening_balance), debits: Number(x.debits), credits: Number(x.credits), balance: Number(x.balance) })))
    setEntries((j.data as Entry[]).map(x => ({ ...x, amount: Number(x.amount) })))
  }, [businessId])
  useEffect(() => { load() }, [load])

  const names = useMemo(() => new Map((accounts || []).map(a => [a.id, `${a.code} ${a.name}`])), [accounts])
  const totals = useMemo(() => Object.fromEntries(TYPES.map(t => [t, (accounts || []).filter(a => a.account_type === t).reduce((s, a) => s + a.balance, 0)])), [accounts])

  async function createStarter() {
    setBusy(true); setError('')
    const { error: insertError } = await supabase.from('accounts').insert(STARTER.map(([code, name, account_type]) => ({ business_id: businessId, code, name, account_type })))
    setBusy(false)
    if (insertError) setError(friendlyError(insertError)); else load()
  }

  async function removeEntry(entry: Entry) {
    if (!window.confirm(`Delete journal entry ${entry.reference}?`)) return
    const { error: deleteError } = await supabase.from('journal_entries').delete().eq('id', entry.id).eq('business_id', businessId)
    if (deleteError) setError(friendlyError(deleteError)); else load()
  }

  return <>
    <PageHeader title="Accounts and journal" subtitle="Chart of accounts and manual double-entry journal" actions={<>
      {tab === 'journal' && <button type="button" className="button secondary" disabled={!entries?.length} onClick={() => downloadCsv('radari-journal.csv', [['Date', 'Reference', 'Description', 'Debit', 'Credit', 'Amount'], ...(entries || []).map(e => [e.entry_date, e.reference, e.description, names.get(e.debit_account_id), names.get(e.credit_account_id), e.amount])])}>Export</button>}
      {tab === 'accounts' ? <button type="button" className="button" onClick={() => setAddingAccount(true)}>Add account</button>
        : <button type="button" className="button" disabled={(accounts?.length || 0) < 2} onClick={() => setAddingEntry(true)}>Add entry</button>}
    </>} />
    <div className="tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'accounts'} className={tab === 'accounts' ? 'active' : ''} onClick={() => setTab('accounts')}>Chart of accounts</button>
      <button type="button" role="tab" aria-selected={tab === 'journal'} className={tab === 'journal' ? 'active' : ''} onClick={() => setTab('journal')}>Journal entries</button>
    </div>
    <ErrorNotice message={error} onRetry={load} />
    {!accounts || !entries ? <Loading /> : tab === 'accounts' ? <>
      {accounts.length > 0 && <div className="stat-grid">{TYPES.map(t => <Stat key={t} label={`${titleCase(t)} total`} value={money(totals[t])} />)}</div>}
      {accounts.length === 0 ? <Empty title="No accounts yet"><p>Start with a standard set of accounts for a Kenyan small business, or add your own.</p>
        <button type="button" className="button" disabled={busy} onClick={createStarter}>{busy ? 'Creating' : 'Create standard accounts'}</button></Empty> :
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Code</th><th>Account</th><th>Type</th><th className="num">Opening</th><th className="num">Debits</th><th className="num">Credits</th><th className="num">Balance</th></tr></thead>
          <tbody>{accounts.map(a => <tr key={a.id} className={a.active ? '' : 'row-muted'}>
            <td data-label="Code">{a.code}</td><td data-label="Account"><strong>{a.name}</strong></td><td data-label="Type">{titleCase(a.account_type)}</td>
            <td data-label="Opening" className="num">{money(a.opening_balance)}</td><td data-label="Debits" className="num">{money(a.debits)}</td>
            <td data-label="Credits" className="num">{money(a.credits)}</td><td data-label="Balance" className="num"><strong>{money(a.balance)}</strong></td>
          </tr>)}</tbody>
        </table></div>}
      <p className="hint">Balances: assets and expenses increase with debits; liabilities, equity and revenue increase with credits. Sales, purchases and expenses recorded elsewhere in Radari are not posted here automatically.</p>
    </> : entries.length === 0 ? <Empty title="No journal entries yet" /> :
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Date</th><th>Reference</th><th>Description</th><th>Debit</th><th>Credit</th><th className="num">Amount</th><th aria-label="Actions" /></tr></thead>
        <tbody>{entries.map(e => <tr key={e.id}>
          <td data-label="Date">{dateOnly(e.entry_date)}</td><td data-label="Reference">{e.reference}</td>
          <td data-label="Description">{e.description}{e.created_by && <small>By {staffName(e.created_by)}</small>}</td>
          <td data-label="Debit">{names.get(e.debit_account_id)}</td><td data-label="Credit">{names.get(e.credit_account_id)}</td>
          <td data-label="Amount" className="num">{money(e.amount)}</td>
          <td className="row-actions">{can(role, 'voidSale') && <button type="button" onClick={() => removeEntry(e)}>Delete</button>}</td>
        </tr>)}</tbody>
      </table></div>}
    {addingAccount && <AccountForm onClose={() => setAddingAccount(false)} onSaved={() => { setAddingAccount(false); load() }} />}
    {addingEntry && accounts && <EntryForm accounts={accounts.filter(a => a.active)} nextRef={`JE${String((entries?.length || 0) + 1).padStart(3, '0')}`} onClose={() => setAddingEntry(false)} onSaved={() => { setAddingEntry(false); load() }} />}
  </>
}

function AccountForm({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const { error: saveError } = await supabase.from('accounts').insert({ business_id: businessId, code: String(form.get('code')).trim(), name: String(form.get('name')).trim(), account_type: String(form.get('type')), opening_balance: Number(form.get('opening') || 0) })
    setBusy(false)
    if (saveError) setError(/duplicate/i.test(saveError.message) ? 'Another account already uses that code.' : friendlyError(saveError)); else onSaved()
  }
  return <Modal title="Add account" onClose={onClose}>
    <form onSubmit={submit}>
      <div className="form-pair"><label>Code<input name="code" required maxLength={20} placeholder="1000" autoFocus /></label>
        <label>Type<select name="type" required>{TYPES.map(t => <option key={t} value={t}>{titleCase(t)}</option>)}</select></label></div>
      <label>Account name<input name="name" required maxLength={120} placeholder="Cash at bank" /></label>
      <label>Opening balance (KSh)<input name="opening" type="number" step="0.01" defaultValue="0" /></label>
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Saving' : 'Add account'}</button>
    </form>
  </Modal>
}

function EntryForm({ accounts, nextRef, onClose, onSaved }: { accounts: Account[]; nextRef: string; onClose: () => void; onSaved: () => void }) {
  const { businessId, user } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    const form = new FormData(event.currentTarget)
    const debit = String(form.get('debit')), credit = String(form.get('credit'))
    if (debit === credit) { setError('Debit and credit accounts must be different.'); return }
    setBusy(true)
    const { error: saveError } = await supabase.from('journal_entries').insert({ business_id: businessId, entry_date: String(form.get('date')), reference: String(form.get('reference')).trim(), description: String(form.get('description')).trim(), debit_account_id: debit, credit_account_id: credit, amount: Number(form.get('amount')), created_by: user.id })
    setBusy(false)
    if (saveError) setError(friendlyError(saveError)); else onSaved()
  }
  const options = accounts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)
  return <Modal title="Add journal entry" onClose={onClose}>
    <form onSubmit={submit}>
      <div className="form-pair"><label>Date<input name="date" type="date" required defaultValue={businessToday()} /></label><label>Reference<input name="reference" required maxLength={40} defaultValue={nextRef} /></label></div>
      <label>Description<input name="description" required maxLength={300} placeholder="Office supplies purchase" autoFocus /></label>
      <div className="form-pair"><label>Debit account<select name="debit" required>{options}</select></label><label>Credit account<select name="credit" required defaultValue={accounts[1]?.id}>{options}</select></label></div>
      <label>Amount (KSh)<input name="amount" type="number" min="0.01" step="0.01" required /></label>
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Saving' : 'Add entry'}</button>
    </form>
  </Modal>
}
