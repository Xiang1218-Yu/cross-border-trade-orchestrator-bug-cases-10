import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOrder, confirmOrder, createCustomsDeclaration, createOrder, decideApproval, dispatchOrder, generateInvoice, invoiceOverdue, operationSummary, recordPayment, scanOverdueInvoices, state, updateCustoms } from './domain.js';

test('order lifecycle preserves credit, inventory, customs, shipment and invoice invariants', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-001', reference: `TEST-${Date.now()}`, origin: '上海', destination: '汉堡', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 2, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] });
  assert.equal(order.status, 'draft');
  confirmOrder('tenant-acme', order.id, 'tester');
  allocateOrder('tenant-acme', order.id, 'tester');
  const declaration = createCustomsDeclaration('tenant-acme', { orderId: order.id });
  updateCustoms('tenant-acme', declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tester');
  updateCustoms('tenant-acme', declaration.id, { status: 'cleared' }, 'tester');
  const dispatched = dispatchOrder('tenant-acme', order.id, 'tester');
  assert.equal(dispatched.status, 'dispatched');
  const invoice = generateInvoice('tenant-acme', order.id, 'tester');
  assert.ok(invoice.total > invoice.subtotal);
  recordPayment('tenant-acme', { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: `PAY-${Date.now()}` }, 'tester');
  assert.equal(state.invoices.find(item => item.id === invoice.id)?.status, 'paid');
});

test('credit overage creates approval and approval increases only the required limit', () => {
  const order = createOrder('tenant-acme', { customerId: 'CUS-002', reference: `CREDIT-${Date.now()}`, origin: '深圳', destination: '洛杉矶', items: [{ description: '控制模块', sku: 'CONTROL-M2', quantity: 10, unitPrice: 420, weightKg: 2, hsCode: '8537.10' }] });
  assert.throws(() => confirmOrder('tenant-acme', order.id, 'tester'), /需要审批/);
  const approval = state.approvals.find(item => item.orderId === order.id && item.type === 'credit_override');
  assert.ok(approval);
  decideApproval('tenant-acme', approval!.id, { status: 'approved', comment: '额度复核通过' }, 'finance');
  assert.doesNotThrow(() => confirmOrder('tenant-acme', order.id, 'finance'));
});

test('operation summary exposes receivable and reservation metrics', () => {
  const summary = operationSummary('tenant-acme');
  assert.ok(summary.orderCount >= 1);
  assert.ok(summary.receivable >= 0);
  assert.ok(summary.inventory.every(item => item.available >= item.reserved));
});

// ---- 逾期判定时区缺陷修复的回归测试 ----
let tzSeq = 0;
function makeInvoiceWithDueDate(timezone: string | undefined, dueDate: string) {
  tzSeq += 1;
  const customerId = `CUS-TZ-${tzSeq}`;
  state.customers.push({ id: customerId, tenantId: 'tenant-acme', name: `TZ Customer ${tzSeq}`, creditLimit: 1000000, creditUsed: 0, blocked: false, timezone });
  const order = createOrder('tenant-acme', { customerId, reference: `TZ-ORDER-${tzSeq}`, origin: '上海', destination: '鹿特丹', items: [{ description: '传感器', sku: 'SENSOR-X9', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }] }, 'tz-test');
  confirmOrder('tenant-acme', order.id, 'tz-test');
  allocateOrder('tenant-acme', order.id, 'tz-test');
  const invoice = generateInvoice('tenant-acme', order.id, 'tz-test');
  state.invoices.find(item => item.id === invoice.id)!.dueDate = dueDate;
  return { customerId, invoiceId: invoice.id };
}
function setDueDate(invoiceId: string, dueDate: string) { state.invoices.find(item => item.id === invoiceId)!.dueDate = dueDate; }

