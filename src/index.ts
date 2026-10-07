import { Effect, Schema } from "effect"
import { AuthorizationError, OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider"
import { getAgentByName } from "agents"
import { consentPage } from "./consent.ts"
import { LeeAgent, type LeeEnv } from "./lee-harness.ts"
import { ChatRequest, type WireMessage } from "./openai-wire.ts"

export { LeeAgent }

interface Env extends LeeEnv {
  readonly OAUTH_KV: KVNamespace
  readonly OAUTH_PROVIDER: OAuthHelpers
  readonly LeeAgent: DurableObjectNamespace<LeeAgent>
}

interface LeeProps {
  readonly userId: string
  readonly cloudflareToken: string
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

const streamOf = (text: string) => {
  const id = `chatcmpl-${crypto.randomUUID()}`
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: PUBLIC_MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  const body = chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n"
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

const answerChat = (request: Request, env: Env, props: LeeProps) =>
  Effect.gen(function* () {
    const body = yield* Effect.promise(() => request.json().catch(() => null))
    const chat = yield* Schema.decodeUnknownEffect(ChatRequest)(body)
    const session = yield* sessionKey(chat.messages)
    const agent = yield* Effect.promise(() => getAgentByName(env.LeeAgent, props.userId))
    yield* Effect.promise(() => agent.setCloudflareToken(props.cloudflareToken))
    const answer = yield* Effect.promise(() => agent.ask(session, latestUserText(chat.messages)))
    const text = answer.status === "done" ? answer.text : `Lee could not answer: ${answer.reason}`
    return chat.stream ? streamOf(text) : json(completion(text))
  }).pipe(Effect.catchTag("SchemaError", () => Effect.succeed(json({ error: { message: "invalid chat completion request" } }, 400))))

const leeApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext<LeeProps>) {
    const { pathname } = new URL(request.url)
    if (request.method === "GET" && pathname === "/v1/models") {
      return json({ object: "list", data: [{ id: PUBLIC_MODEL_ID, object: "model", created: 0, owned_by: "cloudflare" }] })
    }
    if (request.method === "POST" && pathname === "/v1/chat/completions") return Effect.runPromise(answerChat(request, env, ctx.props))
    return json({ error: { message: "not found" } }, 404)
  }
}

const verifyCloudflareToken = async (token: string) => {
  const response = await fetch("https://api.cloudflare.com/client/v4/zones?per_page=1", { headers: { authorization: `Bearer ${token}` } })
  if (!response.ok) return undefined
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("")
}

const authorizeErrorResponse = (error: unknown) => {
  if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302)
  if (error instanceof AuthorizationError) return new Response(error.description, { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } })
  throw error
}

const authorizePage = {
  fetch: (request: Request, env: Env) => handleAuthorize(request, env).catch(authorizeErrorResponse)
}

const handleAuthorize = async (request: Request, env: Env) => {
  {
    const oauth = env.OAUTH_PROVIDER
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request)
      const details = await oauth.describeConsent(authRequest)
      const consent = await oauth.beginConsent(authRequest)
      consent.headers.set("content-type", "text/html; charset=utf-8")
      return new Response(consentPage(details, consent.handle), { headers: consent.headers })
    }
    const form = await request.formData()
    const handle = String(form.get("handle"))
    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle)
      return new Response(null, { status: 302, headers: denied.headers })
    }
    const cloudflareToken = String(form.get("cloudflare_token") ?? "").trim()
    const tokenId = await verifyCloudflareToken(cloudflareToken)
    if (!tokenId) return new Response("That Cloudflare API token was rejected. Go back and try again.", { status: 400 })
    const approved = await oauth.approveConsent(request, handle, { scope: SCOPES })
    const userId = `token-${tokenId}`
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId,
      metadata: {},
      scope: approved.request.scope,
      props: { userId, cloudflareToken } satisfies LeeProps
    })
    approved.headers.set("location", redirectTo)
    return new Response(null, { status: 302, headers: approved.headers })
  }
}

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
  resourceMetadata: { resource: "https://localhost:8799/v1/", authorization_servers: ["https://localhost:8799"] }
})
