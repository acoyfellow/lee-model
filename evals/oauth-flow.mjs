import { createHash, randomBytes } from "node:crypto"

const base = process.env.LEE_URL ?? "https://localhost:8799"
const cloudflareToken = process.env.LEE_CONSENT_CLOUDFLARE_TOKEN
if (!cloudflareToken) throw new Error("set LEE_CONSENT_CLOUDFLARE_TOKEN")

const b64url = (buf) => buf.toString("base64url")
const redirectUri = "http://127.0.0.1:53682/callback"

const registration = await (await fetch(`${base}/oauth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ client_name: "lee-proof", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" })
})).json()

const verifier = b64url(randomBytes(32))
const challenge = b64url(createHash("sha256").update(verifier).digest())
const state = b64url(randomBytes(12))
const authorizeUrl = new URL(`${base}/authorize`)
for (const [k, v] of Object.entries({ response_type: "code", client_id: registration.client_id, redirect_uri: redirectUri, scope: "lee:read", state, code_challenge: challenge, code_challenge_method: "S256", resource: `${base}/v1/` })) authorizeUrl.searchParams.set(k, v)

const page = await fetch(authorizeUrl)
const cookie = (page.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ")
const html = await page.text()
const handle = html.match(/name="handle" value="([^"]+)"/)?.[1]
if (!handle) throw new Error(`no consent handle: ${page.status} ${html.slice(0, 200)}`)

const consent = await fetch(authorizeUrl, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded", cookie, origin: base },
  body: new URLSearchParams({ handle, decision: "approve", cloudflare_token: cloudflareToken })
})
const location = new URL(consent.headers.get("location") ?? "about:blank")
const code = location.searchParams.get("code")
if (!code || location.searchParams.get("state") !== state) throw new Error(`consent failed: ${consent.status} ${await consent.text()}`)

const token = await (await fetch(`${base}/oauth/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: registration.client_id, code_verifier: verifier, resource: `${base}/v1/` })
})).json()
if (!token.access_token) throw new Error(`token exchange failed: ${JSON.stringify(token)}`)
process.stdout.write(JSON.stringify({ client_id: registration.client_id, access_token: token.access_token, refresh_token: token.refresh_token, expires_in: token.expires_in, scope: token.scope }))
