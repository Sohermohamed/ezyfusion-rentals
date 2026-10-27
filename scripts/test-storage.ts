/**
 * scripts/test-storage.ts
 * Tests payment-slip Storage bucket access controls and signed URL behavior.
 * Uses the Supabase Storage HTTP API directly via fetch.
 */
import { config } from 'dotenv'
import { resolve } from 'path'
config({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!
// Storage REST API requires JWT format service role key, not sb_secret_ format
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_JWT!
const PASSWORD = 'Seed1234!'

let passed = 0; let failed = 0; const failures: string[] = []

function ok(name: string, cond: boolean, detail = '') {
  if (cond) { console.log(`  ✓ ${name}`); passed++ }
  else { console.error(`  ✗ FAIL: ${name}${detail ? ' — ' + detail : ''}`); failed++; failures.push(name) }
}

async function login(email: string): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'apikey': PUBLISHABLE_KEY },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!r.ok) throw new Error(`Login failed: ${email} ${r.status}`)
  return ((await r.json()) as { access_token: string }).access_token
}

/** Upload to storage via Supabase Storage REST API */
async function uploadSlip(token: string, path: string, content = 'test-slip-content'): Promise<number> {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/payment-slips/${path}`, {
    method: 'POST',
    headers: { 'apikey': PUBLISHABLE_KEY, 'Authorization': `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
    body: content,
  })
  return r.status
}

/** Download from storage (public/private access) */
async function downloadSlip(path: string, token?: string): Promise<number> {
  const headers: Record<string, string> = { 'apikey': PUBLISHABLE_KEY }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/payment-slips/${path}`, { headers })
  return r.status
}

/** Create signed URL via Supabase Storage REST API (service role) */
async function createSignedUrl(path: string, expiresIn = 60): Promise<{ url: string; status: number }> {
  const r = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/payment-slips/${path}`, {
    method: 'POST',
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  })
  const text = await r.text()
  if (!r.ok) return { url: '', status: r.status }
  try {
    const body = JSON.parse(text) as { signedURL?: string; signedUrl?: string }
    // Local Supabase returns a relative path like /object/sign/... (missing /storage/v1 prefix)
    const rel = body.signedURL ?? body.signedUrl ?? ''
    let url: string
    if (rel.startsWith('http')) {
      url = rel
    } else if (rel.startsWith('/object/')) {
      // Local Supabase omits /storage/v1 in the returned path
      url = `${SUPABASE_URL}/storage/v1${rel}`
    } else {
      url = `${SUPABASE_URL}${rel}`
    }
    return { url, status: r.status }
  } catch {
    return { url: '', status: r.status }
  }
}

/** Download using a signed URL */
async function downloadSigned(signedUrl: string): Promise<number> {
  const fullUrl = signedUrl.startsWith('http') ? signedUrl : `${SUPABASE_URL}${signedUrl}`
  const r = await fetch(fullUrl)
  return r.status
}

