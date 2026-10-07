import { Effect, Schema } from "effect"
import { AuthorizationError, OAuthError, OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider"
import { getAgentByName } from "agents"
import { consentPage } from "./consent.ts"
import { LeeAgent, type LeeEnv } from "./lee-harness.ts"
import { ChatRequest, type WireMessage } from "./openai-wire.ts"

export { LeeAgent }

interface Env extends LeeEnv {
  readonly OAUTH_KV: KVNamespace
  readonly OAUTH_PROVIDER: OAuthHelpers
  readonly LeeAgent: DurableObjectNamespace<LeeAgent>
  readonly CF_OAUTH_CLIENT_ID: string
  readonly CF_OAUTH_CLIENT_SECRET: string
}

interface LeeProps {
  readonly userId: string
  readonly cloudflareToken: string
  readonly cloudflareRefreshToken: string
}

const PUBLIC_MODEL_ID = "cloudflare/lee"
const SCOPES = ["lee:read"]

const json = (body: unknown, status = 200) => Response.json(body, { status })

const textOf = (content: WireMessage["content"]) =>
  content === undefined || content === null ? "" : typeof content === "string" ? content : content.map((part) => part.text ?? "").join("")

const latestUserText = (messages: ReadonlyArray<WireMessage>) => textOf([...messages].reverse().find((m) => m.role === "user")?.content)

const sessionKey = (messages: ReadonlyArray<WireMessage>) =>
  Effect.promise(async () => {
    const first = textOf(messages.find((m) => m.role === "user")?.content)
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(first))
    return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("")
  })

const completion = (text: string) => ({
  id: `chatcmpl-${crypto.randomUUID()}`,
  object: "chat.completion",
  created: Math.floor(Date.now() / 1000),
  model: PUBLIC_MODEL_ID,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: text } }]
})

const answerChat = (request: Request, env: Env, props: LeeProps) =>
  Effect.gen(function* () {
    const body = yield* Effect.promise(() => request.json().catch(() => null))
    const chat = yield* Schema.decodeUnknownEffect(ChatRequest)(body)
    const session = yield* sessionKey(chat.messages)
    const agent = yield* Effect.promise(() => getAgentByName(env.LeeAgent, props.userId))
    yield* Effect.promise(() => agent.useCloudflareToken(props.cloudflareToken))
    if (chat.stream) {
      const events = yield* Effect.promise(() => agent.streamAnswer(session, latestUserText(chat.messages), PUBLIC_MODEL_ID))
      return new Response(events, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
    }
    const answer = yield* Effect.promise(() => agent.ask(session, latestUserText(chat.messages)))
    const text = answer.status === "done" ? answer.text : `Lee could not answer: ${answer.reason}`
    return json(completion(text))
  }).pipe(Effect.catchTag("SchemaError", () => Effect.succeed(json({ error: { message: "invalid chat completion request" } }, 400))))

const leeApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext<LeeProps>) {
    if (!request.headers.get("authorization") || !ctx.props?.userId) return json({ error: { message: "unauthorized" } }, 401)
    const { pathname } = new URL(request.url)
    if (request.method === "GET" && pathname === "/v1/models") {
      return json({ object: "list", data: [{ id: PUBLIC_MODEL_ID, object: "model", created: 0, owned_by: "cloudflare" }] })
    }
    if (request.method === "POST" && pathname === "/v1/chat/completions") return Effect.runPromise(answerChat(request, env, ctx.props))
    return json({ error: { message: "not found" } }, 404)
  }
}

const CLOUDFLARE_AUTHORIZE_URL = "https://dash.cloudflare.com/oauth2/auth"
const CLOUDFLARE_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token"
const CLOUDFLARE_SCOPES = "zone.read account-settings.read user-details.read offline_access"

interface CloudflareTokenResponse {
  readonly access_token?: string
  readonly refresh_token?: string
  readonly expires_in?: number
  readonly error?: string
}

const base64Url = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")

const pkceChallenge = async (verifier: string) => base64Url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))

const callbackUrl = (request: Request) => `${new URL(request.url).origin}/callback`