test('overdue is judged by the customer local date, not the UTC date, at the day boundary', () => {
  // asOf = 2026-10-05T17:30Z：UTC 日期仍是 10-05（旧实现会对所有客户判未逾期）；
  // 上海/新加坡已进 10-06（逾期），鹿特丹/洛杉矶仍是 10-05 账期当天（宽限期内）。
  const shanghai = makeInvoiceWithDueDate('Asia/Shanghai', '2026-10-05T00:00:00.000Z');
  const singapore = makeInvoiceWithDueDate('Asia/Singapore', '2026-10-05T00:00:00.000Z');
  const rotterdam = makeInvoiceWithDueDate('Europe/Amsterdam', '2026-10-05T00:00:00.000Z');
  const losAngeles = makeInvoiceWithDueDate('America/Los_Angeles', '2026-10-05T00:00:00.000Z');
  const asOf = new Date('2026-10-05T17:30:00.000Z');
  assert.equal(invoiceOverdue('tenant-acme', shanghai.invoiceId, asOf).overdue, true);
  assert.equal(invoiceOverdue('tenant-acme', singapore.invoiceId, asOf).overdue, true);
  assert.equal(invoiceOverdue('tenant-acme', rotterdam.invoiceId, asOf).overdue, false);
  assert.equal(invoiceOverdue('tenant-acme', losAngeles.invoiceId, asOf).overdue, false);
  // 对称方向：asOf = 2026-10-06T05:00Z，UTC 日期已是 10-06（旧实现会对洛杉矶误判逾期），但洛杉矶当地仍是 10-05 账期当天。
  const asOf2 = new Date('2026-10-06T05:00:00.000Z');
  assert.equal(invoiceOverdue('tenant-acme', losAngeles.invoiceId, asOf2).overdue, false);
  assert.equal(invoiceOverdue('tenant-acme', shanghai.invoiceId, asOf2).overdue, true);
  for (const item of [shanghai, singapore, rotterdam, losAngeles]) setDueDate(item.invoiceId, '2099-01-01T00:00:00.000Z');
});

test('dueDate day itself is inside the grace period; overdue starts the next local day', () => {
  const { invoiceId } = makeInvoiceWithDueDate('Asia/Shanghai', '2026-03-10T00:00:00.000Z');
  // 上海当地 2026-03-10 23:59:59（账期当天最后一秒）——宽限期内
  assert.equal(invoiceOverdue('tenant-acme', invoiceId, new Date('2026-03-10T15:59:59.000Z')).overdue, false);
  // 上海当地 2026-03-11 00:00:00（账期次日第一秒）——逾期
  assert.equal(invoiceOverdue('tenant-acme', invoiceId, new Date('2026-03-10T16:00:00.000Z')).overdue, true);
  setDueDate(invoiceId, '2099-01-01T00:00:00.000Z');
});

test('invalid or missing timezone falls back to UTC without throwing', () => {
  const invalid = makeInvoiceWithDueDate('Mars/Olympus_Mons', '2026-04-02T00:00:00.000Z');
  const asOf = new Date('2026-04-03T00:30:00.000Z'); // UTC 日期 04-03 > 账期 04-02
  const invalidResult = invoiceOverdue('tenant-acme', invalid.invoiceId, asOf);
  assert.equal(invalidResult.timezoneValid, false);
  assert.equal(invalidResult.evaluatedTimezone, 'UTC');
  assert.equal(invalidResult.customerTimezone, 'Mars/Olympus_Mons');
  assert.equal(invalidResult.evaluatedDate, '2026-04-03');
  assert.equal(invalidResult.overdue, true);
  const missing = makeInvoiceWithDueDate(undefined, '2026-04-02T00:00:00.000Z');
  const missingResult = invoiceOverdue('tenant-acme', missing.invoiceId, asOf);
  assert.equal(missingResult.timezoneValid, false);
  assert.equal(missingResult.evaluatedTimezone, 'UTC');
  assert.equal(missingResult.overdue, true);
  setDueDate(invalid.invoiceId, '2099-01-01T00:00:00.000Z');
  setDueDate(missing.invoiceId, '2099-01-01T00:00:00.000Z');
});

test('missing customer configuration is tolerated and flagged', () => {
  const { customerId, invoiceId } = makeInvoiceWithDueDate('Asia/Shanghai', '2026-04-02T00:00:00.000Z');
  const index = state.customers.findIndex(item => item.id === customerId);
  const [removed] = state.customers.splice(index, 1);
  try {
    const result = invoiceOverdue('tenant-acme', invoiceId, new Date('2026-04-03T00:30:00.000Z'));
    assert.equal(result.customerConfigured, false);
    assert.equal(result.evaluatedTimezone, 'UTC');
    assert.equal(result.overdue, true);
  } finally {
    state.customers.push(removed);
    setDueDate(invoiceId, '2099-01-01T00:00:00.000Z');
  }
});

