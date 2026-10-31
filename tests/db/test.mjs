import { PGlite } from '@electric-sql/pglite'
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { as, makeTest, assert, rejects } from './harness.mjs'

const dir = process.argv[2] || fileURLToPath(new URL('../../supabase/migrations', import.meta.url))
const sql = f => readFileSync(`${dir}/${f}`, 'utf8')
const shim = readFileSync(new URL('./harness.mjs', import.meta.url), 'utf8').match(/const SHIM = `([\s\S]*?)`/)[1]

const db = new PGlite({ extensions: { pgcrypto } })
await db.exec(shim)
for (const f of ['0001_saas_foundation.sql', '0002_onboarding_and_subscriptions.sql', '0003_pos_checkout.sql']) await db.exec(sql(f))
await db.exec('grant all on all tables in schema public to service_role; grant all on all functions in schema public to service_role;')

const U = {
  ownerA: '00000000-0000-4000-8000-00000000000a', ownerB: '00000000-0000-4000-8000-00000000000b',
  cashierA: '00000000-0000-4000-8000-0000000000c1', stockA: '00000000-0000-4000-8000-0000000000d1',
  accountantA: '00000000-0000-4000-8000-0000000000e1', adminA: '00000000-0000-4000-8000-0000000000f1',
  stranger: '00000000-0000-4000-8000-000000000099',
}
const emails = { ownerA: 'a@x.co', ownerB: 'b@x.co', cashierA: 'cash@x.co', stockA: 'stock@x.co', accountantA: 'acc@x.co', adminA: 'adm@x.co', stranger: 's@x.co' }
for (const [k, id] of Object.entries(U)) {
  await db.query(`insert into auth.users (id, email, raw_user_meta_data, email_confirmed_at) values ($1, $2, $3, now())`, [id, emails[k], JSON.stringify({ full_name: k })])
}
const q = (user, text, params = []) => as(db, user, () => db.query(text, params))
const one = async (user, text, params) => (await q(user, text, params)).rows[0]

// Businesses created via the real provisioning function, then activated as service role.
const A = (await one(U.ownerA, `select public.create_business_account('Shop A','shop-a','Owner A','0700000000') id`)).id
const B = (await one(U.ownerB, `select public.create_business_account('Shop B','shop-b','Owner B','0700000001') id`)).id
await q(null, `select public.activate_subscription_from_payment($1, now(), 30)`, [A])
await q(null, `select public.activate_subscription_from_payment($1, now(), 30)`, [B])

// Pre-0004 data: product and a sale through the old 0003 function.
const legacy = (await one(U.ownerA, `insert into products (business_id,name,cost,price,stock,reorder_level) values ($1,'Legacy Soap',50,80,20,5) returning id`, [A])).id
await q(U.ownerA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: legacy, quantity: 2 }])])

const { t, done } = makeTest()
console.log('Before 0004 (documenting defects in 0003):')
await t('0003 allowed overselling with duplicate cart lines', async () => {
  await q(U.ownerA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: legacy, quantity: 10 }, { product_id: legacy, quantity: 10 }])])
  const s = await one(U.ownerA, `select stock from products where id=$1`, [legacy])
  assert(Number(s.stock) === -2, 'expected the defect to produce -2, got ' + s.stock)
  await q(null, `update products set stock = 18 where id=$1`, [legacy]) // repair for the remaining tests
})

await db.exec(sql('0004_business_management.sql'))
await db.exec(sql('0004_business_management.sql')) // must be re-runnable
await db.exec(sql('0005_operations_and_accounting.sql'))
await db.exec(sql('0005_operations_and_accounting.sql'))
await db.exec(sql('0006_till_payment_notifications.sql'))
await db.exec(sql('0006_till_payment_notifications.sql'))
await db.exec('grant all on all tables in schema public to service_role; grant all on all functions in schema public to service_role;')

console.log('\nAfter 0004:')
await t('backfill: legacy product has opening movement and legacy sales have cost', async () => {
  const m = await one(null, `select count(*)::int n from stock_movements where product_id=$1 and movement_type='opening'`, [legacy])
  assert(m.n === 1, 'opening movements: ' + m.n)
  const s = await one(null, `select min(total_cost)::numeric c from sales where business_id=$1`, [A])
  assert(Number(s.c) === 100, 'legacy total_cost ' + s.c)
})

