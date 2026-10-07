import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Agent } from "agents"
import { PiHarness } from "agents/harness/pi"
import { createAI } from "agents/models/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { Type, type AssistantMessage } from "@earendil-works/pi-ai"
import { createRegistry, Harness, type AgentEvent, type Extension, type ToolRegistration } from "@earendil-works/pi-durable"
import { runLeeTool } from "./lee-tools.ts"

export interface LeeEnv {
  readonly AI: Ai
  readonly BRAIN_MODEL: string
}

export const LEE_INSTRUCTIONS = `You are Lee, Cloudflare's assistant for building on Cloudflare.
Search the docs with lee_search_docs before answering any product question; Cloudflare changes often.
Read the user's account with lee_cf_api_get. Answer account questions from that data, never from memory.
Prefer current platform features: Workers static assets over Workers Sites, wrangler.jsonc over wrangler.toml.
Never change an account without asking first. Be brief.`

const runToolEffect = (name: string, params: unknown, cloudflareToken: string | undefined) =>
  Effect.runPromise(runLeeTool(name, params, cloudflareToken).pipe(Effect.provide(FetchHttpClient.layer as Layer.Layer<HttpClient.HttpClient>)))

const textResult = (text: string) => ({ content: [{ type: "text" as const, text }] })

const leeTools = (readToken: () => Promise<string | undefined>): ReadonlyArray<ToolRegistration> => [
  {
    name: "lee_search_docs",
    description: "Search current Cloudflare developer documentation.",
    parameters: Type.Object({ query: Type.String() }),
    replay: "safe",
    async execute(args) {
      return textResult(await runToolEffect("lee_search_docs", args, undefined))
    }
  },
  {
    name: "lee_cf_api_get",
    description: "GET the caller's Cloudflare account through the Cloudflare API v4. Path is relative to /client/v4, for example /zones?per_page=50.",
    parameters: Type.Object({ path: Type.String() }),
    replay: "safe",
    async execute(args) {
      return textResult(await runToolEffect("lee_cf_api_get", args, await readToken()))
    }
  }
]

const leeExtension = (readToken: () => Promise<string | undefined>): Extension => ({
  name: "lee",
  tools: leeTools(readToken),
  sections: [{ key: "lee", render: () => LEE_INSTRUCTIONS }]
})

export class LeeAgent extends Agent<LeeEnv & Cloudflare.Env> {
  ai = createAI({ binding: this.env.AI })
  harness = new PiHarness({
    harness: ({ storage, context }) => {
      const models = createModels()
      models.setProvider(this.ai.provider)
      const registry = createRegistry()
      registry.install(leeExtension(() => this.ctx.storage.get<string>("cloudflare-token")))
      return Harness.open(storage, { models, registry }, context)
    },
    defaults: { model: this.ai(this.env.BRAIN_MODEL) }
  })

  constructor(ctx: DurableObjectState, env: LeeEnv & Cloudflare.Env) {
    super(ctx, env)
    this.lifecycle.use(this.harness)
  }

  async setCloudflareToken(token: string) {
    await this.ctx.storage.put("cloudflare-token", token)
  }

  private async sessionFor(conversationKey: string) {
    const known = await this.ctx.storage.get<string>(`session:${conversationKey}`)
    if (known) return this.harness.sessions.get(known)
    const created = await this.harness.sessions.create()
    await this.ctx.storage.put(`session:${conversationKey}`, created.id)
    return created
  }

