export type Role = 'owner' | 'admin' | 'stock_manager' | 'cashier' | 'accountant'

export const roleLabel: Record<Role, string> = {
  owner: 'Owner', admin: 'Admin', stock_manager: 'Stock manager', cashier: 'Cashier', accountant: 'Accountant',
}

export const roleDescription: Record<Exclude<Role, 'owner'>, string> = {
  admin: 'Everything except subscription payment and changing other admins',
  stock_manager: 'Products, stock adjustments, suppliers and restocking',
  cashier: 'Sell, reprint own receipts, customers and credit payments',
  accountant: 'Dashboard, sales, expenses, reports, customers and supplier payments',
}

// Mirrors the database policies. The database remains the authority; this only hides
// screens a role cannot use.
const access = {
  dashboard: ['owner', 'admin', 'accountant'],
  pos: ['owner', 'admin', 'cashier'],
  inventory: ['owner', 'admin', 'stock_manager', 'accountant', 'cashier'],
  categories: ['owner', 'admin', 'stock_manager'],
  purchases: ['owner', 'admin', 'stock_manager', 'accountant'],
  credit: ['owner', 'admin', 'cashier', 'accountant'],
  creditors: ['owner', 'admin', 'accountant'],
  loyalty: ['owner', 'admin', 'cashier', 'accountant'],
  adjustLoyalty: ['owner', 'admin'],
  accounting: ['owner', 'admin', 'accountant'],
  tax: ['owner', 'admin', 'accountant'],
  profit: ['owner', 'admin', 'accountant'],
  glovo: ['owner', 'admin', 'stock_manager'],
  bulkVat: ['owner', 'admin'],
  editStock: ['owner', 'admin', 'stock_manager'],
  sales: ['owner', 'admin', 'accountant', 'cashier'],
  voidSale: ['owner', 'admin'],
  expenses: ['owner', 'admin', 'accountant'],
  deleteExpense: ['owner', 'admin'],
  customers: ['owner', 'admin', 'cashier', 'accountant'],
  suppliers: ['owner', 'admin', 'stock_manager', 'accountant'],
  recordPurchase: ['owner', 'admin', 'stock_manager'],
  payPurchase: ['owner', 'admin', 'accountant'],
  staff: ['owner', 'admin'],
  reports: ['owner', 'admin', 'accountant'],
  subscription: ['owner', 'admin', 'stock_manager', 'cashier', 'accountant'],
  paySubscription: ['owner'],
  settings: ['owner', 'admin'],
} satisfies Record<string, Role[]>

export type Permission = keyof typeof access
export const can = (role: Role, permission: Permission) => (access[permission] as Role[]).includes(role)

export const homePath = (role: Role) =>
  can(role, 'dashboard') ? '/app' : role === 'stock_manager' ? '/app/inventory' : '/app/pos'
