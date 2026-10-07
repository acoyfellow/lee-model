import { Effect, Layer, Queue, Redacted, Schema, Stream } from "effect"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { FetchHttpClient } from "effect/http"
import { runLeeTurn, type LeeTurn } from "./lee-agent.ts"
import { ChatRequest } from "./openai-wire.ts"

interface Env {
  readonly BRAIN_MODEL: string
  readonly ACCOUNT_ID: string
  readonly WORKERS_AI_TOKEN: string
}

const PUBLIC_MODEL_ID = "cloudflare/lee"

const brainLayer = (env: Env) =>
  OpenAiLanguageModel.layer({ model: env.BRAIN_MODEL }).pipe(
    Layer.provide(
      OpenAiClient.layer({
        apiUrl: `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/ai/v1`,
        apiKey: Redacted.make(env.WORKERS_AI_TOKEN)
      })
    ),
    Layer.provideMerge(FetchHttpClient.layer)
  )

const bearerToken = (request: Request) => {
  const value = request.headers.get("authorization") ?? ""
  const token = value.replace(/^Bearer\s+/i, "").trim()
  return token.length > 0 && token !== "none" ? token : undefined
}

const completionId = () => `chatcmpl-${crypto.randomUUID()}`
const now = () => Math.floor(Date.now() / 1000)

const sseChunk = (id: string, delta: Record<string, unknown>, finishReason: string | null = null) =>
  `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: now(), model: PUBLIC_MODEL_ID, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`

const finalDeltas = (id: string, turn: LeeTurn) => {
  const chunks: Array<string> = []
  if (turn.text) chunks.push(sseChunk(id, { content: turn.text }))
  if (turn.clientToolCalls.length > 0) {
    chunks.push(
      sseChunk(id, {
        tool_calls: turn.clientToolCalls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }))
      })
    )
  }
  chunks.push(sseChunk(id, {}, turn.clientToolCalls.length > 0 ? "tool_calls" : "stop"))
  chunks.push("data: [DONE]\n\n")
  return chunks
}

const completionBody = (turn: LeeTurn) => ({
  id: completionId(),
  object: "chat.completion",
  created: now(),
  model: PUBLIC_MODEL_ID,
  choices: [
    {
      index: 0,
      finish_reason: turn.clientToolCalls.length > 0 ? "tool_calls" : "stop",
      message: {
        role: "assistant",
        content: turn.text || null,
        ...(turn.clientToolCalls.length > 0
          ? { tool_calls: turn.clientToolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }
          : {})
      }
    }
  ]
})

const streamTurn = (request: ChatRequest, cloudflareToken: string | undefined, env: Env) => {
  const id = completionId()
  const events = Stream.callback<string>((queue) =>
    Effect.gen(function* () {
      yield* Queue.offer(queue, sseChunk(id, { role: "assistant", content: "" }))
      const turn = yield* runLeeTurn({
        messages: request.messages,
        clientTools: request.tools ?? [],
        cloudflareToken,
        onProgress: (line) => Queue.offer(queue, sseChunk(id, { reasoning_content: `${line}\n` })).pipe(Effect.asVoid)
      }).pipe(
        Effect.catchCause((cause) => Effect.succeed<LeeTurn>({ text: `Lee failed: ${String(cause).slice(0, 400)}`, clientToolCalls: [] }))
      )
      for (const chunk of finalDeltas(id, turn)) yield* Queue.offer(queue, chunk)
      yield* Queue.end(queue)
    }).pipe(Effect.provide(brainLayer(env)))
  )
  return Stream.toReadableStream(Stream.encodeText(events))
}

const modelsBody = { object: "list", data: [{ id: PUBLIC_MODEL_ID, object: "model", created: 0, owned_by: "cloudflare" }] }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const handleChat = async (request: Request, env: Env) => {
  const decoded = Schema.decodeUnknownExit(ChatRequest)(await request.json().catch(() => null))
  if (decoded._tag === "Failure") return json({ error: { message: "invalid chat completion request" } }, 400)
  const chat = decoded.value
  const cloudflareToken = bearerToken(request)
  if (chat.stream) {
    return new Response(streamTurn(chat, cloudflareToken, env), {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" }
    })
  }
  const turn = await Effect.runPromise(
    runLeeTurn({ messages: chat.messages, clientTools: chat.tools ?? [], cloudflareToken, onProgress: () => Effect.void }).pipe(Effect.provide(brainLayer(env)))
  )
  return json(completionBody(turn))
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url)
    if (request.method === "GET" && pathname.endsWith("/models")) return json(modelsBody)
    if (request.method === "POST" && pathname.endsWith("/chat/completions")) return handleChat(request, env)
    return json({ error: { message: "not found" } }, 404)
  }
} satisfies ExportedHandler<Env>
