const LEE_BANNER = String.raw`
 ██╗     ███████╗███████╗
 ██║     ██╔════╝██╔════╝
 ██║     █████╗  █████╗
 ██║     ██╔══╝  ██╔══╝
 ███████╗███████╗███████╗
 ╚══════╝╚══════╝╚══════╝`

const CLOUD = String.raw`
              .-~~~-.
      .- ~ ~-(       )_ _
     /                     ~ -.
    |      an agent you        \
     \     pick as a model    .'
       ~- . _____________ . -~`

const FLOW = String.raw`
   pi ──/login──▶ lee.coey.dev ──▶ Sign in with Cloudflare
                       │
                       ▼
              ┌─────────────────┐
              │  LeeAgent (DO)  │──▶ lee_search_docs
              │   PiHarness     │──▶ lee_cf_api_get
              └─────────────────┘
                       │
                       ▼
            OpenAI-compatible /v1`

export const homePage = () => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lee · cloudflare/lee</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0d0d0d; color: #e6e6e6; font: 15px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace }
  main { padding: 32px; max-width: 760px }
  pre { margin: 0; white-space: pre; overflow-x: auto }
  .banner { color: #f6821f; text-shadow: 0 0 18px rgba(246,130,31,.45); font-size: 18px; line-height: 1.05 }
  .cloud { color: #fbad41 }
  .flow { color: #9ecbff; margin-top: 12px }
  .try { margin-top: 24px; padding: 16px; border: 1px solid #333; border-radius: 6px; background: #151515 }
  .dim { color: #888 }
  a { color: #f6821f }
  .cursor::after { content: "▍"; animation: blink 1s steps(1) infinite; color: #f6821f }
  @keyframes blink { 50% { opacity: 0 } }
</style>
<main>
<pre class="banner">${LEE_BANNER}</pre>
<pre class="cloud">${CLOUD}</pre>
<pre class="flow">${FLOW}</pre>
<pre class="try"><span class="dim"># use Lee from pi</span>
$ pi --provider cloudflare-lee --model cloudflare/lee
> /login
> how many zones are in my account?<span class="cursor"></span></pre>
<p class="dim">Read-only. Your Cloudflare token stays on the server. Source: <a href="https://github.com/acoyfellow/lee-model">github.com/acoyfellow/lee-model</a></p>
</main>`
