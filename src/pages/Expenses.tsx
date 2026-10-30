import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { can } from '../lib/roles'
import { businessToday, DateRange, dateOnly, downloadCsv, friendlyError, isoDay, money, paymentLabel, presetRange } from '../lib/format'
import { BarChart, DateRangePicker, Empty, ErrorNotice, Loading, Modal, PageHeader, RankBars, Stat } from '../components/ui'

type Expense = { id: string; category: string; description: string | null; amount: number; payment_method: string; expense_date: string; reference: string | null; created_by: string | null }
const DEFAULT_CATEGORIES = ['Rent', 'Salaries & wages', 'Electricity', 'Water', 'Transport', 'Airtime & internet', 'Repairs', 'Licences & permits', 'Supplies', 'Bank & M-Pesa charges', 'Marketing', 'Other']
const LIMIT = 500

export default function Expenses() {
  const { businessId, role, user, staffName } = useAccount()
  const [range, setRange] = useState<DateRange>(presetRange('month'))
  const [rows, setRows] = useState<Expense[] | null>(null)
  const [error, setError] = useState('')
  const [category, setCategory] = useState('All')
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState<Expense | 'new' | null>(params.get('new') ? 'new' : null)
  const [history, setHistory] = useState<{ expense_date: string; amount: number }[]>([])

  const loadHistory = useCallback(async () => {
    const since = new Date(); since.setMonth(since.getMonth() - 5, 1)
    const { data } = await supabase.from('expenses').select('expense_date,amount').eq('business_id', businessId).gte('expense_date', isoDay(since)).limit(5000)
    setHistory((data || []).map(r => ({ expense_date: r.expense_date as string, amount: Number(r.amount) })))
  }, [businessId])
  useEffect(() => { loadHistory() }, [loadHistory])
  const today = businessToday()
  const todayTotal = history.filter(h => h.expense_date === today).reduce((s, h) => s + h.amount, 0)
  const monthTotal = history.filter(h => h.expense_date.slice(0, 7) === today.slice(0, 7)).reduce((s, h) => s + h.amount, 0)
  const months = useMemo(() => {
    const out: { key: string; label: string; value: number }[] = []
    const d = new Date(); d.setDate(1)
    for (let i = 5; i >= 0; i--) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1)
      const key = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`
      out.push({ key, label: m.toLocaleDateString('en-KE', { month: 'short' }), value: history.filter(h => h.expense_date.startsWith(key)).reduce((s, h) => s + h.amount, 0) })
    }
    return out
  }, [history])
  function closeEditor() { setEditing(null); if (params.get('new')) { params.delete('new'); setParams(params, { replace: true }) } }

  const load = useCallback(async () => {
    setRows(null); setError('')
    const { data, error: loadError } = await supabase.from('expenses')
      .select('id,category,description,amount,payment_method,expense_date,reference,created_by')
      .eq('business_id', businessId).gte('expense_date', range.from).lte('expense_date', range.to)
      .order('expense_date', { ascending: false }).order('created_at', { ascending: false }).limit(LIMIT)
    if (loadError) setError(friendlyError(loadError)); else setRows((data as Expense[]).map(e => ({ ...e, amount: Number(e.amount) })))
  }, [businessId, range])
  useEffect(() => { load() }, [load])

  const categories = useMemo(() => [...new Set([...DEFAULT_CATEGORIES, ...(rows || []).map(r => r.category)])], [rows])
  const shown = (rows || []).filter(r => category === 'All' || r.category === category)
  const total = shown.reduce((sum, r) => sum + r.amount, 0)
  const byCategory = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of rows || []) map.set(r.category, (map.get(r.category) || 0) + r.amount)
    return [...map.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  async function remove(expense: Expense) {
    if (!window.confirm(`Delete the ${money(expense.amount)} ${expense.category} expense?`)) return
    const { error: deleteError } = await supabase.from('expenses').delete().eq('id', expense.id).eq('business_id', businessId)
    if (deleteError) setError(friendlyError(deleteError)); else { load(); loadHistory() }
  }

  return <>
    <PageHeader title="Expenses" subtitle="Running costs that reduce your profit" actions={<>
      <button type="button" className="button secondary" disabled={!shown.length} onClick={() => downloadCsv(`radari-expenses-${range.from}-to-${range.to}.csv`, [['Date', 'Category', 'Description', 'Amount', 'Paid by', 'Reference', 'Recorded by'], ...shown.map(e => [e.expense_date, e.category, e.description, e.amount, paymentLabel(e.payment_method), e.reference, e.created_by ? staffName(e.created_by) : ''])])}>Export CSV</button>
      <button type="button" className="button" onClick={() => setEditing('new')}>Add expense</button>
    </>} />
    <DateRangePicker value={range} onChange={setRange} />
    <ErrorNotice message={error} onRetry={load} />
    {!rows && !error ? <Loading /> : rows && <>
      <div className="stat-grid">
        <Stat label="Today" value={money(todayTotal)} />
        <Stat label="This month" value={money(monthTotal)} />
        <Stat label={category === 'All' ? 'Selected period' : `${category}, selected period`} value={money(total)} hint={`${shown.length} entr${shown.length === 1 ? 'y' : 'ies'}`} />
        {byCategory[0] && <Stat label="Largest category" value={byCategory[0][0]} hint={money(byCategory[0][1])} />}
      </div>
      <div className="panel-grid">
        <section className="panel"><h2>Monthly trend</h2><BarChart label="Expenses per month" format={money} data={months} /></section>
        {byCategory.length > 0 && <section className="panel"><h2>By category</h2><RankBars format={money} rows={byCategory.map(([key, value]) => ({ key, label: key, value }))} /></section>}
      </div>
      {rows.length >= LIMIT && <p className="hint">Showing the latest {LIMIT} expenses. Choose a shorter period to see everything.</p>}
      <div className="toolbar"><select value={category} onChange={e => setCategory(e.target.value)} aria-label="Category"><option>All</option>{byCategory.map(([c]) => <option key={c}>{c}</option>)}</select></div>
      {shown.length === 0 ? <Empty title="No expenses recorded in this period"><button type="button" className="button" onClick={() => setEditing('new')}>Record an expense</button></Empty> :
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Date</th><th>Category</th><th>Description</th><th>Paid by</th><th className="num">Amount</th><th aria-label="Actions" /></tr></thead>
          <tbody>{shown.map(e => <tr key={e.id}>
            <td data-label="Date">{dateOnly(e.expense_date)}</td>
            <td data-label="Category">{e.category}</td>
            <td data-label="Description">{e.description || '—'}{e.reference && <small>Ref {e.reference}</small>}</td>
            <td data-label="Paid by">{paymentLabel(e.payment_method)}</td>
            <td data-label="Amount" className="num">{money(e.amount)}</td>
            <td className="row-actions"><button type="button" onClick={() => setEditing(e)}>Edit</button>{can(role, 'deleteExpense') && <button type="button" onClick={() => remove(e)}>Delete</button>}</td>
          </tr>)}</tbody>
        </table></div>}
    </>}
    {editing && <ExpenseForm expense={editing === 'new' ? null : editing} categories={categories} userId={user.id} onClose={closeEditor} onSaved={() => { closeEditor(); load(); loadHistory() }} />}
  </>
}

function ExpenseForm({ expense, categories, userId, onClose, onSaved }: { expense: Expense | null; categories: string[]; userId: string; onClose: () => void; onSaved: () => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const form = new FormData(event.currentTarget)
    const fields = {
      category: String(form.get('category')).trim(), description: String(form.get('description') || '').trim() || null,
      amount: Number(form.get('amount')), payment_method: String(form.get('method')), expense_date: String(form.get('date')),
      reference: String(form.get('reference') || '').trim() || null,
    }
    const { error: saveError } = expense
      ? await supabase.from('expenses').update(fields).eq('id', expense.id).eq('business_id', businessId)
      : await supabase.from('expenses').insert({ ...fields, business_id: businessId, created_by: userId })
    setBusy(false)
    if (saveError) setError(friendlyError(saveError)); else onSaved()
  }
  return <Modal title={expense ? 'Edit expense' : 'Record expense'} onClose={onClose}>
    <form onSubmit={submit}>
      <div className="form-pair">
        <label>Amount (KSh)<input name="amount" type="number" min="0.01" step="0.01" required defaultValue={expense?.amount} autoFocus /></label>
        <label>Date<input name="date" type="date" required max={businessToday()} defaultValue={expense?.expense_date || businessToday()} /></label>
      </div>
      <label>Category<input name="category" list="expense-categories" required maxLength={60} defaultValue={expense?.category} placeholder="e.g. Rent" /></label>
      <datalist id="expense-categories">{categories.map(c => <option key={c} value={c} />)}</datalist>
      <label>Description<input name="description" maxLength={300} defaultValue={expense?.description || ''} /></label>
      <div className="form-pair">
        <label>Paid by<select name="method" defaultValue={expense?.payment_method || 'cash'}><option value="cash">Cash</option><option value="mpesa">M-Pesa</option><option value="bank">Bank</option><option value="other">Other</option></select></label>
        <label>Reference<input name="reference" maxLength={60} defaultValue={expense?.reference || ''} placeholder="Receipt / M-Pesa code" /></label>
      </div>
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Saving' : 'Save expense'}</button>
    </form>
  </Modal>
}