// Staff via invitations
await t('owner invites staff; invitee accepts on sign-in', async () => {
  await q(U.ownerA, `select invite_staff($1,'cash@x.co','cashier')`, [A])
  await q(U.ownerA, `select invite_staff($1,'STOCK@x.co','stock_manager')`, [A])
  await q(U.ownerA, `select invite_staff($1,'acc@x.co','accountant')`, [A])
  await q(U.ownerA, `select invite_staff($1,'adm@x.co','admin')`, [A])
  for (const u of [U.cashierA, U.stockA, U.accountantA, U.adminA]) {
    const r = await one(u, `select accept_pending_invitations() n`)
    assert(r.n === 1, 'accepted ' + r.n)
  }
  const roles = (await q(U.ownerA, `select role, email from list_business_staff($1)`, [A])).rows
  assert(roles.length === 5 && roles[0].role === 'owner' && roles.every(r => r.email), JSON.stringify(roles))
})
await t('cashier sees colleague names but not emails', async () => {
  const rows = (await q(U.cashierA, `select * from list_business_staff($1)`, [A])).rows
  assert(rows.length === 5 && rows.every(r => r.email === null && r.full_name), JSON.stringify(rows))
})
await t('uninvited user cannot accept or list staff', async () => {
  assert((await one(U.stranger, `select accept_pending_invitations() n`)).n === 0)
  await rejects(q(U.stranger, `select * from list_business_staff($1)`, [A]), /Not a member/)
})
await t('admin cannot invite admins or change the owner', async () => {
  await rejects(q(U.adminA, `select invite_staff($1,'z@x.co','admin')`, [A]), /Only the owner/)
  await rejects(q(U.adminA, `select update_staff_member($1,$2,'cashier','active')`, [A, U.ownerA]), /owner cannot be changed|cannot change|Only the owner/)
})
await t('memberships cannot be written directly', async () => {
  await rejects(q(U.ownerA, `insert into business_memberships (business_id,user_id,role) values ($1,$2,'owner')`, [A, U.stranger]), /permission denied/)
  await rejects(q(U.ownerA, `update business_memberships set role='owner' where user_id=$1`, [U.cashierA]), /permission denied/)
})

// Products and stock
let p1, p2
await t('stock manager creates products; opening stock is audited', async () => {
  p1 = (await one(U.stockA, `insert into products (business_id,name,category,sku,barcode,cost,price,stock,reorder_level,vat_rate) values ($1,'Sugar 1kg','Grocery','SUG1','6001',100,150,10,3,16) returning id`, [A])).id
  p2 = (await one(U.stockA, `insert into products (business_id,name,cost,price,stock,reorder_level,vat_rate) values ($1,'Bread',45,60,5,2,0) returning id`, [A])).id
  const m = await one(null, `select quantity, stock_after from stock_movements where product_id=$1`, [p1])
  assert(Number(m.quantity) === 10 && Number(m.stock_after) === 10)
})
await t('cashier cannot create or edit products', async () => {
  await rejects(q(U.cashierA, `insert into products (business_id,name,price) values ($1,'X',1)`, [A]), /row-level security/)
  const r = await q(U.cashierA, `update products set price=1 where id=$1`, [p1])
  assert(r.affectedRows === 0, 'cashier updated a product')
})
await t('nobody can set stock directly', async () => {
  await rejects(q(U.ownerA, `update products set stock=999 where id=$1`, [p1]), /permission denied/)
})
await t('stock adjustment validates and audits', async () => {
  const r = await one(U.stockA, `select adjust_stock($1,$2,-2,'damaged','torn bags') s`, [A, p1])
  assert(Number(r.s) === 8)
  await rejects(q(U.stockA, `select adjust_stock($1,$2,-100,'lost')`, [A, p1]), /below zero/)
  await rejects(q(U.cashierA, `select adjust_stock($1,$2,1,'other')`, [A, p1]), /permission/)
  await rejects(q(U.stockA, `select adjust_stock($1,$2,1,'because')`, [A, p1]), /reason/)
})