test('DST transition days use the offset in effect at the asOf instant', () => {
  const { invoiceId } = makeInvoiceWithDueDate('America/Los_Angeles', '2026-03-08T00:00:00.000Z');
  // 2026-03-08 美国夏令时开始（PDT = UTC-7）：03-09 06:59:59Z 仍是当地 03-08 23:59:59（账期当天，宽限）
  assert.equal(invoiceOverdue('tenant-acme', invoiceId, new Date('2026-03-09T06:59:59.000Z')).overdue, false);
  // 03-09 07:00:00Z 即当地 03-09 00:00:00 —— 逾期；若错用 PST(-8) 会误判为仍处宽限期
  assert.equal(invoiceOverdue('tenant-acme', invoiceId, new Date('2026-03-09T07:00:00.000Z')).overdue, true);
  setDueDate(invoiceId, '2026-11-01T00:00:00.000Z');
  // 2026-11-01 夏令时结束（PST = UTC-8）：11-02 07:59:59Z 仍是当地 11-01 23:59:59（宽限）
  assert.equal(invoiceOverdue('tenant-acme', invoiceId, new Date('2026-11-02T07:59:59.000Z')).overdue, false);
  // 11-02 08:00:00Z 即当地 11-02 00:00:00 —— 逾期；若错用 PDT(-7) 会提前一小时误判
  assert.equal(invoiceOverdue('tenant-acme', invoiceId, new Date('2026-11-02T08:00:00.000Z')).overdue, true);
  setDueDate(invoiceId, '2099-01-01T00:00:00.000Z');
});

test('leap day dueDate is compared as a calendar date', () => {
  const { invoiceId } = makeInvoiceWithDueDate('Asia/Shanghai', '2024-02-29T00:00:00.000Z');
  // 上海当地 2024-02-29 23:59:59（闰日账期当天）——宽限
  assert.equal(invoiceOverdue('tenant-acme', invoiceId, new Date('2024-02-29T15:59:59.000Z')).overdue, false);
  // 上海当地 2024-03-01 00:00:00 —— 逾期
  assert.equal(invoiceOverdue('tenant-acme', invoiceId, new Date('2024-02-29T16:00:00.000Z')).overdue, true);
  // 洛杉矶当地仍是 2024-02-29（账期当天）——宽限
  const la = makeInvoiceWithDueDate('America/Los_Angeles', '2024-02-29T00:00:00.000Z');
  assert.equal(invoiceOverdue('tenant-acme', la.invoiceId, new Date('2024-03-01T07:59:59.000Z')).overdue, false);
  assert.equal(invoiceOverdue('tenant-acme', la.invoiceId, new Date('2024-03-01T08:00:00.000Z')).overdue, true);
});

test('historical timezone changes are resolved by the tz database (Samoa skipped 2011-12-30)', () => {
  const { invoiceId } = makeInvoiceWithDueDate('Pacific/Apia', '2011-12-30T00:00:00.000Z');
  // 萨摩亚 2011-12-30 全天不存在：09:59:59Z 仍是当地 12-29（UTC-10，账期前一日）——未逾期
  const before = invoiceOverdue('tenant-acme', invoiceId, new Date('2011-12-30T09:59:59.000Z'));
  assert.equal(before.evaluatedDate, '2011-12-29');
  assert.equal(before.overdue, false);
  // 10:00:00Z 直接跳到当地 12-31（UTC+14）——越过账期日，逾期
  const after = invoiceOverdue('tenant-acme', invoiceId, new Date('2011-12-30T10:00:00.000Z'));
  assert.equal(after.evaluatedDate, '2011-12-31');
  assert.equal(after.overdue, true);
});

