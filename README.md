# lee-model

An experiment: Agent Lee as a model name.

Point any OpenAI-compatible client at this Worker and pick the model `cloudflare/lee`. Behind that name, an agent loop runs on Workers AI (GLM-5.3) with its own server-side tools. The client never sees those tools. It just gets better answers about building on Cloudflare.

Unofficial. Not a Cloudflare product or API.

## How it works

- `POST /v1/chat/completions` and `GET /v1/models`, streaming and non-streaming.
- Server-side tools, run inside the Worker:
  - `lee_search_docs`: current Cloudflare docs via the public docs MCP server.
  - `lee_cf_api_get`: read-only Cloudflare API calls with the caller's own token.
- Client tools pass through. If the client sends tools such as `bash` or `edit`, the model can call them and the client runs them.
- Server-side progress streams as `reasoning_content`, so clients show "searching docs…" while Lee works.

Built with [Effect](https://effect.website) 4: `effect/ai`, `effect/http`, `Schema`, `Stream`, and `@effect/ai-openai-compat`.

## Run

```sh
npm install
LEE_ACCOUNT_ID=<your account id> npm run dev
```

`npm run dev` reads your Wrangler OAuth token for Workers AI calls.

## Use from pi

Add a provider to `~/.pi/agent/models.json`:

```json
"cloudflare": {
  "baseUrl": "http://localhost:8799/v1",
  "api": "openai-completions",
  "apiKey": "<a Cloudflare API token, used for account reads>",
  "models": [{ "id": "cloudflare/lee", "name": "Lee", "input": ["text"], "contextWindow": 128000, "maxTokens": 16384 }]
}
```

Then:

```sh
pi --no-skills --no-extensions --provider cloudflare --model cloudflare/lee
```

## Limits

- The API key is the caller's Cloudflare token. Real auth would come from AI Gateway.
- Read-only. No write tools until there is an approval step.
- Stateless. Each request carries the full history.
