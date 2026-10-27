/**
 * gateway-sim.mjs
 * Simulates the payment gateway callback (webhook) for local development and testing.
 *
 * Usage:
 *   node gateway-sim.mjs <bill_id> [paid=true] [paid_amount=<sen>]
 *
 * Environment variables:
 *   GATEWAY_X_SIGNATURE_KEY  — shared HMAC-SHA256 key (same as in .env.local)
 *   WEBHOOK_URL              — full URL of the webhook endpoint
 *                              default: http://localhost:3000/api/webhooks/gateway
 *
 * Examples:
 *   # Simulate a successful payment of RM 2000 for bill_abc123
 *   GATEWAY_X_SIGNATURE_KEY=test_x_signature_key_local_dev \
 *     node gateway-sim.mjs bill_abc123 true 200000
 *
 *   # Simulate a failed payment
 *   GATEWAY_X_SIGNATURE_KEY=test_x_signature_key_local_dev \
 *     node gateway-sim.mjs bill_abc123 false 0
 */

import { createHmac } from 'crypto'

const key = process.env.GATEWAY_X_SIGNATURE_KEY
if (!key) {
  console.error('Error: GATEWAY_X_SIGNATURE_KEY environment variable is required')
  process.exit(1)
}

const webhookUrl = process.env.WEBHOOK_URL ?? 'http://localhost:3000/api/webhooks/gateway'

const [, , billId, paidArg = 'true', paidAmountArg] = process.argv

if (!billId) {
  console.error('Usage: node gateway-sim.mjs <bill_id> [paid=true] [paid_amount_sen]')
  process.exit(1)
}

const paid = paidArg === 'true' ? 'true' : 'false'

// paid_at in the format the webhook expects: 'YYYY-MM-DD HH:mm:ss +0800'
const now = new Date()
const myt = new Date(now.getTime() + 8 * 3600 * 1000)
const pad = (n) => String(n).padStart(2, '0')
const paidAt = `${myt.getUTCFullYear()}-${pad(myt.getUTCMonth() + 1)}-${pad(myt.getUTCDate())} ` +
  `${pad(myt.getUTCHours())}:${pad(myt.getUTCMinutes())}:${pad(myt.getUTCSeconds())} +0800`

/** Build field map (all values are strings, as a real gateway would send) */
const fields = {
  id: billId,
  paid,
  paid_at: paidAt,
}

if (paidAmountArg !== undefined) {
  fields.paid_amount = paidAmountArg
}

/** Compute HMAC-SHA256 signature over sorted fields (excluding x_signature itself) */
function sign(fields, key) {
  const source = Object.keys(fields)
    .filter((k) => k !== 'x_signature')
    .sort()
    .map((k) => `${k}${fields[k]}`)
    .join('|')
  return createHmac('sha256', key).update(source).digest('hex')
}

fields.x_signature = sign(fields, key)

/** Post as application/x-www-form-urlencoded (real gateway sends form data) */
const body = new URLSearchParams(fields).toString()

console.log(`Sending webhook to ${webhookUrl}`)
console.log('Fields:', { ...fields, x_signature: '[redacted]' })

try {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  console.log(`Response: HTTP ${res.status}`)
  console.log(text)
  if (res.ok) {
    console.log('✅ Webhook delivered successfully')
  } else {
    console.error('❌ Webhook returned an error')
    process.exit(1)
  }
} catch (err) {
  console.error('❌ Failed to connect to webhook URL:', err.message)
  console.error('Is the Next.js server running? (npm start or npm run dev)')
  process.exit(1)
}
