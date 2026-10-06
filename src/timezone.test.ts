import assert from 'node:assert/strict';
import test from 'node:test';
import {
  allocateOrder, confirmOrder, createCustomsDeclaration, createOrder, dispatchOrder, generateInvoice,
  invoiceOverdue, operationSummary, recordPayment, scanOverdueInvoices, state, updateCustoms,
  updateCustomerTimezone, type Invoice
} from './domain.js';

const TENANT = 'tenant-acme';

function provisionCustomer(timezone: string | undefined, idSuffix: string) {
  const customer = {
    id: `CUS-TZ-${idSuffix}`, tenantId: TENANT, name: `TZ Customer ${idSuffix}`,
    creditLimit: 1_000_000, creditUsed: 0, blocked: false, ...(timezone ? { timezone } : {})
  };
  state.customers.push(customer);
  return customer;
}

function provisionInvoice(customerId: string, dueDate: string) {
  const order = createOrder(TENANT, {
    customerId, reference: `TZ-PO-${customerId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    origin: '上海', destination: '海外仓',
    items: [{ sku: 'SENSOR-X9', description: '传感器', quantity: 1, unitPrice: 100, weightKg: 1, hsCode: '9025.19' }]
  });
  confirmOrder(TENANT, order.id, 'tz-tester');
  allocateOrder(TENANT, order.id, 'tz-tester');
  const declaration = createCustomsDeclaration(TENANT, { orderId: order.id });
  updateCustoms(TENANT, declaration.id, { documentRefs: declaration.requiredDocuments, status: 'submitted' }, 'tz-tester');
  updateCustoms(TENANT, declaration.id, { status: 'cleared' }, 'tz-tester');
  dispatchOrder(TENANT, order.id, 'tz-tester');
  return generateInvoice(TENANT, order.id, { dueDate }, 'tz-tester');
}

test('UTC 日界线：同一 UTC 瞬时按各客户当地日期判定，上海已逾期而洛杉矶尚未到期', () => {
  const shanghai = provisionCustomer('Asia/Shanghai', 'SH');
  const la = provisionCustomer('America/Los_Angeles', 'LA');
  const shInvoice = provisionInvoice(shanghai.id, '2026-03-15');
  const laInvoice = provisionInvoice(la.id, '2026-03-15');
  // 2026-03-15 18:00 UTC：上海是 03-16 02:00（已过账期），洛杉矶是 03-15 11:00（账期当天，不逾期）
  const asOf = new Date('2026-03-15T18:00:00.000Z');

  const shResult = invoiceOverdue(TENANT, shInvoice.id, asOf);
  assert.equal(shResult.overdue, true);
  assert.equal(shResult.evaluatedDate, '2026-03-16');
  assert.equal(shResult.dueDate, '2026-03-15');
  assert.equal(shResult.customerTimezone, 'Asia/Shanghai');

  const laResult = invoiceOverdue(TENANT, laInvoice.id, asOf);
  assert.equal(laResult.overdue, false);
  assert.equal(laResult.evaluatedDate, '2026-03-15');
  assert.equal(laResult.dueDate, '2026-03-15');
  assert.equal(laResult.customerTimezone, 'America/Los_Angeles');
});

test('dueDate 当天包含在宽限期内（默认 graceDays=0 当天不逾期，次日才逾期）', () => {
  const rotterdam = provisionCustomer('Europe/Amsterdam', 'RTM');
  const invoice = provisionInvoice(rotterdam.id, '2026-05-20');
  // 鹿特丹 05-20 22:00（UTC 20:00，当天最后两小时）：仍在账期当天
  assert.equal(invoiceOverdue(TENANT, invoice.id, new Date('2026-05-20T20:00:00.000Z')).overdue, false);
  // 鹿特丹 05-21 00:30（UTC 05-20 22:30）——若截 UTC 日期会误判为当天，实际已逾期
  const nextDay = invoiceOverdue(TENANT, invoice.id, new Date('2026-05-20T22:30:00.000Z'));
  assert.equal(nextDay.evaluatedDate, '2026-05-21');
  assert.equal(nextDay.overdue, true);
  // 宽限 2 天：05-22 仍在宽限内，05-23 逾期
  assert.equal(invoiceOverdue(TENANT, invoice.id, new Date('2026-05-22T12:00:00.000Z'), 2).overdue, false);
  const graceResult = invoiceOverdue(TENANT, invoice.id, new Date('2026-05-23T12:00:00.000Z'), 2);
  assert.equal(graceResult.graceUntilDate, '2026-05-22');
  assert.equal(graceResult.overdue, true);
});

test('夏令时跳变日：洛杉矶 23 小时春天与 25 小时秋天当地日期判定正确', () => {
  const la = provisionCustomer('America/Los_Angeles', 'DST');
  // 2026-03-08 是美国春令时跳变日（02:00 -> 03:00，当天只有 23 小时）。账期 03-08，
  // UTC 03-08 10:30 对应当地不存在的 02:30，ICU 归一化为 03:30 PDT，仍是 03-08 当天；
  // 跳变后洛杉矶为 UTC-7：UTC 03-09 06:59 仍是当地 03-08 23:59，07:00 起进入 03-09。
  const spring = provisionInvoice(la.id, '2026-03-08');
  assert.equal(invoiceOverdue(TENANT, spring.id, new Date('2026-03-08T10:30:00.000Z')).evaluatedDate, '2026-03-08');
  assert.equal(invoiceOverdue(TENANT, spring.id, new Date('2026-03-09T06:59:00.000Z')).overdue, false);
  assert.equal(invoiceOverdue(TENANT, spring.id, new Date('2026-03-09T07:00:00.000Z')).overdue, true);
  // 2026-11-01 回退日（25 小时）：UTC 11-02 08:00 才进入当地 11-02（00:00 PST），07:59 仍是当地 11-01 23:59。
  const fall = provisionInvoice(la.id, '2026-11-01');
  assert.equal(invoiceOverdue(TENANT, fall.id, new Date('2026-11-02T07:59:00.000Z')).overdue, false);
  assert.equal(invoiceOverdue(TENANT, fall.id, new Date('2026-11-02T08:00:00.000Z')).overdue, true);
});

test('闰日账期：2/29 与跨闰年推进均正确', () => {
  const singapore = provisionCustomer('Asia/Singapore', 'SG');
  const leap = provisionInvoice(singapore.id, '2024-02-29');
  assert.equal(invoiceOverdue(TENANT, leap.id, new Date('2024-02-29T15:59:00.000Z')).overdue, false); // 新加坡 23:59
  assert.equal(invoiceOverdue(TENANT, leap.id, new Date('2024-02-29T16:00:00.000Z')).overdue, true);  // 新加坡 03-01 00:00
  // 账期 2026-02-28（平年）宽限一天到 03-01，而非不存在的 02-29
  const nonLeap = provisionInvoice(singapore.id, '2026-02-28');
  const withGrace = invoiceOverdue(TENANT, nonLeap.id, new Date('2026-03-01T00:00:00.000Z'), 1);
  assert.equal(withGrace.graceUntilDate, '2026-03-01');
  assert.equal(withGrace.overdue, false);
});

test('无效时区：开票直接拒绝，历史无效数据在单查时报错、在批量扫描中降级为 error 条目', () => {
  const bad = provisionCustomer('Mars/Olympus', 'BAD');
  assert.throws(() => provisionInvoice(bad.id, '2026-03-01'), /IANA 时区无效/);

  const missing = provisionCustomer(undefined, 'MISSING');
  assert.throws(() => provisionInvoice(missing.id, '2026-03-01'), /未配置 IANA 时区/);

  // 手工构造一张时区无效的存量发票，模拟历史脏数据
  const invoiceId = 'INV-BADZONE';
  state.invoices.push({
    id: invoiceId, tenantId: TENANT, orderId: 'nonexistent-order', number: 'INV-BADZONE', status: 'issued',
    currency: 'USD', lines: [], subtotal: 0, tax: 0, total: 100, paid: 0,
    dueDate: '2026-03-01', timezone: 'Mars/Olympus', createdAt: '2026-02-01T00:00:00.000Z'
  });
  assert.throws(() => invoiceOverdue(TENANT, invoiceId, new Date('2026-03-10T00:00:00.000Z')), /时区无效/);
  const scan = scanOverdueInvoices(TENANT, { asOf: new Date('2026-03-10T00:00:00.000Z'), mark: false });
  const errorItem = scan.items.find(item => item.invoiceId === invoiceId);
  assert.ok(errorItem && 'error' in errorItem);
  assert.ok(scan.errors >= 1);
  state.invoices = state.invoices.filter(item => item.id !== invoiceId);
});

test('历史时区变更：发票快照保持开票时时区；无快照旧发票按变更历史回溯', () => {
  const customer = provisionCustomer('Asia/Shanghai', 'MOVE');
  const invoice = provisionInvoice(customer.id, '2026-03-15');
  // 客户临时把时区改到洛杉矶，已开发票仍按快照（上海）判定
  updateCustomerTimezone(TENANT, customer.id, 'America/Los_Angeles', 'ops');
  const asOf = new Date('2026-03-15T18:00:00.000Z');
  const result = invoiceOverdue(TENANT, invoice.id, asOf);
  assert.equal(result.customerTimezone, 'Asia/Shanghai');
  assert.equal(result.timezoneSource, 'timezone_snapshot');
  assert.equal(result.overdue, true);

  // 无快照的历史发票：去掉快照后，开票时间(2026-03)早于变更时间，应回溯到旧时区上海
  const stored = state.invoices.find(item => item.id === invoice.id)!;
  delete (stored as Partial<Invoice>).timezone;
  const historical = invoiceOverdue(TENANT, invoice.id, asOf);
  assert.equal(historical.customerTimezone, 'Asia/Shanghai');
  assert.equal(historical.timezoneSource, 'timezone_history');
  assert.equal(historical.overdue, true);

  // 无效时区的更新被拒绝
  assert.throws(() => updateCustomerTimezone(TENANT, customer.id, 'Not/AZone', 'ops'), /IANA 时区无效/);
});

test('批量扫描幂等：重复扫描不翻转状态、overdueSince 锁存且只写一次 audit', () => {
  const customer = provisionCustomer('Asia/Shanghai', 'SCAN');
  const invoice = provisionInvoice(customer.id, '2026-03-15');
  const asOf = new Date('2026-03-16T00:00:00.000Z');
  const auditsBefore = state.audit.filter(item => item.entityId === invoice.id && item.action === 'invoice.overdue.marked').length;

  const first = scanOverdueInvoices(TENANT, { asOf });
  const item1 = first.items.find(item => item.invoiceId === invoice.id)!;
  assert.ok('overdue' in item1 && item1.overdue);
  const stored1 = state.invoices.find(item => item.id === invoice.id)!;
  assert.equal(stored1.overdueSince, '2026-03-16T00:00:00.000Z');

  // 用更晚的时间重复扫描：结论不变、overdueSince 不移动、audit 不增加
  scanOverdueInvoices(TENANT, { asOf: new Date('2026-04-01T00:00:00.000Z') });
  const stored2 = state.invoices.find(item => item.id === invoice.id)!;
  assert.equal(stored2.overdueSince, '2026-03-16T00:00:00.000Z');
  const auditsAfter = state.audit.filter(item => item.entityId === invoice.id && item.action === 'invoice.overdue.marked').length;
  assert.equal(auditsAfter - auditsBefore, 1);

  // 单查与批量扫描口径一致
  assert.equal(invoiceOverdue(TENANT, invoice.id, asOf).overdue, true);
});

test('已支付/作废发票不会被判定或锁存为逾期', () => {
  const customer = provisionCustomer('Asia/Shanghai', 'PAID');
  const invoice = provisionInvoice(customer.id, '2026-01-01');
  recordPayment(TENANT, { invoiceId: invoice.id, amount: invoice.total, method: 'bank_transfer', reference: `PAY-TZ-${Date.now()}` }, 'tz-tester');
  const result = invoiceOverdue(TENANT, invoice.id, new Date('2026-06-01T00:00:00.000Z'));
  assert.equal(result.status, 'paid');
  assert.equal(result.overdue, false);
  const scan = scanOverdueInvoices(TENANT, { asOf: new Date('2026-06-01T00:00:00.000Z') });
  const stored = state.invoices.find(item => item.id === invoice.id)!;
  assert.equal(stored.overdueSince, undefined);
  const scanItem = scan.items.find(item => item.invoiceId === invoice.id)!;
  assert.ok('overdue' in scanItem && !scanItem.overdue);
});

test('运营 summary 的逾期指标与批量扫描、单查保持同一口径', () => {
  const customer = provisionCustomer('Asia/Shanghai', 'SUM');
  const invoice = provisionInvoice(customer.id, '2026-03-15');
  const asOf = new Date('2026-03-16T00:00:00.000Z');
  const summary = operationSummary(TENANT, asOf);
  const scan = scanOverdueInvoices(TENANT, { asOf });
  const single = invoiceOverdue(TENANT, invoice.id, asOf);
  const inScan = scan.items.filter(item => 'overdue' in item && item.overdue).length;
  assert.equal(summary.overdueInvoices, inScan);
  assert.equal(single.overdue, true);
  assert.ok(summary.overdueInvoices >= 1);
});

test('租户隔离：逾期查询与扫描不能触及其他租户的发票/客户', () => {
  state.tenants.push({ id: 'tenant-other', name: 'Other Co', creditLimit: 100000, creditUsed: 0, currency: 'USD' });
  const customer = provisionCustomer('Asia/Shanghai', 'T2');
  // 将该客户与发票改挂到另一租户，模拟越权访问目标
  const invoice = provisionInvoice(customer.id, '2026-03-15');
  const stored = state.invoices.find(item => item.id === invoice.id)!;
  const order = state.orders.find(item => item.id === stored.orderId)!;
  stored.tenantId = 'tenant-other';
  order.tenantId = 'tenant-other';
  customer.tenantId = 'tenant-other';

  assert.throws(() => invoiceOverdue(TENANT, invoice.id, new Date('2026-03-20T00:00:00.000Z')), /无权访问/);
  const scan = scanOverdueInvoices(TENANT, { asOf: new Date('2026-03-20T00:00:00.000Z') });
  assert.equal(scan.items.some(item => item.invoiceId === invoice.id), false);
});
