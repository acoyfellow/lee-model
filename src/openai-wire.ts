import { Schema } from "effect"

export const WireToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.optional(Schema.Literal("function")),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String })
})

const TextContent = Schema.Union([
  Schema.String,
  Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  Schema.Null
])

export const WireMessage = Schema.Struct({
  role: Schema.Literals(["system", "developer", "user", "assistant", "tool"]),
  content: Schema.optional(TextContent),
  tool_calls: Schema.optional(Schema.Array(WireToolCall)),
  tool_call_id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String)
})
export type WireMessage = typeof WireMessage.Type

export const WireTool = Schema.Struct({
  type: Schema.Literal("function"),
  function: Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
    parameters: Schema.optional(Schema.Unknown)
  })
})
export type WireTool = typeof WireTool.Type

export const ChatRequest = Schema.Struct({
  model: Schema.String,
  messages: Schema.Array(WireMessage),
  tools: Schema.optional(Schema.Array(WireTool)),
  stream: Schema.optional(Schema.Boolean),
  max_tokens: Schema.optional(Schema.Number),
  max_completion_tokens: Schema.optional(Schema.Number)
})
export type ChatRequest = typeof ChatRequest.Type
