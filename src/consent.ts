import type { ConsentDescription } from "@cloudflare/workers-oauth-provider"

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

export const consentPage = (details: ConsentDescription, handle: string, error?: string) => `<!doctype html>
<meta charset="utf-8">
<title>Sign in to Lee</title>
<style>body{font:16px system-ui;max-width:520px;margin:60px auto;padding:0 16px}input[type=password]{width:100%;padding:8px}button{padding:8px 16px}</style>
<h1>Allow ${escapeHtml(details.clientName)} to use Lee?</h1>
<p>Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>Scopes: ${details.scope.map(escapeHtml).join(", ")}</p>
${error ? `<p style="color:#b00">${escapeHtml(error)}</p>` : ""}
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <p><label>Cloudflare API token (read-only is enough). It is stored encrypted on the Lee server and never sent to your app.<br>
  <input type="password" name="cloudflare_token" autocomplete="off" required></label></p>
  <p><button name="decision" value="approve">Allow</button> <button name="decision" value="deny" formnovalidate>Deny</button></p>
</form>`
