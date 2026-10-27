/**
 * lib/billing.ts
 * Pure billing functions — no I/O, no framework imports, no timezone dependency on the host.
 */

export type InvoiceKind = 'deposit' | 'rent'

export interface ScheduledInvoice {
  kind: InvoiceKind
  periodIndex: number | null  // 0, 1, 2... for rent; null for deposit
  periodStart: string | null  // 'YYYY-MM-DD'; null for deposit
  periodEnd: string | null    // 'YYYY-MM-DD', inclusive; null for deposit
  dueDate: string             // 'YYYY-MM-DD'
  amountSen: number           // integer
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a YYYY-MM-DD string and validate it is a real calendar date. */
function parseDate(s: string): { year: number; month: number; day: number } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid date format: "${s}". Expected YYYY-MM-DD.`)
  }
  const year = parseInt(s.slice(0, 4), 10)
  const month = parseInt(s.slice(5, 7), 10)
  const day = parseInt(s.slice(8, 10), 10)
  if (month < 1 || month > 12) throw new Error(`Invalid month in date: "${s}"`)
  const maxDay = daysInMonth(year, month)
  if (day < 1 || day > maxDay) throw new Error(`Invalid day in date: "${s}"`)
  return { year, month, day }
}

/** Number of days in a given month (1-indexed). */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month = last day of this month
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** Format { year, month, day } back to 'YYYY-MM-DD'. */
function formatDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

/** Compare two YYYY-MM-DD strings. Returns negative if a < b, 0 if equal, positive if a > b. */
function cmpDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Compute the anchor for period k from startDate.
 * Anchor 0 = startDate.
 * Anchor k = startDate + k calendar months, clamped to end of month if needed.
 */
function anchor(startYear: number, startMonth: number, startDay: number, k: number): string {
  const totalMonths = (startMonth - 1) + k
  const year = startYear + Math.floor(totalMonths / 12)
  const month = (totalMonths % 12) + 1
  const maxDay = daysInMonth(year, month)
  const day = Math.min(startDay, maxDay)
  return formatDate(year, month, day)
}

/** Prorate using integer arithmetic, rounding half-up to the nearest sen. */
function prorateHalfUp(amountSen: number, daysUsed: number, daysInFullPeriod: number): number {
  const numerator = BigInt(amountSen) * BigInt(daysUsed)
  const denominator = BigInt(daysInFullPeriod)
  return Number((numerator * 2n + denominator) / (denominator * 2n))
}

// ---------------------------------------------------------------------------
// generateSchedule
// ---------------------------------------------------------------------------

export function generateSchedule(lease: {
  startDate: string
  endDate: string
  monthlyRentSen: number
  depositSen: number
}): ScheduledInvoice[] {
  const { startDate, endDate, monthlyRentSen, depositSen } = lease

  // --- Validation ---
  const start = parseDate(startDate)
  parseDate(endDate)

  if (cmpDate(endDate, startDate) < 0) {
    throw new Error(`endDate "${endDate}" is before startDate "${startDate}".`)
  }
  if (!Number.isSafeInteger(monthlyRentSen) || monthlyRentSen <= 0) {
    throw new Error(`monthlyRentSen must be a positive integer; got ${monthlyRentSen}.`)
  }
  if (!Number.isSafeInteger(depositSen) || depositSen < 0) {
    throw new Error(`depositSen must be a non-negative integer; got ${depositSen}.`)
  }

  const invoices: ScheduledInvoice[] = []

  // --- Deposit ---
  if (depositSen > 0) {
    invoices.push({
      kind: 'deposit',
      periodIndex: null,
      periodStart: null,
      periodEnd: null,
      dueDate: startDate,
      amountSen: depositSen,
    })
  }

  // --- Rent periods ---
  // Period k runs from anchor(k) to day before anchor(k+1).
  // There is a period for every anchor on or before endDate.
  let k = 0
  while (true) {
    const periodStart = anchor(start.year, start.month, start.day, k)
    if (cmpDate(periodStart, endDate) > 0) break

    const periodEndFull = (() => {
      // The day before anchor(k+1)
      const next = anchor(start.year, start.month, start.day, k + 1)
      // Subtract one day from next
      const nextParsed = parseDate(next)
      // Use UTC Date arithmetic: next - 1 day
      const d = new Date(Date.UTC(nextParsed.year, nextParsed.month - 1, nextParsed.day))
      d.setUTCDate(d.getUTCDate() - 1)
      return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate())
    })()

    const periodEnd = cmpDate(periodEndFull, endDate) > 0 ? endDate : periodEndFull

    // Calculate amount
    let amountSen: number
    if (periodEnd === periodEndFull) {
      // Full period
      amountSen = monthlyRentSen
    } else {
      // Prorated: monthlyRentSen * daysUsed / daysInFullPeriod, rounded half-up
      const startParsed = parseDate(periodStart)
      const endParsed = parseDate(periodEnd)
      const fullEndParsed = parseDate(periodEndFull)

      const dStart = new Date(Date.UTC(startParsed.year, startParsed.month - 1, startParsed.day))
      const dEnd = new Date(Date.UTC(endParsed.year, endParsed.month - 1, endParsed.day))
      const dFullEnd = new Date(Date.UTC(fullEndParsed.year, fullEndParsed.month - 1, fullEndParsed.day))

      const daysUsed = Math.round((dEnd.getTime() - dStart.getTime()) / 86400000) + 1
      const daysInFullPeriod = Math.round((dFullEnd.getTime() - dStart.getTime()) / 86400000) + 1

      amountSen = prorateHalfUp(monthlyRentSen, daysUsed, daysInFullPeriod)
    }

    invoices.push({
      kind: 'rent',
      periodIndex: k,
      periodStart,
      periodEnd,
      dueDate: periodStart,
      amountSen,
    })

    k++
  }

  return invoices
}

// ---------------------------------------------------------------------------
// invoiceStatus
// ---------------------------------------------------------------------------

export type InvoiceStatus = 'paid' | 'partially_paid' | 'unpaid' | 'overdue'

export function invoiceStatus(
  invoice: { dueDate: string; amountSen: number; paidSen: number },
  now: Date,
): InvoiceStatus {
  const { dueDate, amountSen, paidSen } = invoice

  // 1. paid if paidSen >= amountSen
  if (paidSen >= amountSen) return 'paid'

  // 2. overdue if today's Malaysia date is AFTER dueDate
  // Malaysia is UTC+8. We need "today in MYT".
  // "After dueDate" means the calendar date in MYT > dueDate.
  const nowMytMs = now.getTime() + 8 * 3600 * 1000
  const nowMyt = new Date(nowMytMs)
  const todayMyt = formatDate(nowMyt.getUTCFullYear(), nowMyt.getUTCMonth() + 1, nowMyt.getUTCDate())
  if (cmpDate(todayMyt, dueDate) > 0) return 'overdue'

  // 3. partially_paid if paidSen > 0
  if (paidSen > 0) return 'partially_paid'

  // 4. unpaid
  return 'unpaid'
}

// ---------------------------------------------------------------------------
// parseRinggitToSen
// ---------------------------------------------------------------------------

export function parseRinggitToSen(input: string): number {
  // Trim whitespace around the value
  const trimmed = input.trim()

  // Must not be empty
  if (!trimmed) throw new Error(`Cannot parse empty string as ringgit amount.`)

  // Validate: digits with optional comma thousands separators and optional decimal part
  // Accepted: optional integer part (with commas), optional decimal part of 1-2 digits
  // No sign, no scientific notation, no currency symbols
  // Regex explanation:
  //   ^(\d{1,3}(,\d{3})*|\d+)  - integer part: either grouped with commas (groups of 3) or plain digits
  //   (\.\d{1,2})?$            - optional decimal of 1-2 digits
  // But "1,23" should fail (comma group not exactly 3 digits)
  // And "1.234" should fail (3 decimal digits)
  // And "" should fail
  // And "-5" should fail
  // And "1e3" should fail
  // And "RM 10" should fail

  // Check for any invalid characters first
  if (!/^[\d,\.]+$/.test(trimmed)) {
    throw new Error(`Invalid ringgit amount: "${input}"`)
  }

  // Check for negative sign (already handled above, but be explicit)
  if (trimmed.startsWith('-')) {
    throw new Error(`Negative amounts are not allowed: "${input}"`)
  }

  // Split into integer and decimal parts
  const dotParts = trimmed.split('.')
  if (dotParts.length > 2) {
    throw new Error(`Invalid ringgit amount (multiple dots): "${input}"`)
  }

  const integerPart = dotParts[0]
  const decimalPart = dotParts[1] ?? ''

  // Validate decimal part: 0, 1, or 2 digits only
  if (decimalPart.length > 2) {
    throw new Error(`Invalid ringgit amount (too many decimal places): "${input}"`)
  }
  if (decimalPart && !/^\d+$/.test(decimalPart)) {
    throw new Error(`Invalid ringgit amount: "${input}"`)
  }

  // Validate integer part with comma thousands separators
  if (!integerPart && decimalPart === '') {
    throw new Error(`Invalid ringgit amount: "${input}"`)
  }

  if (integerPart) {
    // Must match either plain digits OR comma-grouped digits
    // Plain digits: no commas
    // Comma-grouped: first group 1-3 digits, then each subsequent group exactly 3 digits
    if (integerPart.includes(',')) {
      // Must be: \d{1,3}(,\d{3})+
      if (!/^\d{1,3}(,\d{3})+$/.test(integerPart)) {
        throw new Error(`Invalid ringgit amount (bad comma grouping): "${input}"`)
      }
    } else {
      // Plain digits only
      if (!/^\d+$/.test(integerPart)) {
        throw new Error(`Invalid ringgit amount: "${input}"`)
      }
    }
  } else {
    // No integer part (e.g., ".5") - this seems reasonable but the spec says digits
    // The spec doesn't mention ".5" form - throw to be safe
    throw new Error(`Invalid ringgit amount: "${input}"`)
  }

  // Remove commas from integer part
  const integerClean = integerPart.replace(/,/g, '')

  const amountSen = BigInt(integerClean) * 100n + BigInt(decimalPart.padEnd(2, '0') || '0')
  if (amountSen > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Ringgit amount exceeds the safely representable limit: "${input}"`)
  }
  return Number(amountSen)
}
