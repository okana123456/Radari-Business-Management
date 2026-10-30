import { ReactNode, useEffect } from 'react'
import { DateRange, presetRange } from '../lib/format'

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return <header className="page-header">
    <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
    {actions && <div className="page-actions">{actions}</div>}
  </header>
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label={title} onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section className={`modal ${wide ? 'wide' : ''}`}>
      <header className="modal-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button></header>
      <div className="modal-body">{children}</div>
    </section>
  </div>
}

export const Loading = ({ label = 'Loading…' }: { label?: string }) =>
  <div className="state-box" role="status"><span className="spinner" aria-hidden="true" />{label}</div>

export const ErrorNotice = ({ message, onRetry }: { message: string; onRetry?: () => void }) =>
  message ? <div className="notice error" role="alert">{message}{onRetry && <button type="button" className="link-button" onClick={onRetry}>Try again</button>}</div> : null

export const Empty = ({ title, children }: { title: string; children?: ReactNode }) =>
  <div className="empty-state"><strong>{title}</strong>{children && <div>{children}</div>}</div>

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'warning' | 'critical' }) {
  return <div className={`stat ${tone || ''}`}>
    <span>{label}</span><strong>{value}</strong>{hint && <small>{hint}</small>}
  </div>
}

export function StatusBadge({ status }: { status: string }) {
  const tone = ({ completed: 'good', active: 'good', accepted: 'good', confirmed: 'good', voided: 'critical', disabled: 'critical', failed: 'critical', suspended: 'critical', grace: 'warning', pending: 'warning', submitted: 'warning', expired: 'muted', revoked: 'muted', cancelled: 'muted' } as Record<string, string>)[status] || 'muted'
  const icon = tone === 'good' ? '✓' : tone === 'critical' ? '✕' : tone === 'warning' ? '!' : '•'
  return <span className={`badge status ${tone}`}><span aria-hidden="true">{icon}</span> {status.replace(/_/g, ' ')}</span>
}

const PRESETS: [string, string][] = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7days', '7 days'], ['month', 'This month'], ['lastmonth', 'Last month'], ['30days', '30 days']]

export function DateRangePicker({ value, onChange }: { value: DateRange; onChange: (range: DateRange) => void }) {
  const active = PRESETS.find(([key]) => { const r = presetRange(key); return r.from === value.from && r.to === value.to })?.[0]
  return <div className="range-picker">
    <div className="chips">{PRESETS.map(([key, label]) =>
      <button type="button" key={key} className={active === key ? 'active' : ''} onClick={() => onChange(presetRange(key))}>{label}</button>)}
    </div>
    <div className="range-inputs">
      <input type="date" aria-label="From date" value={value.from} max={value.to} onChange={e => e.target.value && onChange({ ...value, from: e.target.value })} />
      <span>to</span>
      <input type="date" aria-label="To date" value={value.to} min={value.from} onChange={e => e.target.value && onChange({ ...value, to: e.target.value })} />
    </div>
  </div>
}

export function Pager({ page, hasMore, onPage, loading }: { page: number; hasMore: boolean; onPage: (page: number) => void; loading?: boolean }) {
  if (page === 0 && !hasMore) return null
  return <div className="pager">
    <button type="button" disabled={page === 0 || loading} onClick={() => onPage(page - 1)}>← Previous</button>
    <span>Page {page + 1}</span>
    <button type="button" disabled={!hasMore || loading} onClick={() => onPage(page + 1)}>Next →</button>
  </div>
}

/** Simple single-series bar chart: one hue, thin rounded bars, hover tooltips, table fallback. */
export function BarChart({ data, format, label }: { data: { key: string; label: string; value: number; detail?: string }[]; format: (n: number) => string; label: string }) {
  const max = Math.max(1, ...data.map(d => d.value))
  if (!data.length) return <Empty title="No data for this period" />
  return <figure className="bar-chart" aria-label={label}>
    <div className="bars" role="img" aria-label={`${label}: ${data.map(d => `${d.label} ${format(d.value)}`).join(', ')}`}>
      {data.map(d => <div className="bar-slot" key={d.key} tabIndex={0}>
        <div className="bar" style={{ height: d.value > 0 ? `${Math.max(1.5, (d.value / max) * 100)}%` : 0 }} />
        <div className="bar-tip" role="tooltip"><strong>{d.label}</strong><span>{format(d.value)}</span>{d.detail && <small>{d.detail}</small>}</div>
      </div>)}
    </div>
    <div className="bar-axis"><span>{data[0].label}</span>{data.length > 1 && <span>{data[data.length - 1].label}</span>}</div>
    <figcaption className="chart-caption">Peak {format(max)}</figcaption>
  </figure>
}

/** Horizontal ranked bars for "top N" lists. */
export function RankBars({ rows, format }: { rows: { key: string; label: string; value: number; detail?: string }[]; format: (n: number) => string }) {
  const max = Math.max(1, ...rows.map(r => r.value))
  if (!rows.length) return <Empty title="Nothing to show yet" />
  return <ol className="rank-bars">{rows.map(r => <li key={r.key} title={`${r.label}: ${format(r.value)}${r.detail ? ` · ${r.detail}` : ''}`}>
    <div className="rank-text"><span>{r.label}</span><strong>{format(r.value)}</strong></div>
    <div className="rank-track"><div style={{ width: `${(r.value / max) * 100}%` }} /></div>
    {r.detail && <small>{r.detail}</small>}
  </li>)}</ol>
}