  async streamAnswer(conversationKey: string, prompt: string, modelId: string): Promise<ReadableStream<Uint8Array>> {
    const session = await this.sessionFor(conversationKey)
    const events = await session.events()
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(undefined, { highWaterMark: 1024 }, { highWaterMark: 1024 })
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const id = `chatcmpl-${crypto.randomUUID()}`
    const send = (delta: object, finish: string | null = null) =>
      writer.write(encoder.encode(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`))
    let finished = false
    const finish = async () => {
      if (finished) return
      finished = true
      await send({}, "stop")
      await writer.write(encoder.encode("data: [DONE]\n\n"))
      await writer.close()
      await events.stop()
    }
    void send({ role: "assistant", content: "" })
    const cursor: StreamCursor = { sent: new Map(), emittedText: false }
    let delivered = Promise.resolve()
    events.start(async (batch) => {
      delivered = delivered.then(async () => {
        for (const event of batch) await forwardEvent(event, cursor, send)
      })
      await delivered
    })
    this.ctx.waitUntil(
      session.prompt(prompt).then(
        async (answer) => {
          await delivered
          const finalAssistant = [...answer.messages].reverse().map(assistantOf).find((message) => message !== undefined)
          if (!cursor.emittedText) await emitMessage(cursor, finalAssistant, send)
          if (answer.status !== "done") await send({ content: `Lee could not answer: ${answer.reason ?? "unknown"}` })
          await finish()
        },
        (error: unknown) => send({ content: `Lee failed: ${String(error)}` }).then(finish)
      )
    )
    return readable
  }

  async ask(conversationKey: string, prompt: string) {
    const session = await this.sessionFor(conversationKey)
    const answer = await session.prompt(prompt)
    return { status: answer.status, text: answer.text ?? "", reason: answer.reason ?? "" }
  }
}

const toolLine = (name: string, args: object) => {
  const detail = "path" in args ? `GET ${String(args.path)}` : "query" in args ? String(args.query) : ""
  return `\n→ ${name} ${detail}\n`
}

interface StreamCursor {
  sent: Map<number, string>
  emittedText: boolean
}

type Block = AssistantMessage["content"][number]

type Send = (delta: object) => Promise<void>

const blockText = (block: Block) => (block.type === "text" ? block.text : block.type === "thinking" ? block.thinking : "")

const separateAnswers = async (cursor: StreamCursor, index: number, send: Send) => {
  if (!cursor.sent.has(index) && cursor.emittedText) await send({ content: "\n\n" })
}

const emitBlock = async (cursor: StreamCursor, index: number, block: Block, send: Send) => {
  if (block.type !== "text" && block.type !== "thinking") return
  const full = blockText(block)
  const already = cursor.sent.get(index) ?? ""
  if (full.length <= already.length || !full.startsWith(already)) return
  if (block.type === "text") await separateAnswers(cursor, index, send)
  const rest = full.slice(already.length)
  await send(block.type === "thinking" ? { reasoning_content: rest } : { content: rest })
  cursor.sent.set(index, full)
  if (block.type === "text") cursor.emittedText = true
}

const emitDelta = async (cursor: StreamCursor, index: number, kind: "text" | "thinking", delta: string, send: Send) => {
  if (kind === "text") await separateAnswers(cursor, index, send)
  await send(kind === "thinking" ? { reasoning_content: delta } : { content: delta })
  cursor.sent.set(index, (cursor.sent.get(index) ?? "") + delta)
  if (kind === "text") cursor.emittedText = true
}

const emitMessage = async (cursor: StreamCursor, message: AssistantMessage | undefined, send: Send) => {
  for (const [index, block] of (message?.content ?? []).entries()) await emitBlock(cursor, index, block, send)
}

const assistantOf = (entry: { readonly model?: ReadonlyArray<{ readonly role: string }> } | undefined) =>
  entry?.model?.find((message): message is AssistantMessage => message.role === "assistant")

const forwardEvent = async (event: AgentEvent, cursor: StreamCursor, send: Send) => {
  switch (event.type) {
    case "message_start":
      cursor.sent = new Map()
      return
    case "message_update":
      for (const change of event.changes) {
        if ((change.type === "thinking_start" || change.type === "block") && change.block.type === "thinking") await emitBlock(cursor, change.contentIndex, change.block, send)

        if (change.type === "thinking_delta") await emitDelta(cursor, change.contentIndex, "thinking", change.delta, send)

      }
      return
    case "message_end":
      return emitMessage(cursor, assistantOf(event.entry), send)
    case "snapshot":
      return
    case "tool_execution_start":
      return send({ reasoning_content: toolLine(event.toolName, event.args) })
    case "tool_execution_end":
      return send({ reasoning_content: `✓ ${event.toolName} done\n` })
    default:
      return
  }
}