async function main() {
  console.log('\n=== Storage Bucket Access Control Tests ===\n')

  // ── Login ──────────────────────────────────────────────────────
  const [nwManager, nwStaff, aisyah, betaManager] = await Promise.all([
    login('manager@northwind.test'),
    login('staff@northwind.test'),
    login('aisyah@northwind.test'),
    login('manager@beta.test'),
  ])

  // ── Get org IDs via Data API ───────────────────────────────────
  const orgsRes = await fetch(`${SUPABASE_URL}/rest/v1/organizations?select=id,name`, {
    headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
  })
  const orgs = await orgsRes.json() as { id: string; name: string }[]
  const nwOrgId = orgs.find(o => o.name === 'Northwind Properties')?.id ?? ''
  const betaOrgId = orgs.find(o => o.name === 'Beta Realty')?.id ?? ''
  console.log(`Northwind org: ${nwOrgId}`)
  console.log(`Beta org: ${betaOrgId}`)

  if (!nwOrgId || !betaOrgId) {
    console.error('FATAL: Could not get org IDs'); process.exit(1)
  }

  const nwPath = `${nwOrgId}/test-slip-audit.jpg`
  const betaPath = `${betaOrgId}/test-slip-audit.jpg`

  // ── 1. Authorized upload (NW staff to NW folder) ───────────────
  console.log('\n--- 1. Upload access ---')
  {
    const s1 = await uploadSlip(nwStaff, nwPath)
    ok('NW staff can upload to NW org folder', s1 === 200, `got ${s1}`)

    const s2 = await uploadSlip(nwManager, `${nwOrgId}/test-manager-slip.jpg`)
    ok('NW manager can upload to NW org folder', s2 === 200, `got ${s2}`)

    // Staff from NW cannot upload to Beta's folder
    const s3 = await uploadSlip(nwStaff, betaPath)
    ok('NW staff cannot upload to Beta org folder', s3 !== 200, `got ${s3}`)

    // Beta manager cannot upload to NW folder
    const s4 = await uploadSlip(betaManager, nwPath)
    ok('Beta manager cannot upload to NW folder', s4 !== 200, `got ${s4}`)

    // Tenant cannot upload to any folder
    const s5 = await uploadSlip(aisyah, `${nwOrgId}/tenant-upload.jpg`)
    ok('Tenant cannot upload to payment-slips', s5 !== 200, `got ${s5}`)

    // Anon cannot upload
    const s6 = await uploadSlip('', nwPath)
    ok('Anon cannot upload to payment-slips', s6 !== 200, `got ${s6}`)
  }

  // ── 2. Direct download access (no signed URL) ──────────────────
  console.log('\n--- 2. Direct download access ---')
  {
    // NW manager can download own org slip
    const d1 = await downloadSlip(nwPath, nwManager)
    ok('NW manager can directly download own org slip', d1 === 200, `got ${d1}`)

    // NW staff can download own org slip
    const d2 = await downloadSlip(nwPath, nwStaff)
    ok('NW staff can directly download own org slip', d2 === 200, `got ${d2}`)

    // Beta manager cannot download NW slip
    const d3 = await downloadSlip(nwPath, betaManager)
    ok('Beta manager cannot directly download NW slip', d3 !== 200, `got ${d3}`)

    // Tenant cannot directly download slip
    const d4 = await downloadSlip(nwPath, aisyah)
    ok('Tenant cannot directly download slip', d4 !== 200, `got ${d4}`)

    // Anon cannot directly download slip (private bucket)
    const d5 = await downloadSlip(nwPath)
    ok('Anon cannot directly download slip (private bucket)', d5 !== 200, `got ${d5}`)

    // Attempt to download slip without org prefix (path traversal)
    const d6 = await downloadSlip('test-slip-audit.jpg', nwManager)
    ok('Cannot download slip without org prefix in path', d6 !== 200, `got ${d6}`)
  }

  // ── 3. Signed URL generation and download ─────────────────────
  console.log('\n--- 3. Signed URL generation and download ---')
  {
    // Service role creates signed URL (this is what the app does server-side)
    const { url, status } = await createSignedUrl(nwPath, 60)
    ok('Service role can create signed URL', status === 200 && url !== '', `status=${status} url=${url.slice(0,50)}`)

    if (url) {
      // Anyone with the signed URL can download (URL carries auth)
      const d1 = await downloadSigned(url)
      ok('Signed URL accessible without auth header', d1 === 200, `got ${d1}`)

      // Anon with signed URL can download (by design — URL is the credential)
      const r2 = await fetch(url.startsWith('http') ? url : `${SUPABASE_URL}${url}`)
      ok('Signed URL works for anonymous download (URL is credential)', r2.status === 200, `got ${r2.status}`)

      // Tampered signed URL (change 1 char) should fail
      const tamperedUrl = url.replace(/token=([^&]{5})/, (m, p) =>
        `token=${p.split('').reverse().join('')}`)
      if (tamperedUrl !== url) {
        const d3 = await downloadSigned(tamperedUrl)
        ok('Tampered signed URL is rejected', d3 !== 200, `got ${d3}`)
      } else {
        console.log('  SKIP: Could not produce distinct tampered URL')
      }

      // Signed URL for a different path should not work for nwPath
      const otherPath = `${nwOrgId}/nonexistent-other.jpg`
      const { url: url2 } = await createSignedUrl(otherPath, 60)
      if (url2) {
        const d4 = await downloadSigned(url2)
        // nonexistent file → 400 or 404, not 200
        ok('Signed URL for nonexistent file → non-200', d4 !== 200, `got ${d4}`)
      }
    } else {
      console.log('  SKIP signed URL download tests: no URL generated')
    }

    // Beta manager cannot create signed URL for NW slip via app (service role handles it)
    // The app uses service role for signed URLs — authorization is enforced BEFORE calling storage
    // This is tested in the app code: leases/[leaseId]/page.tsx checks org ownership first
    console.log('  (App-level signed URL auth: enforced by session.orgId check before storage call)')
  }

  // ── Cleanup ────────────────────────────────────────────────────
  console.log('\n--- Cleanup ---')
  {
    // Delete test files using service role
    for (const path of [nwPath, `${nwOrgId}/test-manager-slip.jpg`]) {
      const r = await fetch(`${SUPABASE_URL}/storage/v1/object/payment-slips/${path}`, {
        method: 'DELETE',
        headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
      })
      console.log(`  Deleted ${path}: ${r.status}`)
    }
  }

  // ── Summary ────────────────────────────────────────────────────
  console.log(`\n${'='.repeat(40)}`)
  console.log(`Storage tests: ${passed} passed, ${failed} failed`)
  if (failures.length) { failures.forEach(f => console.log(`  - ${f}`)) }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
