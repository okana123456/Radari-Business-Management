import { FormEvent, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAccount } from '../lib/account'
import { friendlyError, money } from '../lib/format'
import { Empty, ErrorNotice, Modal, PageHeader } from '../components/ui'
import { useCategories } from './Inventory'

export default function Categories() {
  const { businessId, products, reloadProducts } = useAccount()
  const { categories, reload } = useCategories()
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [error, setError] = useState('')
  const stats = useMemo(() => {
    const map = new Map<string, { count: number; value: number }>()
    for (const p of products.filter(p => p.active)) {
      const s = map.get(p.category) || { count: 0, value: 0 }
      s.count += 1; s.value += p.stock * p.price
      map.set(p.category, s)
    }
    return map
  }, [products])

  async function remove(name: string) {
    if (!window.confirm(`Delete the category "${name}"? Its products move to General.`)) return
    setError('')
    const { error: rpcError } = await supabase.rpc('delete_category', { target_business_id: businessId, category_name: name })
    if (rpcError) setError(friendlyError(rpcError)); else { reload(); reloadProducts() }
  }

  return <>
    <PageHeader title="Categories" subtitle="Group products at the till and in reports" actions={<button type="button" className="button" onClick={() => setAdding(true)}>Add category</button>} />
    <ErrorNotice message={error} />
    {categories.length === 0 ? <Empty title="No categories yet" /> :
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Category</th><th className="num">Active products</th><th className="num">Stock at selling price</th><th aria-label="Actions" /></tr></thead>
        <tbody>{categories.map(name => <tr key={name}>
          <td data-label="Category"><strong>{name}</strong></td>
          <td data-label="Active products" className="num">{stats.get(name)?.count || 0}</td>
          <td data-label="Stock value" className="num">{money(stats.get(name)?.value || 0)}</td>
          <td className="row-actions"><button type="button" onClick={() => setRenaming(name)}>Rename</button>{name.toLowerCase() !== 'general' && <button type="button" onClick={() => remove(name)}>Delete</button>}</td>
        </tr>)}</tbody>
      </table></div>}
    {(adding || renaming) && <CategoryForm current={renaming} onClose={() => { setAdding(false); setRenaming(null) }} onSaved={() => { setAdding(false); setRenaming(null); reload(); reloadProducts() }} />}
  </>
}

function CategoryForm({ current, onClose, onSaved }: { current: string | null; onClose: () => void; onSaved: () => void }) {
  const { businessId } = useAccount()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const name = String(new FormData(event.currentTarget).get('name') || '').trim()
    const { error: saveError } = current
      ? await supabase.rpc('rename_category', { target_business_id: businessId, old_name: current, new_name: name })
      : await supabase.from('product_categories').insert({ business_id: businessId, name })
    setBusy(false)
    if (saveError) setError(friendlyError(saveError)); else onSaved()
  }
  return <Modal title={current ? `Rename ${current}` : 'Add category'} onClose={onClose}>
    <form onSubmit={submit}>
      <label>Name<input name="name" required maxLength={60} defaultValue={current || ''} autoFocus /></label>
      {current && <p className="hint">Every product in this category moves to the new name. If the name already exists, the two categories are merged.</p>}
      <ErrorNotice message={error} />
      <button className="button" disabled={busy}>{busy ? 'Saving' : 'Save'}</button>
    </form>
  </Modal>
}
