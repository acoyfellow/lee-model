import { Effect, Layer } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/ai"
import type { HttpClient } from "effect/http"
import { CloudflareApiRead, describeLeeToolCall, leeToolNames, runLeeTool, SearchDocs } from "./lee-tools.ts"
import type { WireMessage, WireTool } from "./openai-wire.ts"

export const LEE_SYSTEM_PROMPT = `You are Lee, Cloudflare's assistant for building on Cloudflare.
You have server-side tools: lee_search_docs for current Cloudflare documentation and lee_cf_api_get to read the user's Cloudflare account.
Search the docs before answering any product question; Cloudflare changes often, so do not trust memory for APIs or config.
Prefer current platform features: Workers static assets over Workers Sites, wrangler.jsonc over wrangler.toml.
The user's client may also give you local tools such as bash, read, edit, and write. Use those for files and commands on the user's machine.
Never change a user's account or deploy without asking first. Use --dry-run before real changes.
Be brief.`

const MAX_LEE_STEPS = 8

export interface ClientToolCall {
  readonly id: string
  readonly name: string
  readonly arguments: string
}

export interface LeeTurn {
  readonly text: string
  readonly clientToolCalls: ReadonlyArray<ClientToolCall>
}

const textOf = (content: WireMessage["content"]): string => {
  if (content === undefined || content === null) return ""
  if (typeof content === "string") return content
  return content.map((part) => part.text ?? "").join("")
}

const parseArguments = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export const toPrompt = (messages: ReadonlyArray<WireMessage>): Prompt.Prompt => {
  const toolNameById = new Map<string, string>()
  const encoded: Array<Prompt.MessageEncoded> = [{ role: "system", content: LEE_SYSTEM_PROMPT }]
  for (const message of messages) {
    switch (message.role) {
      case "system":
      case "developer":
        encoded.push({ role: "system", content: textOf(message.content) })
        break
      case "user":
        encoded.push({ role: "user", content: textOf(message.content) })
        break
      case "assistant": {
        const calls = message.tool_calls ?? []
        calls.forEach((call) => toolNameById.set(call.id, call.function.name))
        encoded.push({
          role: "assistant",
          content: [
            ...(textOf(message.content) ? [{ type: "text" as const, text: textOf(message.content) }] : []),
            ...calls.map((call) => ({
              type: "tool-call" as const,
              id: call.id,
              name: call.function.name,
              params: parseArguments(call.function.arguments),
              providerExecuted: false
            }))
          ]
        })
        break
      }
      case "tool": {
        const id = message.tool_call_id ?? ""
        encoded.push({
          role: "tool",
          content: [{ type: "tool-result", id, name: toolNameById.get(id) ?? message.name ?? "tool", isFailure: false, result: textOf(message.content) }]
        })
        break
      }
    }
  }
  return Prompt.make(encoded)
}

const clientTool = (wire: WireTool) =>
  Tool.dynamic(wire.function.name, {
    description: wire.function.description ?? "",
    parameters: (wire.function.parameters ?? { type: "object", properties: {} }) as never
  })

const buildToolkit = (clientTools: ReadonlyArray<WireTool>) => {
  const toolkit = Toolkit.make(SearchDocs, CloudflareApiRead, ...clientTools.filter((t) => !leeToolNames.has(t.function.name)).map(clientTool))
  const unreachable = Object.fromEntries(Object.keys(toolkit.tools).map((name) => [name, () => Effect.die(`${name} is resolved outside the toolkit`)]))
  return { toolkit, handlers: toolkit.toLayer(unreachable as never) as Layer.Layer<never> }
}

export const runLeeTurn = (input: {
  readonly messages: ReadonlyArray<WireMessage>
  readonly clientTools: ReadonlyArray<WireTool>
  readonly cloudflareToken: string | undefined
  readonly onProgress: (line: string) => Effect.Effect<void>
}): Effect.Effect<LeeTurn, unknown, LanguageModel.LanguageModel | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { toolkit, handlers } = buildToolkit(input.clientTools)
    let prompt = toPrompt(input.messages)
    for (let step = 0; step < MAX_LEE_STEPS; step++) {
      const response = yield* LanguageModel.generateText({ prompt, toolkit, disableToolCallResolution: true }).pipe(Effect.provide(handlers))
      const calls = response.toolCalls
      const leeCalls = calls.filter((call) => leeToolNames.has(call.name))
      const clientCalls = calls.filter((call) => !leeToolNames.has(call.name))
      if (leeCalls.length === 0 || clientCalls.length > 0) {
        return {
          text: response.text,
          clientToolCalls: clientCalls.map((call) => ({ id: call.id, name: call.name, arguments: JSON.stringify(call.params ?? {}) }))
        }
      }
      const results = yield* Effect.forEach(
        leeCalls,
        (call) =>
          input.onProgress(describeLeeToolCall(call.name, call.params)).pipe(
            Effect.andThen(runLeeTool(call.name, call.params, input.cloudflareToken)),
            Effect.map((result) => ({ type: "tool-result" as const, id: call.id, name: call.name, isFailure: false, result }))
          ),
        { concurrency: "unbounded" }
      )
      prompt = Prompt.concat(prompt, Prompt.fromResponseParts(response.content)).pipe(Prompt.concat(Prompt.make([{ role: "tool", content: results }])))
    }
    return { text: "I stopped after too many internal steps.", clientToolCalls: [] }
  })
