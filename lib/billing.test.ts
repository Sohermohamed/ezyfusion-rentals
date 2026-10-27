/**
 * Billing tests - run with: npx tsx lib/billing.test.ts
 */
import { generateSchedule, invoiceStatus, parseRinggitToSen } from './billing'

let passed = 0
let failed = 0

function assert(condition: boolean, name: string, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`)
    passed++
  } else {
    console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`)
    failed++
  }
}

function assertThrows(fn: () => unknown, name: string) {
  try {
    fn()
    console.error(`  ✗ ${name}: expected to throw`)
    failed++
  } catch {
    console.log(`  ✓ ${name}`)
    passed++
  }
}

function assertEq<T>(actual: T, expected: T, name: string) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  assert(a === e, name, a !== e ? `got ${a}, want ${e}` : undefined)
}

// ============================================================
// generateSchedule tests
// ============================================================

console.log('\n=== generateSchedule ===')

// Aisyah's lease: 2026-01-31 to 2026-07-15, rent 150000 sen, deposit 300000 sen
{
  const aisyah = generateSchedule({
    startDate: '2026-01-31',
    endDate: '2026-07-15',
    monthlyRentSen: 150000,
    depositSen: 300000,
  })
  assert(aisyah.length === 7, 'Aisyah: 7 invoices total')
  assertEq(aisyah[0], {
    kind: 'deposit', periodIndex: null, periodStart: null, periodEnd: null,
    dueDate: '2026-01-31', amountSen: 300000
  }, 'Aisyah: deposit')
  assertEq(aisyah[1], {
    kind: 'rent', periodIndex: 0, periodStart: '2026-01-31', periodEnd: '2026-02-27',
    dueDate: '2026-01-31', amountSen: 150000
  }, 'Aisyah: period 0')
  assertEq(aisyah[2], {
    kind: 'rent', periodIndex: 1, periodStart: '2026-02-28', periodEnd: '2026-03-30',
    dueDate: '2026-02-28', amountSen: 150000
  }, 'Aisyah: period 1')
  assertEq(aisyah[3], {
    kind: 'rent', periodIndex: 2, periodStart: '2026-03-31', periodEnd: '2026-04-29',
    dueDate: '2026-03-31', amountSen: 150000
  }, 'Aisyah: period 2')
  assertEq(aisyah[4], {
    kind: 'rent', periodIndex: 3, periodStart: '2026-04-30', periodEnd: '2026-05-30',
    dueDate: '2026-04-30', amountSen: 150000
  }, 'Aisyah: period 3')
  assertEq(aisyah[5], {
    kind: 'rent', periodIndex: 4, periodStart: '2026-05-31', periodEnd: '2026-06-29',
    dueDate: '2026-05-31', amountSen: 150000
  }, 'Aisyah: period 4')
  // Period 5: 2026-06-30 to 2026-07-15 (cut at endDate)
  // Full period would be 2026-06-30 to 2026-07-30 (31 days)
  // Used: 2026-06-30 to 2026-07-15 = 16 days
  // 150000 * 16 / 31 = 77419.35... -> 77419 (round half up)
  // Wait: 77419.35 rounds to 77419? round half up: floor(77419.35 + 0.5) = floor(77419.85) = 77419
  assertEq(aisyah[6], {
    kind: 'rent', periodIndex: 5, periodStart: '2026-06-30', periodEnd: '2026-07-15',
    dueDate: '2026-06-30', amountSen: 77419
  }, 'Aisyah: period 5 (prorated)')
}

// Ben's lease: 2026-01-01 to 2026-04-15, rent 100029 sen, no deposit
{
  const ben = generateSchedule({
    startDate: '2026-01-01',
    endDate: '2026-04-15',
    monthlyRentSen: 100029,
    depositSen: 0,
  })
  assert(ben.length === 4, 'Ben: 4 rent invoices, no deposit')
  assertEq(ben[0], {
    kind: 'rent', periodIndex: 0, periodStart: '2026-01-01', periodEnd: '2026-01-31',
    dueDate: '2026-01-01', amountSen: 100029
  }, 'Ben: period 0')
  assertEq(ben[1], {
    kind: 'rent', periodIndex: 1, periodStart: '2026-02-01', periodEnd: '2026-02-28',
    dueDate: '2026-02-01', amountSen: 100029
  }, 'Ben: period 1')
  assertEq(ben[2], {
    kind: 'rent', periodIndex: 2, periodStart: '2026-03-01', periodEnd: '2026-03-31',
    dueDate: '2026-03-01', amountSen: 100029
  }, 'Ben: period 2')
  // Period 3: 2026-04-01 to 2026-04-15 (cut at endDate)
  // Full period: 2026-04-01 to 2026-04-30 (30 days)
  // Used: 15 days
  // 100029 * 15 / 30 = 50014.5 -> 50015 (round half up)
  assertEq(ben[3], {
    kind: 'rent', periodIndex: 3, periodStart: '2026-04-01', periodEnd: '2026-04-15',
    dueDate: '2026-04-01', amountSen: 50015
  }, 'Ben: period 3 (prorated)')
}

