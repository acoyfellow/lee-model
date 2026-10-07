import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { HttpClient, HttpClientRequest } from "effect/http"

export const SearchDocs = Tool.make("lee_search_docs", {
  description: "Search current Cloudflare developer documentation. Use before answering any Cloudflare product question.",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.String
})

export const CloudflareApiRead = Tool.make("lee_cf_api_get", {
  description: "Read the caller's Cloudflare account with a GET request to the Cloudflare API v4. Path is relative to https://api.cloudflare.com/client/v4, for example /zones or /accounts/{account_id}/workers/scripts.",
  parameters: Schema.Struct({ path: Schema.String }),
  success: Schema.String
})

export const LeeToolkit = Toolkit.make(SearchDocs, CloudflareApiRead)
export const leeToolNames: ReadonlySet<string> = new Set(Object.keys(LeeToolkit.tools))

const DOCS_MCP_URL = "https://docs.mcp.cloudflare.com/mcp"
const CF_API_BASE = "https://api.cloudflare.com/client/v4"
const RESULT_CHAR_LIMIT = 12_000

const truncate = (text: string) => (text.length > RESULT_CHAR_LIMIT ? `${text.slice(0, RESULT_CHAR_LIMIT)}\n…truncated` : text)

const textFromSse = (body: string) =>
  body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { result?: { content?: ReadonlyArray<{ text?: string }> } })
    .flatMap((frame) => frame.result?.content ?? [])
    .map((part) => part.text ?? "")
    .join("\n")

const isSafeApiPath = (path: string) => path.startsWith("/") && !path.startsWith("//") && !path.includes("://") && !path.includes("..")

const searchDocs = (query: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    return yield* HttpClientRequest.post(DOCS_MCP_URL).pipe(
      HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
      HttpClientRequest.bodyJsonUnsafe({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_cloudflare_documentation", arguments: { query } }
      }),
      client.execute,
      Effect.flatMap((response) => response.text),
      Effect.map((body) => truncate(textFromSse(body)))
    )
  }).pipe(Effect.orElseSucceed(() => "docs search failed"))

const readCloudflareApi = (path: string, cloudflareToken: string | undefined) =>
  Effect.gen(function* () {
    if (!cloudflareToken) return "No Cloudflare API token was sent. Ask the user to set their Cloudflare API token as the API key."
    if (!isSafeApiPath(path)) return "Refused: path must be a relative Cloudflare API path."
    const client = yield* HttpClient.HttpClient
    return yield* HttpClientRequest.get(`${CF_API_BASE}${path}`).pipe(
      HttpClientRequest.bearerToken(cloudflareToken),
      client.execute,
      Effect.flatMap((response) => response.text),
      Effect.map(truncate)
    )
  }).pipe(Effect.orElseSucceed(() => "Cloudflare API request failed"))

const stringField = (params: unknown, field: string) =>
  typeof params === "object" && params !== null && typeof (params as Record<string, unknown>)[field] === "string"
    ? ((params as Record<string, unknown>)[field] as string)
    : ""

export const runLeeTool = (name: string, params: unknown, cloudflareToken: string | undefined) => {
  switch (name) {
    case SearchDocs.name:
      return searchDocs(stringField(params, "query"))
    case CloudflareApiRead.name:
      return readCloudflareApi(stringField(params, "path"), cloudflareToken)
    default:
      return Effect.succeed(`Unknown Lee tool ${name}`)
  }
}

export const describeLeeToolCall = (name: string, params: unknown) =>
  name === SearchDocs.name ? `searching Cloudflare docs: ${stringField(params, "query")}` : `reading your account: GET ${stringField(params, "path")}`
