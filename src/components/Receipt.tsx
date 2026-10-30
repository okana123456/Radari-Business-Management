import type { Business } from '../lib/account'
import { dateTime, money, paymentLabel, qty } from '../lib/format'

export type ReceiptData = {
  number: string; soldAt: string; payment: string; total: number; vat: number
  items: { name: string; quantity: number; unitPrice: number; lineTotal: number; listPrice?: number | null }[]
  payments?: { method: string; amount: number; reference?: string | null }[]
  discount?: number; loyaltyDiscount?: number; pointsRedeemed?: number
  tendered?: number | null; creditDueDate?: string | null
  cashier?: string; customer?: string | null; paymentReference?: string | null; status?: string; voidReason?: string | null
}

export function ReceiptView({ business, receipt, onClose, reprint }: { business: Business; receipt: ReceiptData; onClose: () => void; reprint?: boolean }) {
  const subtotal = receipt.items.reduce((sum, item) => sum + item.lineTotal, 0)
  const payments = receipt.payments?.length ? receipt.payments : [{ method: receipt.payment, amount: receipt.total, reference: receipt.paymentReference }]
  const cash = payments.filter(p => p.method === 'cash').reduce((sum, p) => sum + p.amount, 0)
  const change = receipt.tendered && receipt.tendered > cash ? receipt.tendered - cash : 0
  return <div className="pos-modal receipt-modal" role="dialog" aria-modal="true" aria-label={`Receipt ${receipt.number}`}>
    <section className="receipt-paper">
      <div className="receipt-print">
        {business.logo_data && <img src={business.logo_data} alt="" />}
        <h2>{business.name}</h2>
        {business.address && <p>{business.address}</p>}
        {business.phone && <p>Tel: {business.phone}</p>}
        {business.kra_pin && <p>PIN: {business.kra_pin}</p>}
        <hr />
        <p>Receipt {receipt.number}{reprint && ' (copy)'}</p>
        <p>{dateTime(receipt.soldAt)}</p>
        {receipt.cashier && <p>Served by: {receipt.cashier}</p>}
        {receipt.customer && <p>Customer: {receipt.customer}</p>}
        {receipt.status === 'voided' && <p className="void-stamp">VOIDED{receipt.voidReason ? `: ${receipt.voidReason}` : ''}</p>}
        <hr />
        {receipt.items.map((item, index) => <div className="receipt-line" key={index}>
          <span>{item.name}<br /><small>{qty(item.quantity)} x {money(item.unitPrice)}{item.listPrice && item.listPrice > item.unitPrice ? ` (was ${money(item.listPrice)})` : ''}</small></span>
          <b>{money(item.lineTotal)}</b>
        </div>)}
        <hr />
        {(receipt.loyaltyDiscount || 0) > 0 && <>
          <div className="receipt-line"><span>Subtotal</span><span>{money(subtotal)}</span></div>
          <div className="receipt-line"><span>Points redeemed ({receipt.pointsRedeemed})</span><span>-{money(receipt.loyaltyDiscount)}</span></div>
        </>}
        <div className="receipt-line total"><span>TOTAL</span><b>{money(receipt.total)}</b></div>
        {(receipt.discount || 0) > 0 && <div className="receipt-line"><span>You saved</span><span>{money(receipt.discount)}</span></div>}
        {receipt.vat > 0 && <div className="receipt-line"><span>VAT included</span><span>{money(receipt.vat)}</span></div>}
        <hr />
        {payments.map((p, index) => <div className="receipt-line" key={index}><span>{paymentLabel(p.method)}{p.reference ? ` ${p.reference}` : ''}</span><span>{money(p.amount)}</span></div>)}
        {receipt.tendered ? <div className="receipt-line"><span>Cash received</span><span>{money(receipt.tendered)}</span></div> : null}
        {change > 0 && <div className="receipt-line"><span>Change</span><span>{money(change)}</span></div>}
        {receipt.creditDueDate && <p>Credit due: {receipt.creditDueDate}</p>}
        <p className="receipt-footer">{business.receipt_footer || 'Thank you for your business.'}</p>
        <p className="receipt-brand">Radari POS</p>
      </div>
      <div className="receipt-buttons"><button type="button" onClick={() => window.print()}>Print</button><button type="button" onClick={onClose}>Done</button></div>
    </section>
  </div>
}
