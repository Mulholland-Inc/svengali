# Svengali

Cloudflare Worker that serves the marketing site live from GitHub, lets you click-to-edit when logged in, and exposes the same edit primitives over MCP.

```
visitor  ──▶  Worker  ──▶  raw.githubusercontent.com   (cached 60s in KV)
                  │
editor   ──▶  Worker  ──▶  GitHub Git Data API         (1 atomic commit per save)
MCP      ──▶  Worker  ──▶  GitHub Git Data API         (same path, OAuth-gated)
```

- **Source of truth**: `Mulholland-Inc/site` on GitHub. No R2, no DB, no JSON sidecar — every edit is a real commit on `main`.
- **Auth**: one shared `EDIT_PASSWORD`. Browser editor → HMAC-signed `__edit` cookie. MCP → standard OAuth flow that lands on the same password prompt.
- **Edit model**: sprinkle `data-edit="some.key"` on any element you want editable; the editor flips it to `contenteditable` for authed users and POSTs the new HTML to `/__edit/save`, which uses HTMLRewriter to swap the inner content of `[data-edit="some.key"]` and commits the file.

## Setup

1. **PAT** — create a fine-grained personal access token at <https://github.com/settings/tokens?type=beta>, scoped to `Mulholland-Inc/site` only, with `Contents: read & write` and `Metadata: read`.

2. **KV namespaces**
   ```
   wrangler kv:namespace create OAUTH_KV
   wrangler kv:namespace create SITE_CACHE
   ```
   Paste the returned ids into `wrangler.toml`.

3. **Secrets**
   ```
   wrangler secret put EDIT_PASSWORD     # shared password for editor + MCP
   wrangler secret put COOKIE_SECRET     # any long random string (e.g. `openssl rand -hex 32`)
   wrangler secret put GITHUB_TOKEN      # the PAT from step 1
   ```

4. **Deploy**
   ```
   npm install
   wrangler deploy
   ```

## Editing the site

1. Add `data-edit="<unique-key>"` to any element in `Mulholland-Inc/site` whose text you want editable. Pick a stable, descriptive key — that's the contract:
   ```html
   <h1 data-edit="hero.title">Run every surface from one model.</h1>
   <p  data-edit="hero.subtitle">Acts on the model when trusted.</p>
   ```
2. Visit the deployed Worker, hit `/__login`, enter the password.
3. Edit any `[data-edit]` element directly. Hit **Save**. One GitHub commit per save.

## MCP

Point an MCP client (Claude Desktop, etc.) at `https://<worker>/mcp`. It will redirect to `/authorize`, prompt for the same password, and issue a bearer token.

Tools:
- `list_files()` — every HTML file in the repo
- `list_keys(path)` — every `data-edit` key on a page
- `get_value(path, key)` — current inner text of one key
- `set_value(path, key, html)` — replace inner HTML of one key and commit

## Files

```
src/
  app.js            OAuthProvider wrapper + entry
  site.js           Read-through GitHub serving, editor injection on auth
  edit.js           /__login, /__edit/save (cookie auth → atomic commit)
  oauth.js          /authorize password page (same password, MCP grant)
  agent.js          McpAgent — list_files/list_keys/get_value/set_value
  github.js         Thin GitHub client (raw read + Git Data API write)
  editor-client.js  Inlined click-to-edit script
  util.js           HMAC cookie helpers
```
