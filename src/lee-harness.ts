import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Agent } from "agents"
import { PiHarness } from "agents/harness/pi"
import { createAI } from "agents/models/pi-ai"
import { createModels } from "@earendil-works/pi-ai/models"
import { Type } from "@earendil-works/pi-ai"
import { createRegistry, Harness, type Extension, type ToolRegistration } from "@earendil-works/pi-durable"
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

  async ask(conversationKey: string, prompt: string) {
    const session = await this.sessionFor(conversationKey)
    const answer = await session.prompt(prompt)
    return { status: answer.status, text: answer.text ?? "", reason: answer.reason ?? "" }
  }
}
