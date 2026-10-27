/**
 * Quick check: can a tenant actually modify invoice data via Data API?
 */
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '.env.local') })

async function main() {
  const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!

  const loginRes = await fetch(`${URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': KEY },
    body: JSON.stringify({ email: 'aisyah@northwind.test', password: 'Seed1234!' }),
  })
  const { access_token } = await loginRes.json() as { access_token: string }

  const invoicesRes = await fetch(`${URL}/rest/v1/invoices?select=id,amount_sen&limit=1`, {
    headers: { 'apikey': KEY, 'Authorization': `Bearer ${access_token}` },
  })
  const invoices = await invoicesRes.json() as { id: string; amount_sen: string }[]
  console.log('Aisyah invoices via Data API:', JSON.stringify(invoices))

  if (invoices.length > 0) {
    const invId = invoices[0].id
    const origAmount = invoices[0].amount_sen

    const patchRes = await fetch(`${URL}/rest/v1/invoices?id=eq.${invId}`, {
      method: 'PATCH',
      headers: {
        'apikey': KEY, 'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json', 'Prefer': 'return=representation',
      },
      body: JSON.stringify({ amount_sen: 1 }),
    })
    console.log('PATCH status:', patchRes.status)
    const patchBody = await patchRes.text()
    console.log('PATCH body:', patchBody)

    // Verify no actual change
    const checkRes = await fetch(`${URL}/rest/v1/invoices?id=eq.${invId}&select=amount_sen`, {
      headers: { 'apikey': KEY, 'Authorization': `Bearer ${access_token}` },
    })
    const check = await checkRes.json() as { amount_sen: string }[]
    console.log('Amount after PATCH:', check[0]?.amount_sen, '(original:', origAmount + ')')
    const changed = String(check[0]?.amount_sen) !== String(origAmount)
    console.log(changed ? '❌ REAL DATA WAS CHANGED — RLS BYPASS!' : '✓ Data unchanged (RLS protected or no update grant)')
  }
}

main().catch(e => { console.error(e); process.exit(1) })