// Checkout
let sale1
await t('checkout uses stored prices and ignores browser totals', async () => {
  const r = await one(U.cashierA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: p1, quantity: 2, price: 1 }, { product_id: p2, quantity: 1, total: 0 }])])
  sale1 = r.sale_id
  assert(Number(r.total) === 360 && r.receipt_number === 'R000001' && r.already_recorded === false, JSON.stringify(r))
  const s = await one(null, `select vat_amount, total_cost from sales where id=$1`, [sale1])
  assert(Number(s.vat_amount) === 41.38 && Number(s.total_cost) === 245, JSON.stringify(s))
})
await t('stock deducted and sale movements written', async () => {
  const s = await one(null, `select stock from products where id=$1`, [p1])
  assert(Number(s.stock) === 6)
  const m = await one(null, `select count(*)::int n from stock_movements where reference_id=$1 and movement_type='sale'`, [sale1])
  assert(m.n === 2)
})
await t('duplicate cart lines are combined and cannot oversell', async () => {
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: p1, quantity: 4 }, { product_id: p1, quantity: 4 }])]), /Insufficient stock for Sugar 1kg. Available: 6/)
  const s = await one(null, `select stock from products where id=$1`, [p1])
  assert(Number(s.stock) === 6, 'stock changed after failed sale: ' + s.stock)
})
await t('failed sale leaves no sale, items or stock change (atomic)', async () => {
  const before = await one(null, `select count(*)::int n from sales where business_id=$1`, [A])
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: p2, quantity: 1 }, { product_id: p1, quantity: 50 }])]))
  const after = await one(null, `select count(*)::int n from sales where business_id=$1`, [A])
  const bread = await one(null, `select stock from products where id=$1`, [p2])
  assert(before.n === after.n && Number(bread.stock) === 4)
})
await t('invalid quantities and malformed items are rejected', async () => {
  for (const bad of [[{ product_id: p1, quantity: 0 }], [{ product_id: p1, quantity: -1 }], [{ product_id: p1, quantity: '2' }], [{ product_id: 'x', quantity: 1 }], [{ product_id: p1, quantity: 1.0001 }], []]) {
    await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify(bad)]), /invalid|empty/i)
  }
})
await t('retry with the same client reference returns the original sale', async () => {
  const ref = '11111111-1111-4111-8111-111111111111'
  const a = await one(U.cashierA, `select * from complete_pos_sale($1,'mpesa',$2,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]), ref])
  const b = await one(U.cashierA, `select * from complete_pos_sale($1,'mpesa',$2,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]), ref])
  assert(a.sale_id === b.sale_id && b.already_recorded === true)
  const s = await one(null, `select stock from products where id=$1`, [p1])
  assert(Number(s.stock) === 5, 'double deduction: ' + s.stock)
})
await t('old 0003 call shape (three arguments) still works', async () => {
  const r = await one(U.ownerA, `select * from complete_pos_sale(target_business_id => $1, chosen_payment_method => 'cash', cart_items => $2)`, [A, JSON.stringify([{ product_id: p2, quantity: 1 }])])
  assert(r.receipt_number === 'R000003', r.receipt_number)
})
await t('stock manager and accountant cannot sell', async () => {
  await rejects(q(U.stockA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: p2, quantity: 1 }])]), /permission/)
  await rejects(q(U.accountantA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: p2, quantity: 1 }])]), /permission/)
})
await t('sales and sale items cannot be inserted or edited directly', async () => {
  await rejects(q(U.ownerA, `insert into sales (business_id,receipt_number,cashier_id,subtotal,total,payment_method) values ($1,'X',$2,0,0,'cash')`, [A, U.ownerA]), /permission denied/)
  await rejects(q(U.ownerA, `insert into sale_items (business_id,sale_id,product_name,quantity,unit_price,line_total) values ($1,$2,'x',1,0,0)`, [A, sale1]), /permission denied/)
  await rejects(q(U.ownerA, `update sales set total=0 where id=$1`, [sale1]), /permission denied/)
})