// Probe's lease: 2026-02-28 to 2027-02-27, rent 200000 sen, deposit 400000 sen
{
  const probe = generateSchedule({
    startDate: '2026-02-28',
    endDate: '2027-02-27',
    monthlyRentSen: 200000,
    depositSen: 400000,
  })
  // Deposit + 12 rent periods
  assert(probe.length === 13, 'Probe: 13 invoices (deposit + 12 rent)')
  assertEq(probe[0].kind, 'deposit', 'Probe: first is deposit')
  // anchor(0) = 2026-02-28
  // anchor(1) = 2026-03-28 (Feb+1=Mar, day 28)
  // anchor(12) = 2027-02-28, but 2027-02-28 doesn't exceed endDate 2027-02-27?
  // Wait: anchor(11) = Jan 28, 2027 - that's on or before 2027-02-27. 
  // period 11 ends at day before anchor(12) = day before 2027-02-28 = 2027-02-27 = endDate. Full period!
  assertEq(probe[12].amountSen, 200000, 'Probe: last period is full (not prorated)')
  assertEq(probe[12].periodEnd, '2027-02-27', 'Probe: last period ends on endDate')
}

// Leap year test: Jan 31 lease, check Feb anchor in leap year
{
  const leapTest = generateSchedule({
    startDate: '2024-01-31',
    endDate: '2024-03-31',
    monthlyRentSen: 100000,
    depositSen: 0,
  })
  assert(leapTest.length === 3, 'Leap year: 3 periods')
  assertEq(leapTest[1].periodStart, '2024-02-29', 'Leap year: Feb anchor is Feb 29')
  assertEq(leapTest[2].periodStart, '2024-03-31', 'Leap year: Mar anchor is Mar 31')
}

// Non-leap year test: Jan 31 lease
{
  const nonLeap = generateSchedule({
    startDate: '2025-01-31',
    endDate: '2025-03-31',
    monthlyRentSen: 100000,
    depositSen: 0,
  })
  assertEq(nonLeap[1].periodStart, '2025-02-28', 'Non-leap: Feb anchor is Feb 28')
}

// Validation tests
assertThrows(() => generateSchedule({ startDate: 'bad', endDate: '2026-01-31', monthlyRentSen: 100, depositSen: 0 }), 'Throws on bad startDate')
assertThrows(() => generateSchedule({ startDate: '2026-01-31', endDate: '2026-01-30', monthlyRentSen: 100, depositSen: 0 }), 'Throws when endDate < startDate')
assertThrows(() => generateSchedule({ startDate: '2026-01-31', endDate: '2026-01-31', monthlyRentSen: 0, depositSen: 0 }), 'Throws when monthlyRentSen = 0')
assertThrows(() => generateSchedule({ startDate: '2026-01-31', endDate: '2026-01-31', monthlyRentSen: -1, depositSen: 0 }), 'Throws when monthlyRentSen < 0')
assertThrows(() => generateSchedule({ startDate: '2026-01-31', endDate: '2026-01-31', monthlyRentSen: 1.5, depositSen: 0 }), 'Throws when monthlyRentSen is not integer')
assertThrows(() => generateSchedule({ startDate: '2026-01-31', endDate: '2026-01-31', monthlyRentSen: 100, depositSen: -1 }), 'Throws when depositSen < 0')
assertThrows(() => generateSchedule({ startDate: '2026-02-30', endDate: '2026-03-31', monthlyRentSen: 100, depositSen: 0 }), 'Throws on invalid date Feb 30')

// Single-day lease (startDate === endDate)
{
  const single = generateSchedule({ startDate: '2026-03-15', endDate: '2026-03-15', monthlyRentSen: 100000, depositSen: 0 })
  assert(single.length === 1, 'Single day: 1 period')
  // Period 0: 2026-03-15 to 2026-03-15, full period would be 2026-03-15 to 2026-04-14 (31 days), used 1 day
  // 100000 * 1 / 31 = 3225.8... -> 3226
  assertEq(single[0].amountSen, 3226, 'Single day: prorated correctly')
}

{
  const maxSen = Number.MAX_SAFE_INTEGER
  const schedule = generateSchedule({
    startDate: '2026-01-31',
    endDate: '2026-02-01',
    monthlyRentSen: maxSen,
    depositSen: 0,
  })
  const expected = Number((BigInt(maxSen) * 2n * 2n + 28n) / 56n)
  assertEq(schedule[0].amountSen, expected, 'Large prorated rent uses exact integer rounding')
  assertThrows(
    () => generateSchedule({ startDate: '2026-01-01', endDate: '2026-01-01', monthlyRentSen: maxSen + 1, depositSen: 0 }),
    'Unsafe monthly rent is rejected',
  )
  assertThrows(
    () => generateSchedule({ startDate: '2026-01-01', endDate: '2026-01-01', monthlyRentSen: 1, depositSen: maxSen + 1 }),
    'Unsafe deposit is rejected',
  )
}