test('paid or void invoices are never overdue', () => {
  const paidInvoice = makeInvoiceWithDueDate('Asia/Shanghai', '2000-01-01T00:00:00.000Z');
  const stored = state.invoices.find(item => item.id === paidInvoice.invoiceId)!;
  recordPayment('tenant-acme', { invoiceId: paidInvoice.invoiceId, amount: stored.total, method: 'bank_transfer', reference: `PAY-TZ-${tzSeq}` }, 'tz-test');
  assert.equal(invoiceOverdue('tenant-acme', paidInvoice.invoiceId, new Date('2026-10-06T00:00:00.000Z')).overdue, false);
  const voidInvoice = makeInvoiceWithDueDate('Asia/Shanghai', '2000-01-01T00:00:00.000Z');
  state.invoices.find(item => item.id === voidInvoice.invoiceId)!.status = 'void';
  assert.equal(invoiceOverdue('tenant-acme', voidInvoice.invoiceId, new Date('2026-10-06T00:00:00.000Z')).overdue, false);
});

test('overdue judgement is isolated per tenant and rejects invalid asOf', () => {
  const { invoiceId } = makeInvoiceWithDueDate('Asia/Shanghai', '2000-01-01T00:00:00.000Z');
  assert.throws(() => invoiceOverdue('tenant-other', invoiceId, new Date('2026-10-06T00:00:00.000Z')));
  assert.throws(() => invoiceOverdue('tenant-acme', invoiceId, new Date('not-a-date')), /asOf/);
});

test('batch scan is deterministic across repeats, keeps invoice status untouched, and audits consistently', () => {
  const asOf = new Date('2026-10-06T12:00:00.000Z');
  const statusBefore = state.invoices.map(item => ({ id: item.id, status: item.status }));
  const first = scanOverdueInvoices('tenant-acme', asOf, 'tz-test');
  const second = scanOverdueInvoices('tenant-acme', asOf, 'tz-test');
  assert.deepEqual(second.items, first.items);
  assert.equal(second.overdueCount, first.overdueCount);
  assert.deepEqual(state.invoices.map(item => ({ id: item.id, status: item.status })), statusBefore);
  // 单票接口与批量扫描逐项一致
  for (const item of first.items) assert.equal(invoiceOverdue('tenant-acme', item.invoiceId, asOf).overdue, item.overdue);
  // audit 记录与扫描结论一致
  const audit = state.audit.find(item => item.action === 'invoice.overdue.scanned');
  assert.ok(audit);
  const recorded = audit.after as { asOf: string; scanned: number; overdue: string[] };
  assert.equal(recorded.asOf, asOf.toISOString());
  assert.equal(recorded.scanned, first.scanned);
  assert.deepEqual(recorded.overdue, first.items.filter(item => item.overdue).map(item => item.invoiceId));
  // 批量扫描只覆盖本租户发票
  assert.ok(first.items.every(item => state.invoices.find(invoice => invoice.id === item.invoiceId)?.tenantId === 'tenant-acme'));
});

test('operation summary overdue metrics agree with the batch scan', () => {
  const scan = scanOverdueInvoices('tenant-acme');
  const summary = operationSummary('tenant-acme');
  assert.equal(summary.overdueInvoices, scan.overdueCount);
  const expectedAmount = Math.round(scan.items.filter(item => item.overdue).reduce((sum, item) => sum + item.outstanding, 0) * 100) / 100;
  assert.equal(summary.overdueAmount, expectedAmount);
});

test('customer timezone changes take effect per evaluation without persisting flip-flops', () => {
  const { customerId, invoiceId } = makeInvoiceWithDueDate('Asia/Shanghai', '2026-10-05T00:00:00.000Z');
  const customer = state.customers.find(item => item.id === customerId)!;
  const asOf = new Date('2026-10-05T17:30:00.000Z'); // 上海已逾期，UTC 口径未逾期
  const first = invoiceOverdue('tenant-acme', invoiceId, asOf);
  assert.equal(first.overdue, true);
  customer.timezone = 'UTC'; // 客户临时修改时区
  assert.equal(invoiceOverdue('tenant-acme', invoiceId, asOf).overdue, false);
  customer.timezone = 'Asia/Shanghai'; // 改回后结论与首次完全一致
  assert.deepEqual(invoiceOverdue('tenant-acme', invoiceId, asOf), first);
  setDueDate(invoiceId, '2099-01-01T00:00:00.000Z');
});
