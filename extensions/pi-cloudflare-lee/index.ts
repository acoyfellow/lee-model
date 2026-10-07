import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const LEE_URL = process.env.LEE_URL ?? "https://localhost:8799"
const CALLBACK_PORT = 53682
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`
const SCOPE = "lee:read"
const RESOURCE = `${LEE_URL}/v1/`
const EXPIRY_MARGIN_MS = 60_000

interface TokenResponse {
  readonly access_token: string
  readonly refresh_token?: string
  readonly expires_in: number
}

interface LeeCredentials {
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly clientId: string
}

const base64Url = (buffer: Buffer) => buffer.toString("base64url")

const registerClient = async (): Promise<string> => {
  const response = await fetch(`${LEE_URL}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "pi", redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] })
  })
  if (!response.ok) throw new Error(`Lee client registration failed: ${response.status}`)
  return ((await response.json()) as { client_id: string }).client_id
}

const waitForCode = (expectedState: string, signal: AbortSignal | undefined) =>
  new Promise<string>((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", REDIRECT_URI)
      if (url.pathname !== "/callback") return void response.writeHead(404).end()
      const code = url.searchParams.get("code")
      const ok = code !== null && url.searchParams.get("state") === expectedState
      response.writeHead(ok ? 200 : 400, { "content-type": "text/plain; charset=utf-8" }).end(ok ? "Signed in to Lee. You can close this tab." : "Lee sign-in failed.")
      server.close()
      ok ? resolve(code) : reject(new Error(url.searchParams.get("error") ?? "Lee sign-in was not completed"))
    })
    signal?.addEventListener("abort", () => {
      server.close()
      reject(new Error("Lee sign-in cancelled"))
    })
    server.listen(CALLBACK_PORT, "127.0.0.1")
  })

const exchange = async (body: Record<string, string>): Promise<TokenResponse> => {
  const response = await fetch(`${LEE_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...body, resource: RESOURCE })
  })
  if (!response.ok) throw new Error(`Lee token request failed: ${response.status}`)
  return (await response.json()) as TokenResponse
}

const toCredentials = (token: TokenResponse, clientId: string, previousRefresh = ""): LeeCredentials => ({
  access: token.access_token,
  refresh: token.refresh_token ?? previousRefresh,
  expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
  clientId
})

export default function cloudflareLee(pi: ExtensionAPI) {
  pi.registerProvider("cloudflare-lee", {
    baseUrl: `${LEE_URL}/v1`,
    api: "openai-completions",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" },
    models: [
      {
        id: "cloudflare/lee",
        name: "Lee (Cloudflare)",
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ],
    oauth: {
      name: "Cloudflare Lee",
      async login(callbacks) {
        const clientId = await registerClient()
        const verifier = base64Url(randomBytes(32))
        const state = base64Url(randomBytes(16))
        const authorize = new URL(`${LEE_URL}/authorize`)
        const params = {
          response_type: "code",
          client_id: clientId,
          redirect_uri: REDIRECT_URI,
          scope: SCOPE,
          state,
          resource: RESOURCE,
          code_challenge: base64Url(createHash("sha256").update(verifier).digest()),
          code_challenge_method: "S256"
        }
        for (const [key, value] of Object.entries(params)) authorize.searchParams.set(key, value)
        const code = waitForCode(state, callbacks.signal)
        callbacks.onAuth({ url: authorize.toString() })
        const token = await exchange({ grant_type: "authorization_code", code: await code, redirect_uri: REDIRECT_URI, client_id: clientId, code_verifier: verifier })
        return toCredentials(token, clientId)
      },
      async refreshToken(credentials) {
        const current = credentials as unknown as LeeCredentials
        const token = await exchange({ grant_type: "refresh_token", refresh_token: current.refresh, client_id: current.clientId })
        return toCredentials(token, current.clientId, current.refresh) as never
      },
      getApiKey: (credentials) => (credentials as unknown as LeeCredentials).access
    }
  })
}