// ============================================================
// invoiceStatus tests
// ============================================================

console.log('\n=== invoiceStatus ===')

// Due 2026-03-01. Becomes overdue at 2026-03-02 00:00 MYT = 2026-03-01T16:00:00Z
const dueDate = '2026-03-01'

// At 2026-03-01T15:59:59Z (just before midnight MYT) = still 2026-03-01 in MYT
{
  const now = new Date('2026-03-01T15:59:59Z')
  assertEq(invoiceStatus({ dueDate, amountSen: 1000, paidSen: 0 }, now), 'unpaid', 'Not overdue at 23:59:59 MYT on due date')
}
// At 2026-03-01T16:00:00Z = 2026-03-02 00:00 MYT -> overdue
{
  const now = new Date('2026-03-01T16:00:00Z')
  assertEq(invoiceStatus({ dueDate, amountSen: 1000, paidSen: 0 }, now), 'overdue', 'Overdue at midnight MYT the day after')
}
// At 2026-03-01T15:00:00Z = 2026-03-01 23:00 MYT -> not overdue
{
  const now = new Date('2026-03-01T15:00:00Z')
  assertEq(invoiceStatus({ dueDate, amountSen: 1000, paidSen: 0 }, now), 'unpaid', 'Not overdue at 23:00 MYT on due date')
}
// paid
{
  const now = new Date('2026-03-01T16:00:00Z')
  assertEq(invoiceStatus({ dueDate, amountSen: 1000, paidSen: 1000 }, now), 'paid', 'Paid when paidSen == amountSen')
  assertEq(invoiceStatus({ dueDate, amountSen: 1000, paidSen: 1001 }, now), 'paid', 'Paid when paidSen > amountSen')
}
// partially_paid (not overdue)
{
  const now = new Date('2026-03-01T15:59:59Z') // on due date MYT
  assertEq(invoiceStatus({ dueDate, amountSen: 1000, paidSen: 500 }, now), 'partially_paid', 'Partially paid, not overdue')
}
// partially_paid overdue takes precedence over partially_paid? No: spec says paid > overdue > partially_paid
{
  const now = new Date('2026-03-02T16:00:00Z') // well past
  assertEq(invoiceStatus({ dueDate, amountSen: 1000, paidSen: 500 }, now), 'overdue', 'overdue beats partially_paid')
}

// ============================================================
// parseRinggitToSen tests
// ============================================================

console.log('\n=== parseRinggitToSen ===')

assertEq(parseRinggitToSen('1,500.50'), 150050, '"1,500.50" -> 150050')
assertEq(parseRinggitToSen('1.15'), 115, '"1.15" -> 115')
assertEq(parseRinggitToSen('7'), 700, '"7" -> 700')
assertEq(parseRinggitToSen('  7  '), 700, 'whitespace trimmed')
assertEq(parseRinggitToSen('1000'), 100000, '"1000" -> 100000')
assertEq(parseRinggitToSen('1,000'), 100000, '"1,000" -> 100000')
assertEq(parseRinggitToSen('1,000,000'), 100000000, '"1,000,000" -> 100000000')
assertEq(parseRinggitToSen('0'), 0, '"0" -> 0')
assertEq(parseRinggitToSen('0.50'), 50, '"0.50" -> 50')
assertEq(parseRinggitToSen('1.5'), 150, '"1.5" -> 150')
assertEq(parseRinggitToSen('90,071,992,547,409.91'), Number.MAX_SAFE_INTEGER, 'Maximum safe sen is exact')

assertThrows(() => parseRinggitToSen(''), 'Empty string throws')
assertThrows(() => parseRinggitToSen('-5'), 'Negative throws')
assertThrows(() => parseRinggitToSen('1.234'), '"1.234" throws (3 decimals)')
assertThrows(() => parseRinggitToSen('1e3'), '"1e3" throws')
assertThrows(() => parseRinggitToSen('RM 10'), '"RM 10" throws')
assertThrows(() => parseRinggitToSen('1,23'), '"1,23" throws (bad comma grouping)')
assertThrows(() => parseRinggitToSen('1,2345'), '"1,2345" throws (bad comma grouping)')
assertThrows(() => parseRinggitToSen('1..5'), '"1..5" throws')
assertThrows(() => parseRinggitToSen(',123'), '",123" throws')
assertThrows(() => parseRinggitToSen('90,071,992,547,409.92'), 'Unsafe sen amount throws')

// ============================================================
// Summary
// ============================================================

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`)
if (failed > 0) process.exit(1)
