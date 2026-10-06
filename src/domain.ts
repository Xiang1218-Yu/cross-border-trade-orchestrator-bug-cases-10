import { randomUUID } from 'node:crypto';

export type OrderStatus = 'draft' | 'confirmed' | 'allocated' | 'dispatched' | 'delivered' | 'closed' | 'cancelled';
export type CustomsStatus = 'draft' | 'submitted' | 'inspection' | 'cleared' | 'rejected';
export type InvoiceStatus = 'issued' | 'partially_paid' | 'paid' | 'void';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

type Tenant = { id: string; name: string; creditLimit: number; creditUsed: number; currency: string };
type TimezoneHistoryEntry = { timezone: string; effectiveFrom: string };
type Customer = { id: string; tenantId: string; name: string; creditLimit: number; creditUsed: number; blocked: boolean; timezone?: string; timezoneHistory?: TimezoneHistoryEntry[] };
type OrderItem = { sku: string; description: string; quantity: number; unitPrice: number; weightKg: number; hsCode: string };
export type Order = { id: string; tenantId: string; customerId: string; reference: string; origin: string; destination: string; priority: 'standard' | 'urgent' | 'critical'; status: OrderStatus; items: OrderItem[]; totalWeightKg: number; subtotal: number; totalAmount: number; currency: string; version: number; shipmentId?: string; customsDeclarationId?: string; invoiceId?: string; createdAt: string; updatedAt: string };
type InventoryLot = { id: string; tenantId: string; warehouse: string; sku: string; available: number; reserved: number; lotCode: string; expiresAt?: string };
type Reservation = { id: string; tenantId: string; orderId: string; lotId: string; sku: string; quantity: number; status: 'active' | 'released' | 'consumed'; createdAt: string };
type ShipmentLeg = { id: string; tenantId: string; mode: 'truck' | 'rail' | 'sea' | 'air'; origin: string; destination: string; plannedDeparture: string; plannedArrival: string; actualArrival?: string; status: 'planned' | 'in_transit' | 'arrived' | 'delayed' };
type Shipment = { id: string; tenantId: string; orderId: string; trackingNo: string; legs: ShipmentLeg[]; currentLocation: string; eta: string; status: 'planned' | 'in_transit' | 'delivered' | 'exception'; events: { id: string; code: string; location: string; occurredAt: string; note?: string }[] };
type CustomsDeclaration = { id: string; tenantId: string; orderId: string; country: string; status: CustomsStatus; documentRefs: string[]; requiredDocuments: string[]; riskScore: number; rejectionReason?: string; updatedAt: string };
type InvoiceLine = { code: string; description: string; quantity: number; unitPrice: number; amount: number };
// dueDate 语义：客户当地账期日期，统一存为客户时区下的 YYYY-MM-DD 纯日历日期（历史数据兼容完整 ISO 串，取其日期部分）。
// timezone 为开票时客户时区的快照，避免客户事后改时区导致同一张发票重复扫描时结论翻转。
export type Invoice = { id: string; tenantId: string; orderId: string; number: string; status: InvoiceStatus; currency: string; lines: InvoiceLine[]; subtotal: number; tax: number; total: number; paid: number; dueDate: string; timezone?: string; overdueSince?: string; createdAt: string };
type Payment = { id: string; tenantId: string; invoiceId: string; amount: number; method: 'bank_transfer' | 'card' | 'credit_note'; reference: string; receivedAt: string };
type Approval = { id: string; tenantId: string; orderId: string; type: 'credit_override' | 'customs_exception' | 'delay_compensation'; reason: string; status: ApprovalStatus; decidedBy?: string; comment?: string; createdAt: string; decidedAt?: string };
export type AuditEvent = { id: string; tenantId: string; actor: string; action: string; entityType: string; entityId: string; before?: unknown; after?: unknown; at: string };
export type OutboxEvent = { id: string; tenantId: string; topic: string; aggregateId: string; payload: unknown; status: 'pending' | 'published'; attempts: number; createdAt: string };

type State = { tenants: Tenant[]; customers: Customer[]; orders: Order[]; inventory: InventoryLot[]; reservations: Reservation[]; shipments: Shipment[]; customs: CustomsDeclaration[]; invoices: Invoice[]; payments: Payment[]; approvals: Approval[]; audit: AuditEvent[]; outbox: OutboxEvent[] };
// 单调时钟：保证连续取时严格递增（至少差 1ms），避免同毫秒内"先开票、后改时区"
// 在历史时区回溯时无法区分先后；同时让 audit/outbox 排序在高并发下也稳定。
let lastNowMs = 0;
function nowMs(): number { const t = Math.max(Date.now(), lastNowMs + 1); lastNowMs = t; return t; }
const now = () => new Date(nowMs()).toISOString();
const clone = <T>(value: T): T => structuredClone(value);
const id = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
const money = (value: number) => Math.round(value * 100) / 100;

