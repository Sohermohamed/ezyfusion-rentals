/**
 * lib/myt.ts
 * Malaysia Time (MYT = UTC+8) utilities.
 * These are pure functions that work regardless of the server's timezone.
 */

const MYT_OFFSET_MS = 8 * 60 * 60 * 1000 // UTC+8

/** Get the current date in Malaysia time as 'YYYY-MM-DD' */
export function todayMYT(now: Date = new Date()): string {
  const mytMs = now.getTime() + MYT_OFFSET_MS
  const d = new Date(mytMs)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth() + 1
  const day = d.getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** Get the current month in Malaysia time as 'YYYY-MM' */
export function thisMonthMYT(now: Date = new Date()): string {
  return todayMYT(now).slice(0, 7)
}

/**
 * Parse a date-time string in MYT and return a UTC Date.
 * Accepts ISO 8601 or 'YYYY-MM-DD HH:mm:ss' (treated as MYT).
 */
export function parseMYT(s: string): Date {
  // If it has an offset already, use it directly
  if (/[+-]\d{2}:?\d{2}$/.test(s) || s.endsWith('Z')) {
    return new Date(s)
  }
  // Treat as MYT (UTC+8)
  const normalized = s.replace(' ', 'T') + '+08:00'
  return new Date(normalized)
}

/**
 * Format a UTC Date as Malaysia time string 'YYYY-MM-DD HH:mm' for display.
 */
export function formatMYT(d: Date): string {
  const mytMs = d.getTime() + MYT_OFFSET_MS
  const myt = new Date(mytMs)
  const y = myt.getUTCFullYear()
  const mo = myt.getUTCMonth() + 1
  const day = myt.getUTCDate()
  const h = myt.getUTCHours()
  const mi = myt.getUTCMinutes()
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`
}

/**
 * Format a UTC Date as 'YYYY-MM-DD' in Malaysia time.
 */
export function formatDateMYT(d: Date): string {
  return formatMYT(d).slice(0, 10)
}

/**
 * Convert a 'YYYY-MM-DD' to the start-of-day in Malaysia time (as UTC Date).
 */
export function mytDateToUtc(date: string): Date {
  return new Date(date + 'T00:00:00+08:00')
}

/**
 * Returns the first day of the month for a 'YYYY-MM' string, as UTC Date (midnight MYT).
 */
export function monthStartMYT(ym: string): Date {
  return mytDateToUtc(ym + '-01')
}

/**
 * Returns the first day of the NEXT month, as UTC Date (midnight MYT).
 */
export function nextMonthStartMYT(ym: string): Date {
  const [y, m] = ym.split('-').map(Number)
  const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
  return mytDateToUtc(nextMonth + '-01')
}

/**
 * List all months (as 'YYYY-MM') from fromYM to toYM inclusive.
 */
export function monthRange(fromYM: string, toYM: string): string[] {
  const months: string[] = []
  let [y, m] = fromYM.split('-').map(Number)
  const [endY, endM] = toYM.split('-').map(Number)

  while (y < endY || (y === endY && m <= endM)) {
    months.push(`${y}-${String(m).padStart(2, '0')}`)
    m++
    if (m > 12) { m = 1; y++ }
  }
  return months
}