// Credit
let cust
await t('credit sale requires a customer and respects the limit', async () => {
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'credit',$2)`, [A, JSON.stringify([{ product_id: p2, quantity: 1 }])]), /Select a customer/)
  cust = (await one(U.cashierA, `insert into customers (business_id,name,phone,credit_limit) values ($1,'Mama Njeri','0711000000',200) returning id`, [A])).id
  const r = await one(U.cashierA, `select * from complete_pos_sale($1,'credit',$2,null,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]), cust])
  assert(Number(r.total) === 150)
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'credit',$2,null,$3)`, [A, JSON.stringify([{ product_id: p2, quantity: 1 }]), cust]), /Credit limit exceeded/)
  const b = await one(U.cashierA, `select balance from customer_balances where id=$1`, [cust])
  assert(Number(b.balance) === 150)
})
await t('customer payment reduces balance; overpayment rejected', async () => {
  await rejects(q(U.cashierA, `select record_customer_payment($1,$2,500,'cash')`, [A, cust]), /more than/)
  const r = await one(U.cashierA, `select record_customer_payment($1,$2,50,'mpesa','part') b`, [A, cust])
  assert(Number(r.b) === 100)
})

// Void
await t('void restores stock once and reverses credit', async () => {
  const sale = await one(null, `select id from sales where customer_id=$1`, [cust])
  const before = await one(null, `select stock from products where id=$1`, [p1])
  await rejects(q(U.cashierA, `select void_sale($1,$2,'customer returned')`, [A, sale1]), /Only the owner/) // not their latest sale
  await rejects(q(U.ownerA, `select void_sale($1,$2,'x')`, [A, sale.id]), /reason/)
  await q(U.ownerA, `select void_sale($1,$2,'customer returned goods')`, [A, sale.id])
  await rejects(q(U.ownerA, `select void_sale($1,$2,'again please')`, [A, sale.id]), /already been voided/)
  const after = await one(null, `select stock from products where id=$1`, [p1])
  assert(Number(after.stock) === Number(before.stock) + 1)
  const b = await one(U.ownerA, `select balance from customer_balances where id=$1`, [cust])
  assert(Number(b.balance) === -50, 'balance after void ' + b.balance) // customer has a 50 credit
})

// Purchases
await t('purchase restocks with weighted average cost and tracks supplier balance', async () => {
  const sup = (await one(U.stockA, `insert into suppliers (business_id,name) values ($1,'Kapa Ltd') returning id`, [A])).id
  const before = await one(null, `select stock, cost from products where id=$1`, [p1])
  const pid = (await one(U.stockA, `select record_purchase($1,$2,$3,'INV-9',1000) id`, [A, sup, JSON.stringify([{ product_id: p1, quantity: 10, unit_cost: 130 }])])).id
  const after = await one(null, `select stock, cost from products where id=$1`, [p1])
  const expected = Math.round(((Number(before.stock) * 100 + 1300) / (Number(before.stock) + 10)) * 100) / 100
  assert(Number(after.stock) === Number(before.stock) + 10 && Number(after.cost) === expected, JSON.stringify({ before, after, expected }))
  await rejects(q(U.accountantA, `select record_purchase_payment($1,$2,400)`, [A, pid]), /balance/)
  const bal = await one(U.accountantA, `select record_purchase_payment($1,$2,300) b`, [A, pid])
  assert(Number(bal.b) === 0)
  await rejects(q(U.cashierA, `select record_purchase($1,null,$2)`, [A, JSON.stringify([{ product_id: p1, quantity: 1, unit_cost: 1 }])]), /permission/)
})

// Expenses and reports
await t('expenses: accountant records, cashier cannot see', async () => {
  await q(U.accountantA, `insert into expenses (business_id,category,amount,created_by) values ($1,'Rent',500,$2)`, [A, U.accountantA])
  await rejects(q(U.cashierA, `insert into expenses (business_id,category,amount,created_by) values ($1,'Rent',5,$2)`, [A, U.cashierA]), /row-level security/)
  const r = await q(U.cashierA, `select * from expenses where business_id=$1`, [A])
  assert(r.rows.length === 0)
})
await t('report figures reconcile', async () => {
  const r = (await one(U.accountantA, `select business_report($1, now() - interval '1 day', now() + interval '1 day') r`, [A])).r
  const sales = await one(null, `select sum(total) t, sum(vat_amount) v, sum(total_cost) c, count(*)::int n from sales where business_id=$1 and status='completed'`, [A])
  assert(Number(r.revenue) === Number(sales.t) && r.transactions === sales.n, JSON.stringify(r))
  assert(Math.abs(r.gross_profit - (sales.t - sales.v - sales.c)) < 0.001)
  assert(Number(r.expenses) === 500 && Math.abs(r.net_profit - (r.gross_profit - 500)) < 0.001)
  assert(r.voided_count === 1 && Number(r.outstanding_credit) === -50 && Number(r.supplier_balance) === 0, JSON.stringify(r))
  assert(r.top_products.length >= 2 && r.payment_methods.length >= 2 && r.daily.length >= 1)
  await rejects(q(U.cashierA, `select business_report($1, now() - interval '1 day', now())`, [A]), /permission/)
})

// Tenant isolation
await t('business B sees nothing from business A', async () => {
  for (const table of ['products', 'sales', 'sale_items', 'stock_movements', 'customers', 'customer_ledger', 'customer_balances', 'suppliers', 'purchases', 'purchase_items', 'expenses', 'staff_invitations', 'payment_requests', 'payments', 'subscriptions']) {
    const r = await q(U.ownerB, `select count(*)::int n from ${table} where business_id=$1`, [A])
    assert(r.rows[0].n === 0, `${table} leaked ${r.rows[0].n} rows`)
  }
})
await t('business B cannot use A in any function', async () => {
  const cart = JSON.stringify([{ product_id: p1, quantity: 1 }])
  await rejects(q(U.ownerB, `select * from complete_pos_sale($1,'cash',$2)`, [A, cart]), /permission/)
  await rejects(q(U.ownerB, `select * from complete_pos_sale($1,'cash',$2)`, [B, cart]), /no longer available/)
  await rejects(q(U.ownerB, `select adjust_stock($1,$2,5,'other')`, [B, p1]), /not found/)
  await rejects(q(U.ownerB, `select void_sale($1,$2,'trying it')`, [B, sale1]), /not found/)
  await rejects(q(U.ownerB, `select business_report($1, now()-interval '1 day', now())`, [A]), /permission/)
  await rejects(q(U.ownerB, `select invite_staff($1,'q@x.co','cashier')`, [A]), /Only the owner/)
  await rejects(q(U.ownerB, `insert into products (business_id,name,price) values ($1,'Evil',1)`, [A]), /row-level security/)
})

// Subscription enforcement
await t('expired subscription blocks sales and data access', async () => {
  await q(null, `update subscriptions set current_period_end = now() - interval '10 days', grace_ends_at = now() - interval '7 days' where business_id=$1`, [B])
  const pb = (await one(null, `insert into products (business_id,name,price,stock) values ($1,'B item',10,5) returning id`, [B])).id
  await rejects(q(U.ownerB, `select * from complete_pos_sale($1,'cash',$2)`, [B, JSON.stringify([{ product_id: pb, quantity: 1 }])]), /subscription/)
  const r = await q(U.ownerB, `select count(*)::int n from products where business_id=$1`, [B])
  assert(r.rows[0].n === 0)
})
await t('owner cannot edit business status or insert payment requests', async () => {
  await rejects(q(U.ownerA, `update businesses set status='active' where id=$1`, [A]), /permission denied/)
  const r = await q(U.ownerA, `update businesses set receipt_footer='Karibu tena' where id=$1`, [A])
  assert(r.affectedRows === 1)
  await rejects(q(U.ownerA, `insert into payment_requests (business_id,requested_by,phone,amount_kes,status) values ($1,$2,'254700000000',1,'confirmed')`, [A, U.ownerA]), /permission denied/)
})
await t('disabled staff lose access', async () => {
  await q(U.ownerA, `select update_staff_member($1,$2,'cashier','disabled')`, [A, U.cashierA])
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: p2, quantity: 1 }])]), /permission/)
  const r = await q(U.cashierA, `select count(*)::int n from products where business_id=$1`, [A])
  assert(r.rows[0].n === 0)
})
await t('payment confirmation stays idempotent', async () => {
  const req = (await one(null, `insert into payment_requests (business_id,requested_by,phone,amount_kes,status,checkout_request_id) values ($1,$2,'254700000000',1500,'submitted','ws_1') returning id`, [A, U.ownerA])).id
  const end0 = await one(null, `select current_period_end e from subscriptions where business_id=$1`, [A])
  const first = await one(null, `select confirm_subscription_payment($1,'QAB123','254700000000',1500,now(),'{}'::jsonb) r`, [req])
  const second = await one(null, `select confirm_subscription_payment($1,'QAB123','254700000000',1500,now(),'{}'::jsonb) r`, [req])
  const end1 = await one(null, `select current_period_end e from subscriptions where business_id=$1`, [A])
  const days = (new Date(end1.e) - new Date(end0.e)) / 86400000
  assert(first.r === true && second.r === false && Math.round(days) === 30, JSON.stringify({ first, second, days }))
})

console.log('\n0005 features:')
await q(U.ownerA, `select update_staff_member($1,$2,'cashier','active')`, [A, U.cashierA])
let pServe
await t('split payment: cash + M-Pesa + card recorded per method', async () => {
  const r = await one(U.cashierA, `select * from complete_pos_sale($1,'cash',$2,null,null,null,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 2 }]),
    JSON.stringify([{ method: 'cash', amount: 100 }, { method: 'mpesa', amount: 150, reference: 'SFK1' }, { method: 'card', amount: 50 }])])
  const s = await one(null, `select payment_method from sales where id=$1`, [r.sale_id])
  const pays = await one(null, `select count(*)::int n, sum(amount) t from sale_payments where sale_id=$1`, [r.sale_id])
  assert(s.payment_method === 'split' && pays.n === 3 && Number(pays.t) === 300, JSON.stringify({ s, pays }))
})
await t('payments must equal the amount due', async () => {
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'cash',$2,null,null,null,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]),
    JSON.stringify([{ method: 'cash', amount: 100 }])]), /must equal/)
})
await t('discounts respect the minimum price floor and cannot raise prices', async () => {
  await q(U.ownerA, `update businesses set min_price_percent=90 where id=$1`, [A])
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: p1, quantity: 1, unit_price: 100 }])]), /below KSh 135/)
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: p1, quantity: 1, unit_price: 200 }])]), /cannot be raised/)
  const r = await one(U.cashierA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: p1, quantity: 1, unit_price: 140 }])])
  const s = await one(null, `select total, discount_total from sales where id=$1`, [r.sale_id])
  assert(Number(s.total) === 140 && Number(s.discount_total) === 10, JSON.stringify(s))
  await q(U.ownerA, `update businesses set min_price_percent=0 where id=$1`, [A])
})
let loyalCust
await t('loyalty: earn on sale, redeem as discount, reverse on void', async () => {
  await q(U.ownerA, `update businesses set loyalty_enabled=true, loyalty_spend_per_point=100, loyalty_point_value=1 where id=$1`, [A])
  loyalCust = (await one(U.cashierA, `insert into customers (business_id,name,phone) values ($1,'Loyal Lucy','0700111222') returning id`, [A])).id
  const r1 = await one(U.cashierA, `select * from complete_pos_sale($1,'cash',$2,null,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 2 }]), loyalCust])
  let pts = await one(null, `select loyalty_points from customer_balances where id=$1`, [loyalCust])
  assert(pts.loyalty_points === 3, 'earned ' + pts.loyalty_points)
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'cash',$2,null,$3,null,null,null,5)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]), loyalCust]), /only has 3 points/)
  const r2 = await one(U.cashierA, `select * from complete_pos_sale($1,'cash',$2,null,$3,null,null,null,3)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]), loyalCust])
  assert(Number(r2.total) === 147, 'total after points ' + r2.total)
  pts = await one(null, `select loyalty_points from customer_balances where id=$1`, [loyalCust])
  assert(pts.loyalty_points === 1, 'after redeem ' + pts.loyalty_points) // 3 - 3 + 1 earned on 147
  await q(U.cashierA, `select void_sale($1,$2,'wrong customer')`, [A, r2.sale_id]) // own last sale within 15 min
  pts = await one(null, `select loyalty_points from customer_balances where id=$1`, [loyalCust])
  assert(pts.loyalty_points === 3, 'after void ' + pts.loyalty_points)
  await rejects(q(U.cashierA, `select void_sale($1,$2,'older one')`, [A, r1.sale_id]), /Only the owner/)
})
await t('sell by serving deducts a fraction of the bottle', async () => {
  pServe = (await one(U.ownerA, `insert into products (business_id,name,category,cost,price,stock,unit,container_ml,serving_ml,serving_price) values ($1,'Whisky 750ml','Bar',1500,3000,2,'Bottle',750,25,150) returning id`, [A])).id
  const r = await one(U.cashierA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: pServe, quantity: 3, mode: 'serving' }])])
  const p = await one(null, `select stock from products where id=$1`, [pServe])
  const i = await one(null, `select stock_quantity, line_total, unit_cost from sale_items where sale_id=$1`, [r.sale_id])
  assert(Number(r.total) === 450 && Number(p.stock) === 1.9 && Number(i.stock_quantity) === 0.1 && Number(i.unit_cost) === 50, JSON.stringify({ r, p, i }))
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'cash',$2)`, [A, JSON.stringify([{ product_id: p2, quantity: 1, mode: 'serving' }])]), /not set up to sell by serving/)
})
await t('cash + credit split with due date; credit status allocates payments oldest first', async () => {
  const c = (await one(U.cashierA, `insert into customers (business_id,name) values ($1,'Credit Carol') returning id`, [A])).id
  const due = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10)
  const s1 = await one(U.cashierA, `select * from complete_pos_sale($1,'cash',$2,null,$3,null,$4,$5)`, [A, JSON.stringify([{ product_id: p1, quantity: 2 }]), c,
    JSON.stringify([{ method: 'cash', amount: 100 }, { method: 'credit', amount: 200 }]), due])
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'cash',$2,null,null,null,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]), JSON.stringify([{ method: 'credit', amount: 150 }])]), /Select a customer/)
  const s2 = await one(U.cashierA, `select * from complete_pos_sale($1,'credit',$2,null,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]), c])
  await q(U.cashierA, `select record_customer_payment($1,$2,250,'mpesa')`, [A, c])
  const rows = (await q(U.cashierA, `select * from credit_sales_status($1) where customer_id=$2 order by sold_at`, [A, c])).rows
  assert(rows.length === 2 && rows[0].status === 'paid' && Number(rows[1].paid) === 50 && Number(rows[1].balance) === 100 && rows[1].status === 'pending', JSON.stringify(rows))
  assert(rows[0].due_date && rows[0].items.includes('Sugar 1kg'), JSON.stringify(rows[0]))
  await rejects(q(U.stockA, `select * from credit_sales_status($1)`, [A]), /permission/)
})
await t('creditors: record debt and payments, no overpayment', async () => {
  const id = (await one(U.accountantA, `insert into creditors (business_id,name,amount) values ($1,'Landlord',10000) returning id`, [A])).id
  const b = await one(U.accountantA, `select record_creditor_payment($1,$2,4000,'bank') b`, [A, id])
  assert(Number(b.b) === 6000)
  await rejects(q(U.accountantA, `select record_creditor_payment($1,$2,7000,'bank')`, [A, id]), /more than/)
  await rejects(q(U.cashierA, `insert into creditors (business_id,name,amount) values ($1,'X',1)`, [A]), /row-level security/)
  const v = await one(U.ownerA, `select paid, balance from creditor_balances where id=$1`, [id])
  assert(Number(v.paid) === 4000 && Number(v.balance) === 6000)
})
await t('categories: create, rename moves products, delete moves to General', async () => {
  await q(U.stockA, `insert into product_categories (business_id,name) values ($1,'Snacks')`, [A])
  await q(U.stockA, `select rename_category($1,'Grocery','Dry goods')`, [A])
  const p = await one(null, `select category from products where id=$1`, [p1])
  assert(p.category === 'Dry goods', p.category)
  const moved = await one(U.stockA, `select delete_category($1,'Dry goods') n`, [A])
  assert(moved.n >= 1 && (await one(null, `select category from products where id=$1`, [p1])).category === 'General')
  await rejects(q(U.cashierA, `select rename_category($1,'General','X')`, [A]), /permission/)
})
await t('bulk VAT update by tax category (owner/admin only)', async () => {
  await rejects(q(U.stockA, `select bulk_set_tax_category($1,'exempt')`, [A]), /Only the owner/)
  const n = await one(U.ownerA, `select bulk_set_tax_category($1,'zero_rated') n`, [A])
  const p = await one(null, `select vat_rate, tax_category from products where id=$1`, [p1])
  assert(n.n >= 3 && Number(p.vat_rate) === 0 && p.tax_category === 'zero_rated')
  await q(U.ownerA, `select bulk_set_tax_category($1,'standard')`, [A])
})
await t('purchase with batch, expiry, invoice total and new selling price', async () => {
  const exp = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10)
  const id = (await one(U.stockA, `select record_purchase($1,null,$2,'INV-77',0,current_date,null,1250) id`, [A,
    JSON.stringify([{ product_id: p1, quantity: 10, unit_cost: 120, batch_number: 'B42', expiry_date: exp, selling_price: 160 }])])).id
  const pr = await one(null, `select total, items_total, amount_paid from purchases where id=$1`, [id])
  const p = await one(null, `select price, batch_number, expiry_date from products where id=$1`, [p1])
  assert(Number(pr.total) === 1250 && Number(pr.items_total) === 1200 && Number(pr.amount_paid) === 0, JSON.stringify(pr))
  assert(Number(p.price) === 160 && p.batch_number === 'B42' && p.expiry_date, JSON.stringify(p))
})
await t('chart of accounts and journal: balances by account type, no cross-business accounts', async () => {
  const cash = (await one(U.accountantA, `insert into accounts (business_id,code,name,account_type,opening_balance) values ($1,'1000','Cash','asset',5000) returning id`, [A])).id
  const rent = (await one(U.accountantA, `insert into accounts (business_id,code,name,account_type) values ($1,'6000','Rent','expense') returning id`, [A])).id
  await q(U.accountantA, `insert into journal_entries (business_id,reference,description,debit_account_id,credit_account_id,amount,created_by) values ($1,'JE1','October rent',$2,$3,2000,$4)`, [A, rent, cash, U.accountantA])
  const rows = (await q(U.accountantA, `select code, balance from account_balances where business_id=$1 order by code`, [A])).rows
  assert(Number(rows[0].balance) === 3000 && Number(rows[1].balance) === 2000, JSON.stringify(rows))
  const bAcc = (await one(U.ownerB, `select count(*)::int n from accounts where business_id=$1`, [A])).n
  assert(bAcc === 0)
  await rejects(q(U.ownerA, `insert into journal_entries (business_id,reference,description,debit_account_id,credit_account_id,amount,created_by) values ($1,'X','x',$2,$2,1,$3)`, [A, cash, U.ownerA]))
  assert((await q(U.cashierA, `select * from accounts where business_id=$1`, [A])).rows.length === 0, 'cashier saw accounts')
})
await t('extended report: VAT bands, input VAT, hourly, categories, cashiers', async () => {
  const r = (await one(U.accountantA, `select business_report($1, now() - interval '1 day', now() + interval '1 day') r`, [A])).r
  assert(r.vat_bands.length >= 1 && r.hourly.length >= 1 && r.categories.length >= 1 && r.cashiers.length >= 1, JSON.stringify(Object.keys(r)))
  assert(Number(r.input_vat) > 0 && Number(r.discounts) >= 10 && Number(r.creditor_balance) === 6000 && r.expiring_count >= 1, JSON.stringify({ iv: r.input_vat, d: r.discounts, cb: r.creditor_balance, e: r.expiring_count }))
  const split = r.payment_methods.find(m => m.method === 'card')
  assert(split && Number(split.total) >= 50, JSON.stringify(r.payment_methods))
})
await t('settings validation: logo must be an image, theme must be a colour', async () => {
  await rejects(q(U.ownerA, `update businesses set logo_data='javascript:alert(1)' where id=$1`, [A]), /check constraint/)
  await rejects(q(U.ownerA, `update businesses set theme_color='red' where id=$1`, [A]), /check constraint/)
  const r = await q(U.ownerA, `update businesses set theme_color='#0f766e', mpesa_till='123456', business_type='bar' where id=$1`, [A])
  assert(r.affectedRows === 1)
})