// ---- 时区与当地日历日期工具（不依赖服务器本地时区，全部基于 IANA 时区 + UTC 算术）----
const DEFAULT_GRACE_DAYS = 0;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** 校验 IANA 时区是否有效（Node 运行时自带的 tzdata）。 */
export function isValidTimezone(zone: string | undefined): zone is string {
  if (!zone) return false;
  try {
    const probe = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric' });
    // Intl 对未知时区会抛 RangeError；再格式化一次确保运行时真正支持该区域。
    probe.format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * 把一个 UTC 瞬时转换为指定 IANA 时区下的当地日历日期（YYYY-MM-DD）。
 * 直接复用 ICU 已算好的当地墙钟各字段，不手写偏移量，因此夏令时跳变（23/25 小时天）天然正确。
 */
export function localCalendarDate(instant: Date, zone: string): string {
  if (Number.isNaN(instant.getTime())) throw new Error('评估时间不是合法日期');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(instant);
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`; // en-CA 本身即 YYYY-MM-DD
}

/** 在纯日历日期上加减整天，用 UTC 分量构造，闰日（2/29）和大小月均自动处理。 */
export function addCalendarDays(date: string, days: number): string {
  if (!CALENDAR_DATE.test(date)) throw new Error(`当地账期日期格式必须是 YYYY-MM-DD：${date}`);
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day) + days * 86400000);
  return shifted.toISOString().slice(0, 10);
}

/** 从存储值取当地账期日历日期：新数据为 YYYY-MM-DD；历史 ISO 瞬时取其 UTC 日期部分。 */
function dueCalendarDate(dueDate: string): string {
  if (CALENDAR_DATE.test(dueDate)) return dueDate;
  const parsed = new Date(dueDate);
  if (Number.isNaN(parsed.getTime())) throw new Error(`发票账期日期无法解析：${dueDate}`);
  return parsed.toISOString().slice(0, 10);
}

/**
 * 解析发票判断逾期时应使用的时区：
 * 1) 发票上的开票时快照（历史时区变更不影响已开发票，保证重复扫描结论稳定）；
 * 2) 旧发票无快照时，按客户时区历史中开票时刻生效的时区（在历史变更功能上线前开的票取最早一条）；
 * 3) 客户当前配置。
 * 返回时区及无效/缺失原因，供调用方决定抛错还是在批量扫描中降级记录。
 */
function resolveInvoiceTimezone(invoice: Invoice, customer: Customer | undefined): { timezone?: string; reason: 'timezone_snapshot' | 'timezone_history' | 'customer_current'; error?: string } {
  // 快照存在即视为发票的权威时区来源：快照无效说明存量数据损坏，必须显式报错，不能静默回退掩盖问题。
  if (invoice.timezone !== undefined) {
    if (isValidTimezone(invoice.timezone)) return { timezone: invoice.timezone, reason: 'timezone_snapshot' };
    return { reason: 'timezone_snapshot', error: `发票 ${invoice.number} 快照时区无效：${invoice.timezone}` };
  }
  // 无快照的历史发票：按客户时区变更历史回溯开票当时生效的时区。
  if (!customer) return { reason: 'customer_current', error: '客户配置缺失，无法确定账期时区' };
  const history = [...(customer.timezoneHistory ?? [])].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const historical = [...history].reverse().find(entry => entry.effectiveFrom.localeCompare(invoice.createdAt) <= 0);
  if (historical) {
    if (isValidTimezone(historical.timezone)) return { timezone: historical.timezone, reason: 'timezone_history' };
    return { reason: 'timezone_history', error: `客户 ${customer.id} 的历史时区无效：${historical.timezone}` };
  }
  if (!customer.timezone) return { reason: 'customer_current', error: `客户 ${customer.id} 未配置时区` };
  if (!isValidTimezone(customer.timezone)) return { reason: 'customer_current', error: `客户 ${customer.id} 的时区无效：${customer.timezone}` };
  return { timezone: customer.timezone, reason: 'customer_current' };
}

/** 逾期判断核心：按客户当地日历日期比较。宽限期含 dueDate 当天（dueDate + graceDays 当天仍不逾期，之后第一天才算逾期）。 */
function evaluateOverdue(invoice: Invoice, customer: Customer | undefined, asOf: Date, graceDays: number): {
  timezone?: string; timezoneSource?: string; evaluatedDate?: string; dueLocalDate: string; graceUntilDate?: string; overdue: boolean; error?: string;
} {
  const resolved = resolveInvoiceTimezone(invoice, customer);
  if (resolved.error) return { dueLocalDate: dueCalendarDate(invoice.dueDate), overdue: false, error: resolved.error };
  const zone = resolved.timezone!;
  const evaluatedDate = localCalendarDate(asOf, zone);
  const dueLocalDate = dueCalendarDate(invoice.dueDate);
  const graceUntilDate = addCalendarDays(dueLocalDate, graceDays);
  // 已支付/作废的发票不再计入逾期；其余仅在客户当地日期严格晚于（账期日 + 宽限天数）当天时逾期。
  const settled = invoice.status === 'paid' || invoice.status === 'void';
  return { timezone: zone, timezoneSource: resolved.reason, evaluatedDate, dueLocalDate, graceUntilDate, overdue: !settled && evaluatedDate > graceUntilDate };
}

export const state: State = {
  tenants: [{ id: 'tenant-acme', name: 'Acme Global Trading', creditLimit: 250000, creditUsed: 36200, currency: 'USD' }],
  customers: [{ id: 'CUS-001', tenantId: 'tenant-acme', name: 'Northstar Retail GmbH', creditLimit: 100000, creditUsed: 12000, blocked: false, timezone: 'Europe/Berlin' }, { id: 'CUS-002', tenantId: 'tenant-acme', name: 'Pacific Parts Inc.', creditLimit: 50000, creditUsed: 49000, blocked: false, timezone: 'America/Los_Angeles' }],
  orders: [], inventory: [
    { id: 'LOT-001', tenantId: 'tenant-acme', warehouse: 'SHANGHAI-FTZ', sku: 'SENSOR-X9', available: 80, reserved: 10, lotCode: 'SX9-2608' },
    { id: 'LOT-002', tenantId: 'tenant-acme', warehouse: 'SHANGHAI-FTZ', sku: 'CONTROL-M2', available: 36, reserved: 4, lotCode: 'CM2-2607' },
    { id: 'LOT-003', tenantId: 'tenant-acme', warehouse: 'ROTTERDAM-DC', sku: 'SENSOR-X9', available: 12, reserved: 0, lotCode: 'SX9-2606' }
  ], reservations: [], shipments: [], customs: [], invoices: [], payments: [], approvals: [], audit: [], outbox: []
};

function tenant(id: string) { const value = state.tenants.find(item => item.id === id); if (!value) throw new Error('租户不存在'); return value; }
function assertTenant<T extends { tenantId: string }>(item: T, tenantId: string) { if (item.tenantId !== tenantId) throw new Error('无权访问其他租户的数据'); return item; }
function customerFor(tenantId: string, customerId: string) { const customer = state.customers.find(item => item.id === customerId && item.tenantId === tenantId); if (!customer) throw new Error('客户不存在'); return customer; }
function orderFor(tenantId: string, orderId: string) { const order = state.orders.find(item => item.id === orderId); if (!order) throw new Error('订单不存在'); return assertTenant(order, tenantId); }
function record(tenantId: string, actor: string, action: string, entityType: string, entityId: string, before?: unknown, after?: unknown) { state.audit.unshift({ id: id('AUD'), tenantId, actor, action, entityType, entityId, before: before === undefined ? undefined : clone(before), after: after === undefined ? undefined : clone(after), at: now() }); }
function emit(tenantId: string, topic: string, aggregateId: string, payload: unknown) { state.outbox.unshift({ id: id('EVT'), tenantId, topic, aggregateId, payload: clone(payload), status: 'pending', attempts: 0, createdAt: now() }); }
function mutate(tenantId: string, actor: string, action: string, type: string, entityId: string, before: unknown, after: unknown, topic: string) { record(tenantId, actor, action, type, entityId, before, after); if (action !== 'order.confirmed') emit(tenantId, topic, entityId, after); }
function transition(order: Order, next: OrderStatus) { const allowed: Record<OrderStatus, OrderStatus[]> = { draft: ['confirmed', 'cancelled'], confirmed: ['allocated', 'cancelled'], allocated: ['dispatched', 'cancelled'], dispatched: ['delivered'], delivered: ['closed', 'dispatched'], closed: [], cancelled: [] }; if (!allowed[order.status].includes(next)) throw new Error(`订单不能从 ${order.status} 变更为 ${next}`); order.status = next; order.version += 1; order.updatedAt = now(); }

export function listOrders(tenantId: string, filters: { status?: string; customerId?: string; q?: string } = {}) { tenant(tenantId); return state.orders.filter(item => item.tenantId === tenantId && (!filters.status || item.status === filters.status) && (!filters.customerId || item.customerId === filters.customerId) && (!filters.q || `${item.reference} ${item.destination}`.toLowerCase().includes(filters.q.toLowerCase()))).map(clone); }
export function getOrder(tenantId: string, orderId: string) { return clone(orderFor(tenantId, orderId)); }
export function createOrder(tenantId: string, input: Partial<Order>, actor = 'system') {
  tenant(tenantId); if (!input.customerId || !input.reference || !input.origin || !input.destination || !input.items?.length) throw new Error('客户、参考号、起讫地和订单明细均不能为空');
  if (state.orders.some(item => item.reference === input.reference)) throw new Error('客户参考号已存在');
  const items = input.items.map(item => { if (!item.sku || !item.quantity || item.quantity <= 0 || !item.unitPrice || item.unitPrice < 0 || !item.weightKg || item.weightKg <= 0) throw new Error('订单明细数量、价格和重量必须为正数'); return { sku: item.sku, description: item.description ?? item.sku, quantity: item.quantity, unitPrice: item.unitPrice, weightKg: item.weightKg, hsCode: item.hsCode ?? '0000.00' }; });
  const subtotal = money(items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0)); const order: Order = { id: id('ORD'), tenantId, customerId: input.customerId, reference: input.reference, origin: input.origin, destination: input.destination, priority: input.priority ?? 'standard', status: 'draft', items, totalWeightKg: money(items.reduce((sum, item) => sum + item.quantity * item.weightKg, 0)), subtotal, totalAmount: subtotal, currency: input.currency ?? tenant(tenantId).currency, version: 1, createdAt: now(), updatedAt: now() };
  state.orders.unshift(order); mutate(tenantId, actor, 'order.created', 'order', order.id, undefined, order, 'order.created'); return clone(order);
}
export function confirmOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const before = clone(order); const customer = customerFor(tenantId, order.customerId); if (customer.blocked) throw new Error('客户已被风控冻结'); if (customer.creditUsed + order.totalAmount > customer.creditLimit) { const approval = createApproval(tenantId, { orderId, type: 'credit_override', reason: '订单金额超过客户授信额度' }, actor); throw new Error(`客户授信不足，需要审批 ${approval.id}`); } transition(order, 'confirmed'); customer.creditUsed = money(customer.creditUsed + order.totalAmount); mutate(tenantId, actor, 'order.confirmed', 'order', order.id, before, order, 'order.confirmed'); return clone(order); }
export function allocateOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const before = clone(order); const allocations: Reservation[] = []; for (const item of order.items) { let remaining = item.quantity; for (const lot of state.inventory.filter(value => value.tenantId === tenantId && value.sku === item.sku && value.available - value.reserved > 0)) { const qty = Math.min(remaining, lot.available); lot.reserved += qty; remaining -= qty; allocations.push({ id: id('RSV'), tenantId, orderId, lotId: lot.id, sku: item.sku, quantity: qty, status: 'active', createdAt: now() }); if (!remaining) break; } if (remaining) { for (const allocation of allocations) { const lot = state.inventory.find(value => value.id === allocation.lotId)!; lot.reserved -= allocation.quantity; } throw new Error(`库存不足：${item.sku} 还缺少 ${remaining}`); } } state.reservations.push(...allocations); transition(order, 'allocated'); mutate(tenantId, actor, 'order.allocated', 'order', order.id, before, { order, allocations }, 'inventory.reserved'); return clone(order); }
export function dispatchOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const customs = state.customs.find(item => item.orderId === orderId); if (!customs || customs.status !== 'cleared') throw new Error('海关申报尚未放行'); const reservations = state.reservations.filter(item => item.orderId === orderId && item.status === 'active'); if (!reservations.length) throw new Error('订单没有有效库存分配'); const before = clone(order); transition(order, 'dispatched'); reservations.forEach(reservation => { const lot = state.inventory.find(item => item.id === reservation.lotId)!; lot.available -= reservation.quantity; lot.reserved -= reservation.quantity; reservation.status = 'consumed'; }); const shipment: Shipment = { id: id('SHP'), tenantId, orderId, trackingNo: `CBF${Date.now().toString().slice(-8)}`, legs: [{ id: id('LEG'), tenantId, mode: 'truck', origin: order.origin, destination: '出口口岸', plannedDeparture: now(), plannedArrival: new Date(Date.now() + 86400000).toISOString(), status: 'planned' }, { id: id('LEG'), tenantId, mode: 'sea', origin: '出口口岸', destination: order.destination, plannedDeparture: new Date(Date.now() + 172800000).toISOString(), plannedArrival: new Date(Date.now() + 10 * 86400000).toISOString(), status: 'planned' }], currentLocation: order.origin, eta: new Date(Date.now() + 10 * 86400000).toISOString(), status: 'planned', events: [] }; state.shipments.push(shipment); order.shipmentId = shipment.id; mutate(tenantId, actor, 'order.dispatched', 'order', order.id, before, { order, shipment }, 'shipment.created'); return clone(order); }
export function deliverOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const shipment = state.shipments.find(item => item.orderId === orderId); if (!shipment) throw new Error('运输单不存在'); const before = clone(order); transition(order, 'delivered'); shipment.status = 'delivered'; shipment.currentLocation = order.destination; shipment.events.push({ id: id('TRK'), code: 'DELIVERED', location: order.destination, occurredAt: now(), note: '签收完成' }); mutate(tenantId, actor, 'order.delivered', 'order', order.id, before, { order, shipment }, 'shipment.delivered'); return clone(order); }
export function closeOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const invoice = state.invoices.find(item => item.orderId === orderId); if (!invoice || invoice.status !== 'paid') throw new Error('发票未完成收款核销'); const before = clone(order); transition(order, 'closed'); const customer = customerFor(tenantId, order.customerId); customer.creditUsed = money(Math.max(0, customer.creditUsed - order.totalAmount)); mutate(tenantId, actor, 'order.closed', 'order', order.id, before, order, 'order.closed'); return clone(order); }
export function cancelOrder(tenantId: string, orderId: string, actor = 'system') { const order = orderFor(tenantId, orderId); const before = clone(order); if (['dispatched', 'delivered', 'closed'].includes(order.status)) throw new Error('已出运订单不能取消'); transition(order, 'cancelled'); const reservation = state.reservations.find(item => item.orderId === orderId && item.status === 'active'); if (reservation) { state.inventory.find(lot => lot.id === reservation.lotId)!.reserved -= reservation.quantity; reservation.status = 'released'; } const customer = customerFor(tenantId, order.customerId); if (before.status !== 'draft') customer.creditUsed = money(Math.max(0, customer.creditUsed - order.totalAmount)); mutate(tenantId, actor, 'order.cancelled', 'order', order.id, before, order, 'order.cancelled'); return clone(order); }

export function createCustomsDeclaration(tenantId: string, input: { orderId: string; country?: string; requiredDocuments?: string[] }, actor = 'system') { const order = orderFor(tenantId, input.orderId); if (state.customs.some(item => item.orderId === order.id)) throw new Error('订单已有海关申报'); const declaration: CustomsDeclaration = { id: id('CUS'), tenantId, orderId: order.id, country: input.country ?? order.destination, status: 'draft', documentRefs: [], requiredDocuments: input.requiredDocuments ?? ['commercial-invoice', 'packing-list', 'origin-certificate'], riskScore: order.priority === 'critical' ? 82 : order.totalWeightKg > 1000 ? 60 : 24, updatedAt: now() }; state.customs.push(declaration); order.customsDeclarationId = declaration.id; mutate(tenantId, actor, 'customs.created', 'customs', declaration.id, undefined, declaration, 'customs.created'); return clone(declaration); }
export function updateCustoms(tenantId: string, declarationId: string, input: { status?: CustomsStatus; documentRefs?: string[]; rejectionReason?: string }, actor = 'system') { const declaration = assertTenant(state.customs.find(item => item.id === declarationId) ?? (() => { throw new Error('海关申报不存在'); })(), tenantId); const before = clone(declaration); if (input.documentRefs) declaration.documentRefs = [...new Set(input.documentRefs)]; if (input.status) { if (input.status === 'cleared' && declaration.requiredDocuments.some(doc => !declaration.documentRefs.includes(doc))) throw new Error('放行前必须补齐所有必需单证'); if (input.status === 'inspection' && declaration.status !== 'submitted') throw new Error('只有已提交申报才能进入查验'); declaration.status = input.status; } declaration.rejectionReason = input.rejectionReason; declaration.updatedAt = now(); mutate(tenantId, actor, 'customs.updated', 'customs', declaration.id, before, declaration, 'customs.updated'); return clone(declaration); }
export function addShipmentEvent(tenantId: string, shipmentId: string, input: { code: string; location: string; occurredAt?: string; note?: string }, actor = 'system') { const shipment = assertTenant(state.shipments.find(item => item.id === shipmentId) ?? (() => { throw new Error('运输单不存在'); })(), tenantId); if (!input.code || !input.location) throw new Error('轨迹编码和位置不能为空'); const event = { id: id('TRK'), code: input.code, location: input.location, occurredAt: input.occurredAt ?? now(), note: input.note }; shipment.events.push(event); shipment.currentLocation = input.location; if (input.code === 'DEPARTED') { shipment.status = 'in_transit'; shipment.legs[0].status = 'in_transit'; } if (input.code === 'DELAYED') { shipment.status = 'exception'; shipment.legs.find(leg => leg.status !== 'arrived')!.status = 'delayed'; createApproval(tenantId, { orderId: shipment.orderId, type: 'delay_compensation', reason: `运输轨迹 ${shipment.trackingNo} 发生延误` }, actor); } if (input.code === 'ARRIVED') shipment.legs[shipment.legs.length - 1].status = 'arrived'; record(tenantId, actor, 'shipment.event.added', 'shipment', shipment.id, undefined, event); emit(tenantId, 'shipment.event.added', shipment.id, event); return clone(shipment); }

export function generateInvoice(tenantId: string, orderId: string, input: { dueDate?: string; graceDays?: number } = {}, actor = 'system') {
  const order = orderFor(tenantId, orderId);
  const existing = state.invoices.find(item => item.orderId === orderId);
  if (existing) return clone(existing);
  if (!['allocated', 'dispatched', 'delivered', 'closed'].includes(order.status)) throw new Error('订单完成库存分配后才能开票');
  const customer = customerFor(tenantId, order.customerId);
  // 开票时即要求客户时区有效并做快照：既拦截无效/缺失配置，也保证客户日后改时区不影响已开发票。
  if (!customer.timezone) throw new Error(`客户 ${customer.id} 未配置 IANA 时区，无法确定账期日期`);
  if (!isValidTimezone(customer.timezone)) throw new Error(`客户 ${customer.id} 的 IANA 时区无效：${customer.timezone}`);
  const zone = customer.timezone;
  const issuedAt = new Date(nowMs());
  // net-30 账期按客户当地日历日推进 30 天：用 UTC 分量做日期算术，闰日、大小月自动正确，且不碰服务器本地时区。
  const issueLocalDate = localCalendarDate(issuedAt, zone);
  const dueDate = input.dueDate ?? addCalendarDays(issueLocalDate, 30);
  if (!CALENDAR_DATE.test(dueDate)) throw new Error('账期日期必须是客户当地 YYYY-MM-DD');
  const freight = money(Math.max(120, order.totalWeightKg * (order.priority === 'critical' ? 4.2 : 2.1))); const fuel = money(freight * 0.13); const customsFee = money(95 + order.items.length * 25); const lines: InvoiceLine[] = [{ code: 'GOODS', description: '货物服务费', quantity: 1, unitPrice: order.subtotal, amount: order.subtotal }, { code: 'FREIGHT', description: '跨境运输费', quantity: 1, unitPrice: freight, amount: freight }, { code: 'FUEL', description: '燃油附加费', quantity: 1, unitPrice: fuel, amount: fuel }, { code: 'CUSTOMS', description: '关务服务费', quantity: 1, unitPrice: customsFee, amount: customsFee }]; const subtotal = money(lines.reduce((sum, line) => sum + line.amount, 0)); const tax = money(subtotal * 0.06); const invoice: Invoice = { id: id('INV'), tenantId, orderId, number: `INV-${new Date().toISOString().slice(0, 4)}-${String(state.invoices.length + 1).padStart(5, '0')}`, status: 'issued', currency: order.currency, lines, subtotal, tax, total: money(subtotal + tax), paid: 0, dueDate, timezone: zone, createdAt: issuedAt.toISOString() }; state.invoices.push(invoice); order.invoiceId = invoice.id; mutate(tenantId, actor, 'invoice.issued', 'invoice', invoice.id, undefined, invoice, 'invoice.issued'); return clone(invoice);
}

/**
 * 维护客户 IANA 时区（临时修改也走此入口）。
 * 首次变更时把旧时区以客户创建时刻（无则 Unix 纪元）为起点补登历史，之后每条变更按生效时间入档，
 * 供历史开票（无快照的旧发票）回溯当时时区；同值重复设置不产生记录。
 */
export function updateCustomerTimezone(tenantId: string, customerId: string, timezone: string, actor = 'system') {
  const customer = customerFor(tenantId, customerId);
  if (!isValidTimezone(timezone)) throw new Error(`IANA 时区无效：${timezone}`);
  if (customer.timezone === timezone) return clone(customer);
  const before = clone(customer);
  const changedAt = now();
  const history = customer.timezoneHistory ?? [];
  if (history.length === 0 && customer.timezone) {
    // 首次变更前旧时区的起点不可考，用纪元兜底：历史发票一定晚于它，从而能回溯到旧时区。
    history.push({ timezone: customer.timezone, effectiveFrom: '1970-01-01T00:00:00.000Z' });
  }
  history.push({ timezone, effectiveFrom: changedAt });
  history.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  customer.timezoneHistory = history;
  customer.timezone = timezone;
  record(tenantId, actor, 'customer.timezone.updated', 'customer', customer.id, before, customer);
  emit(tenantId, 'customer.timezone.updated', customer.id, { customerId: customer.id, timezone });
  return clone(customer);
}
export function recordPayment(tenantId: string, input: { invoiceId: string; amount: number; method: Payment['method']; reference: string }, actor = 'system') { const invoice = assertTenant(state.invoices.find(item => item.id === input.invoiceId) ?? (() => { throw new Error('发票不存在'); })(), tenantId); if (!input.amount || input.amount <= 0 || input.amount > invoice.total - invoice.paid + 0.01) throw new Error('收款金额超过发票未核销余额'); const before = clone(invoice); const payment: Payment = { id: id('PAY'), tenantId, invoiceId: invoice.id, amount: money(input.amount), method: input.method, reference: input.reference, receivedAt: now() }; state.payments.push(payment); invoice.paid = money(invoice.paid + payment.amount); invoice.status = invoice.paid >= invoice.total - 0.01 ? 'paid' : 'partially_paid'; if (invoice.status === 'paid') { const order = state.orders.find(item => item.id === invoice.orderId); if (order) order.status = 'closed'; } mutate(tenantId, actor, 'payment.recorded', 'invoice', invoice.id, before, invoice, 'payment.recorded'); return clone(payment); }

export function createApproval(tenantId: string, input: { orderId: string; type: Approval['type']; reason: string }, actor = 'system') { orderFor(tenantId, input.orderId); const approval: Approval = { id: id('APR'), tenantId, orderId: input.orderId, type: input.type, reason: input.reason, status: 'pending', createdAt: now() }; state.approvals.push(approval); record(tenantId, actor, 'approval.created', 'approval', approval.id, undefined, approval); emit(tenantId, 'approval.created', approval.id, approval); return clone(approval); }
export function decideApproval(tenantId: string, approvalId: string, input: { status: Exclude<ApprovalStatus, 'pending'>; comment?: string }, actor: string) { const approval = assertTenant(state.approvals.find(item => item.id === approvalId) ?? (() => { throw new Error('审批不存在'); })(), tenantId); if (approval.status !== 'pending') throw new Error('审批已经决策'); const before = clone(approval); approval.status = input.status; approval.decidedBy = actor; approval.comment = input.comment; approval.decidedAt = now(); if (input.status === 'approved' && approval.type === 'credit_override') { const order = orderFor(tenantId, approval.orderId); const customer = customerFor(tenantId, order.customerId); customer.creditLimit = Math.max(customer.creditLimit, customer.creditUsed + order.totalAmount); } mutate(tenantId, actor, 'approval.decided', 'approval', approval.id, before, approval, 'approval.decided'); return clone(approval); }

export function operationSummary(tenantId: string, asOf: Date = new Date()) { tenant(tenantId); const orders = listOrders(tenantId); const invoices = state.invoices.filter(item => item.tenantId === tenantId); const shipments = state.shipments.filter(item => item.tenantId === tenantId); const overdueScan = scanOverdueInvoices(tenantId, { asOf, mark: true }); const overdueItems = overdueScan.items.filter((item): item is Extract<OverdueScanItem, OverdueResult> => !('error' in item) && item.overdue); const overdueInvoiceIds = new Set(overdueItems.map(item => item.invoiceId)); return { tenantId, generatedAt: now(), asOf: asOf.toISOString(), orderCount: orders.length, byStatus: orders.reduce<Record<string, number>>((acc, item) => { acc[item.status] = (acc[item.status] ?? 0) + 1; return acc; }, {}), grossMerchandiseValue: money(orders.reduce((sum, item) => sum + item.totalAmount, 0)), receivable: money(invoices.filter(item => item.status !== 'void' && item.status !== 'paid').reduce((sum, item) => sum + item.total - item.paid, 0)), paid: money(invoices.reduce((sum, item) => sum + item.paid, 0)), overdueInvoices: overdueItems.length, overdueReceivable: money(invoices.filter(item => overdueInvoiceIds.has(item.id)).reduce((sum, item) => sum + item.total - item.paid, 0)), overdueErrors: overdueScan.errors, delayedShipments: shipments.filter(item => item.status === 'exception').length, pendingApprovals: state.approvals.filter(item => item.tenantId === tenantId && item.status === 'pending').length, inventory: state.inventory.filter(item => item.tenantId === tenantId).map(item => ({ warehouse: item.warehouse, sku: item.sku, available: item.available, reserved: item.reserved, free: item.available - item.reserved })) }; }
export function timeline(tenantId: string, orderId: string) { const order = orderFor(tenantId, orderId); const relatedIds = new Set([order.id]); const shipment = state.shipments.find(item => item.orderId === orderId); const customs = state.customs.find(item => item.orderId === orderId); const invoice = state.invoices.find(item => item.orderId === orderId); if (shipment) relatedIds.add(shipment.id); if (customs) relatedIds.add(customs.id); if (invoice) relatedIds.add(invoice.id); state.approvals.filter(item => item.orderId === orderId).forEach(item => relatedIds.add(item.id)); return state.audit.filter(item => item.tenantId === tenantId && relatedIds.has(item.entityId)).sort((a, b) => b.at.localeCompare(a.at)).map(clone); }
export function listAudit(tenantId: string, limit = 100) { tenant(tenantId); return state.audit.filter(item => item.tenantId === tenantId).slice(0, Math.min(limit, 500)).map(clone); }
export function listOutbox(tenantId: string, status?: OutboxEvent['status']) { tenant(tenantId); return state.outbox.filter(item => (!status || item.status === status)).map(clone); }
export function publishOutbox(tenantId: string, eventId: string, actor = 'system') { const event = assertTenant(state.outbox.find(item => item.id === eventId) ?? (() => { throw new Error('事件不存在'); })(), tenantId); if (event.status === 'published') return clone(event); event.status = 'published'; event.attempts += 1; record(tenantId, actor, 'outbox.published', 'outbox', event.id, { status: 'pending' }, event); return clone(event); }


export type OrderPage = { items: Order[]; nextCursor?: string; total: number };
export function listOrdersPage(tenantId: string, input: { cursor?: string; limit?: number } = {}) {
  tenant(tenantId);
  const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
  const offset = input.cursor ? Number.parseInt(input.cursor, 10) || 0 : 0;
  const ordered = state.orders.filter(item => item.tenantId === tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const items = ordered.slice(offset, offset + limit).map(clone);
  return { items, nextCursor: offset + limit < ordered.length ? String(offset + limit) : undefined, total: ordered.length };
}
export type OverdueResult = {
  invoiceId: string;
  overdue: boolean;
  evaluatedDate: string;       // asOf 在客户时区下的当地日历日期
  dueDate: string;             // 客户当地账期日期（YYYY-MM-DD）
  graceUntilDate: string;      // 宽限期最后一天（含当天）；逾期判定 = evaluatedDate 严格大于此日期
  customerTimezone: string;
  timezoneSource: string;      // snapshot | history | current
  status: InvoiceStatus;
  overdueSince?: string;
};

/**
 * 判断单张发票是否逾期。
 * 严格按照发票关联客户保存的 IANA 时区，把 asOf（UTC 瞬时）换算成客户当地日历日期后比较；
 * 宽限期 graceDays 包含 dueDate 当天：dueDate + graceDays 当天 23:59 前都不算逾期，次日才逾期（默认 0：dueDate 当天不逾期）。
 * 时区取值优先发票快照，保证同一张发票在任何服务器时区下、重复扫描中结论稳定。
 */
export function invoiceOverdue(tenantId: string, invoiceId: string, asOf: Date = new Date(), graceDays = DEFAULT_GRACE_DAYS) {
  if (Number.isNaN(asOf.getTime())) throw new Error('asOf 不是合法日期');
  if (!Number.isInteger(graceDays) || graceDays < 0) throw new Error('宽限天数必须是非负整数');
  const invoice = assertTenant(state.invoices.find(item => item.id === invoiceId) ?? (() => { throw new Error('发票不存在'); })(), tenantId);
  const order = state.orders.find(item => item.id === invoice.orderId);
  if (order) assertTenant(order, tenantId);
  const customer = order ? state.customers.find(item => item.id === order.customerId && item.tenantId === tenantId) : undefined;
  const result = evaluateOverdue(invoice, customer, asOf, graceDays);
  if (result.error) throw new Error(result.error);
  return {
    invoiceId,
    overdue: result.overdue,
    evaluatedDate: result.evaluatedDate!,
    dueDate: result.dueLocalDate,
    graceUntilDate: result.graceUntilDate!,
    customerTimezone: result.timezone!,
    timezoneSource: result.timezoneSource!,
    status: invoice.status,
    overdueSince: invoice.overdueSince
  } satisfies OverdueResult;
}

export type OverdueScanItem = (OverdueResult & { number: string; customerId?: string }) | { invoiceId: string; number: string; error: string };

/**
 * 批量逾期扫描：整批共用同一个 asOf UTC 瞬时，逐张按各客户时区换算当地日期判断。
 * - 租户隔离：只扫描该租户发票，且经订单/客户同租户校验；
 * - 幂等稳定：只在「未逾期 → 逾期」首次发生时把 overdueSince 锁存为本次扫描瞬时并写 audit/outbox，
 *   之后重复扫描结论与 overdueSince 都不再改变（状态翻转、服务器时区均不影响），已支付/作废不会被锁存；
 * - 个别发票配置错误（无效/缺失时区、缺失客户）不中断整批，作为 error 条目返回。
 */
export function scanOverdueInvoices(tenantId: string, options: { asOf?: Date; graceDays?: number; mark?: boolean } = {}) {
  tenant(tenantId);
  const asOf = options.asOf ?? new Date();
  if (Number.isNaN(asOf.getTime())) throw new Error('asOf 不是合法日期');
  const graceDays = options.graceDays ?? DEFAULT_GRACE_DAYS;
  if (!Number.isInteger(graceDays) || graceDays < 0) throw new Error('宽限天数必须是非负整数');
  const mark = options.mark ?? true;
  const asOfIso = asOf.toISOString();
  const items: OverdueScanItem[] = [];
  for (const invoice of state.invoices.filter(item => item.tenantId === tenantId)) {
    const order = state.orders.find(item => item.id === invoice.orderId);
    if (order && order.tenantId !== tenantId) continue; // 租户隔离双保险
    const customer = order ? state.customers.find(item => item.id === order.customerId && item.tenantId === tenantId) : undefined;
    const evaluated = evaluateOverdue(invoice, customer, asOf, graceDays);
    if (evaluated.error) {
      items.push({ invoiceId: invoice.id, number: invoice.number, error: evaluated.error });
      continue;
    }
    if (mark && evaluated.overdue && !invoice.overdueSince) {
      const before = clone(invoice);
      invoice.overdueSince = asOfIso;
      // 仅首次逾期落审计，重复扫描不重复记录、不改变任何状态。
      record(tenantId, 'system', 'invoice.overdue.marked', 'invoice', invoice.id, before, invoice);
      emit(tenantId, 'invoice.overdue', invoice.id, { invoiceId: invoice.id, number: invoice.number, overdueSince: asOfIso, evaluatedDate: evaluated.evaluatedDate, timezone: evaluated.timezone });
    }
    items.push({
      invoiceId: invoice.id, number: invoice.number, customerId: order?.customerId,
      overdue: evaluated.overdue, evaluatedDate: evaluated.evaluatedDate!, dueDate: evaluated.dueLocalDate,
      graceUntilDate: evaluated.graceUntilDate!, customerTimezone: evaluated.timezone!, timezoneSource: evaluated.timezoneSource!,
      status: invoice.status, overdueSince: invoice.overdueSince
    });
  }
  const okItems = items.filter((item): item is Extract<OverdueScanItem, OverdueResult> => !('error' in item));
  return {
    tenantId, asOf: asOfIso, graceDays,
    scanned: items.length, overdue: okItems.filter(item => item.overdue).length, errors: items.filter((item): item is { invoiceId: string; number: string; error: string } => 'error' in item).length,
    items
  };
}

// seed a coherent flow for demos: one order is allocated, one customs declaration is cleared, and one invoice is partially paid.
const seeded = createOrder('tenant-acme', { customerId: 'CUS-001', reference: 'PO-2026-0918', origin: '上海保税区', destination: '鹿特丹', priority: 'urgent', items: [{ sku: 'SENSOR-X9', description: '工业温度传感器', quantity: 10, unitPrice: 180, weightKg: 2.4, hsCode: '9025.19' }, { sku: 'CONTROL-M2', description: '边缘控制模块', quantity: 4, unitPrice: 420, weightKg: 3.2, hsCode: '8537.10' }] });
confirmOrder('tenant-acme', seeded.id); allocateOrder('tenant-acme', seeded.id); const seededDeclaration = createCustomsDeclaration('tenant-acme', { orderId: seeded.id }); updateCustoms('tenant-acme', seededDeclaration.id, { documentRefs: ['commercial-invoice', 'packing-list', 'origin-certificate'], status: 'submitted' }); updateCustoms('tenant-acme', seededDeclaration.id, { status: 'cleared' }); dispatchOrder('tenant-acme', seeded.id); const seededInvoice = generateInvoice('tenant-acme', seeded.id); recordPayment('tenant-acme', { invoiceId: seededInvoice.id, amount: 500, method: 'bank_transfer', reference: 'BANK-DEMO-001' });