const cloudflareTokenRequest = (env: Env, body: Record<string, string>) =>
  fetch(CLOUDFLARE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${btoa(`${env.CF_OAUTH_CLIENT_ID}:${env.CF_OAUTH_CLIENT_SECRET}`)}`
    },
    body: new URLSearchParams(body)
  }).then(async (response) => ({ ok: response.ok, status: response.status, body: (await response.json().catch(() => ({}))) as CloudflareTokenResponse }))

const cloudflareUserId = async (accessToken: string) => {
  const response = await fetch("https://api.cloudflare.com/client/v4/user", { headers: { authorization: `Bearer ${accessToken}` } })
  const body = (await response.json().catch(() => ({}))) as { result?: { id?: string } }
  return body.result?.id
}

const authorizeErrorResponse = (error: unknown) => {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302)
  if (error instanceof AuthorizationError) return new Response(error.description, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } })
  throw error
}

const showConsent = async (request: Request, oauth: OAuthHelpers) => {
  const authRequest = await oauth.parseAuthRequest(request)
  const details = await oauth.describeConsent(authRequest)
  const consent = await oauth.beginConsent(authRequest)
  consent.headers.set("content-type", "text/html; charset=utf-8")
  return new Response(consentPage(details, consent.handle), { headers: consent.headers })
}

const redirectToCloudflare = async (request: Request, env: Env, oauth: OAuthHelpers) => {
  const form = await request.formData()
  const handle = String(form.get("handle"))
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle)
    return new Response(null, { status: 302, headers: denied.headers })
  }
  const approved = await oauth.approveConsent(request, handle, { scope: SCOPES })
  const verifier = crypto.randomUUID() + crypto.randomUUID()
  const { state, headers } = await oauth.beginUpstream(approved.request, { data: { verifier }, headers: approved.headers })
  const upstream = new URL(CLOUDFLARE_AUTHORIZE_URL)
  upstream.search = new URLSearchParams({
    response_type: "code",
    client_id: env.CF_OAUTH_CLIENT_ID,
    redirect_uri: callbackUrl(request),
    scope: CLOUDFLARE_SCOPES,
    state,
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256"
  }).toString()
  headers.set("location", upstream.toString())
  return new Response(null, { status: 302, headers })
}

const finishCloudflareSignIn = async (request: Request, env: Env, oauth: OAuthHelpers) => {
  const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(request)
  const params = new URL(request.url).searchParams
  const code = params.get("code")
  if (!code) return new Response(`Cloudflare sign-in did not finish: ${params.get("error") ?? "no code"}`, { status: 400 })
  const token = await cloudflareTokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: callbackUrl(request), code_verifier: data.verifier })
  if (!token.ok || !token.body.access_token) return new Response(`Cloudflare token exchange failed (${token.status} ${token.body.error ?? ""})`, { status: 502 })
  const cloudflareId = await cloudflareUserId(token.body.access_token)
  if (!cloudflareId) return new Response("Could not read your Cloudflare user.", { status: 502 })
  const userId = `cf-${cloudflareId}`
  const { redirectTo } = await oauth.completeAuthorization({
    request: original,
    userId,
    metadata: {},
    scope: original.scope,
    props: { userId, cloudflareToken: token.body.access_token, cloudflareRefreshToken: token.body.refresh_token ?? "" } satisfies LeeProps
  })
  headers.set("location", redirectTo)
  return new Response(null, { status: 302, headers })
}

const handleAuthorize = (request: Request, env: Env) => {
  const oauth = env.OAUTH_PROVIDER
  const { pathname } = new URL(request.url)
  if (pathname === "/callback") return finishCloudflareSignIn(request, env, oauth)
  if (pathname !== "/authorize") return Promise.resolve(new Response("Lee: an agent you can pick as a model. See github.com/acoyfellow/lee-model", { status: 200 }))
  if (request.method === "GET") return showConsent(request, oauth)
  return redirectToCloudflare(request, env, oauth)
}

const authorizePage = {
  fetch: (request: Request, env: Env) => handleAuthorize(request, env).catch(authorizeErrorResponse)
}

const refreshCloudflareGrant = async (env: Env, props: LeeProps) => {
  if (!props.cloudflareRefreshToken) throw new OAuthError("invalid_grant", { description: "Sign in with Cloudflare again" })
  const token = await cloudflareTokenRequest(env, { grant_type: "refresh_token", refresh_token: props.cloudflareRefreshToken })
  if (token.body.error === "invalid_grant") throw new OAuthError("invalid_grant", { description: "Cloudflare access was revoked" })
  if (!token.ok || !token.body.access_token) throw new OAuthError("temporarily_unavailable", { description: "Cloudflare is unavailable", statusCode: 503 })
  return {
    newProps: { ...props, cloudflareToken: token.body.access_token, cloudflareRefreshToken: token.body.refresh_token ?? props.cloudflareRefreshToken } satisfies LeeProps
  }
}

const LEE_ORIGIN = "https://lee.coey.dev"

export default new OAuthProvider<Env>({
  apiRoute: "/v1/",
  apiHandler: leeApi as never,
  defaultHandler: authorizePage as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: SCOPES,
  requiredScopes: SCOPES,
  accessTokenTTL: 3600,
  resourceMetadata: { resource: `${LEE_ORIGIN}/v1/`, authorization_servers: [LEE_ORIGIN] },
  tokenExchangeCallback: ({ grantType, props, env }) =>
    grantType === "refresh_token" ? refreshCloudflareGrant(env as Env, props as LeeProps) : undefined
})