console.log('\n0006 till payment notifications:')
const tokenA = 'a'.repeat(48), tokenB = 'b'.repeat(48)
await q(null, `insert into till_settings (business_id, shortcode_type, shortcode, till_number, consumer_key, consumer_secret, callback_token, registered_at) values ($1,'till','174379','5123456','k','s',$2,now()), ($3,'paybill','600100','600100','k','s',$4,now())`, [A, tokenA, B, tokenB])
const record = (token, trans, amount, shortcode = '174379') => one(null, `select record_till_payment($1,$2,now(),$3,$4,null,'2547XXXX123','JOHN') r`, [token, trans, amount, shortcode])
let tp
await t('payments are recorded once per M-Pesa receipt', async () => {
  assert((await record(tokenA, 'QAB1CDE2FG', 450)).r === 'recorded')
  assert((await record(tokenA, 'QAB1CDE2FG', 450)).r === 'recorded')
  assert((await one(null, `select count(*)::int n from till_payments where trans_id='QAB1CDE2FG'`)).n === 1)
  tp = (await one(null, `select id from till_payments where trans_id='QAB1CDE2FG'`)).id
})
await t('unknown token, bad receipt and wrong till are ignored', async () => {
  assert((await record('c'.repeat(48), 'QZZ1CDE2FG', 10)).r === 'unknown_token')
  assert((await record(tokenA, 'bad receipt', 10)).r === 'invalid_receipt')
  assert((await record(tokenA, 'QZZ1CDE2FH', 10, '999999')).r === 'shortcode_mismatch')
  assert((await record(tokenA, 'QZZ1CDE2FJ', 10, '5123456')).r === 'recorded') // till number also accepted
})
await t('browser roles cannot call the recorder or read credentials', async () => {
  await rejects(q(U.ownerA, `select record_till_payment($1,'QXX1CDE2FG',now(),1)`, [tokenA]), /permission denied/)
  await rejects(q(U.ownerA, `select consumer_secret from till_settings`), /permission denied/)
  const st = await one(U.cashierA, `select * from till_connection_status($1)`, [A])
  assert(st.connected === true && st.shortcode === '174379' && !('consumer_secret' in st), JSON.stringify(st))
})
await t('business B cannot see business A payments', async () => {
  assert((await one(U.ownerB, `select count(*)::int n from till_payments where business_id=$1`, [A])).n === 0)
  assert((await one(U.cashierA, `select count(*)::int n from till_payments where business_id=$1`, [A])).n === 2)
  await rejects(q(U.stockA, `select * from till_connection_status($1)`, [A]), /Not allowed/)
})
let claimSale
await t('checkout claims a received payment and stores its receipt', async () => {
  const r = await one(U.cashierA, `select * from complete_pos_sale($1,'mpesa',$2,null,null,null,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 2 }]),
    JSON.stringify([{ method: 'mpesa', amount: 320, till_payment_id: tp }])])
  claimSale = r.sale_id
  const pay = await one(null, `select status, sale_id from till_payments where id=$1`, [tp])
  const sp = await one(null, `select reference, till_payment_id from sale_payments where sale_id=$1`, [r.sale_id])
  assert(pay.status === 'claimed' && pay.sale_id === r.sale_id && sp.reference === 'QAB1CDE2FG' && sp.till_payment_id === tp, JSON.stringify({ pay, sp }))
})
await t('a payment cannot be used twice, for more than received, or for cash', async () => {
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'mpesa',$2,null,null,null,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]), JSON.stringify([{ method: 'mpesa', amount: 160, till_payment_id: tp }])]), /already been used/)
  const small = (await one(null, `select id from till_payments where trans_id='QZZ1CDE2FJ'`)).id
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'mpesa',$2,null,null,null,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]), JSON.stringify([{ method: 'mpesa', amount: 160, till_payment_id: small }])]), /less than the amount/)
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'cash',$2,null,null,null,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]), JSON.stringify([{ method: 'cash', amount: 160, till_payment_id: small }])]), /only be used for the M-Pesa part/)
  const bTp = (await record(tokenB, 'QBB1CDE2FG', 999, '600100'), (await one(null, `select id from till_payments where trans_id='QBB1CDE2FG'`)).id)
  await rejects(q(U.cashierA, `select * from complete_pos_sale($1,'mpesa',$2,null,null,null,$3)`, [A, JSON.stringify([{ product_id: p1, quantity: 1 }]), JSON.stringify([{ method: 'mpesa', amount: 160, till_payment_id: bTp }])]), /already been used/)
})
await t('voiding the sale releases the payment', async () => {
  await q(U.ownerA, `select void_sale($1,$2,'customer changed mind')`, [A, claimSale])
  const pay = await one(null, `select status, sale_id from till_payments where id=$1`, [tp])
  assert(pay.status === 'unclaimed' && pay.sale_id === null, JSON.stringify(pay))
})
await t('owner can set aside a payment; cashier cannot', async () => {
  await rejects(q(U.cashierA, `select set_till_payment_status($1,$2,'dismissed','loan repayment')`, [A, tp]), /Only the owner/)
  await q(U.ownerA, `select set_till_payment_status($1,$2,'dismissed','loan repayment')`, [A, tp])
  assert((await one(null, `select status from till_payments where id=$1`, [tp])).status === 'dismissed')
})

await t('browser cannot read raw callbacks, phones or Daraja IDs', async () => {
  await rejects(q(U.ownerA, `select phone from payment_requests where business_id=$1`, [A]), /permission denied/)
  await rejects(q(U.ownerA, `select checkout_request_id from payment_requests where business_id=$1`, [A]), /permission denied/)
  await rejects(q(U.ownerA, `select raw_callback from payments where business_id=$1`, [A]), /permission denied/)
  const r = await q(U.ownerA, `select status, amount_kes from payment_requests where business_id=$1`, [A])
  assert(r.rows.length >= 1)
})

done()
