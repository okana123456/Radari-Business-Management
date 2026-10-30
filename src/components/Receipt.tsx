import type { Business } from '../lib/account'
import { dateTime, money, paymentLabel, qty } from '../lib/format'

export type ReceiptData = {
  number: string; soldAt: string; payment: string; total: number; vat: number
  items: { name: string; quantity: number; unitPrice: number; lineTotal: number }[]
  cashier?: string; customer?: string | null; paymentReference?: string | null; status?: string; voidReason?: string | null
}

export function ReceiptView({ business, receipt, onClose, reprint }: { business: Business; receipt: ReceiptData; onClose: () => void; reprint?: boolean }) {
  return <div className="pos-modal receipt-modal" role="dialog" aria-modal="true" aria-label={`Receipt ${receipt.number}`}>
    <section className="receipt-paper">
      <div className="receipt-print">
        <h2>{business.name}</h2>
        {business.address && <p>{business.address}</p>}
        {business.phone && <p>Tel: {business.phone}</p>}
        {business.kra_pin && <p>KRA PIN: {business.kra_pin}</p>}
        <hr />
        <p>Receipt: <strong>{receipt.number}</strong>{reprint && ' (copy)'}</p>
        <p>{dateTime(receipt.soldAt)}</p>
        {receipt.cashier && <p>Served by: {receipt.cashier}</p>}
        {receipt.customer && <p>Customer: {receipt.customer}</p>}
        {receipt.status === 'voided' && <p className="void-stamp">VOIDED{receipt.voidReason ? ` — ${receipt.voidReason}` : ''}</p>}
        <hr />
        {receipt.items.map((item, index) => <div className="receipt-line" key={index}>
          <span>{item.name}<br /><small>{qty(item.quantity)} × {money(item.unitPrice)}</small></span>
          <b>{money(item.lineTotal)}</b>
        </div>)}
        <hr />
        <div className="receipt-line total"><span>TOTAL</span><b>{money(receipt.total)}</b></div>
        {receipt.vat > 0 && <div className="receipt-line"><span>Includes VAT</span><span>{money(receipt.vat)}</span></div>}
        <p>Paid by: {paymentLabel(receipt.payment)}{receipt.paymentReference ? ` (${receipt.paymentReference})` : ''}</p>
        <p className="receipt-footer">{business.receipt_footer || 'Thank you for your business!'}</p>
        <p className="receipt-brand">Powered by Radari POS</p>
      </div>
      <div className="receipt-buttons"><button type="button" onClick={() => window.print()}>Print</button><button type="button" onClick={onClose}>Done</button></div>
    </section>
  </div>
}
