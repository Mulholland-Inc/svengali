# Svengali

Cloudflare Worker that serves the marketing site live from GitHub, expands `<include>` partials, and lets logged-in editors right-click to edit text/links/images. Every save is a real commit on `main`, attributed to the editor's GitHub identity.

```
visitor  ──▶  Worker ──▶ raw.githubusercontent.com   (cached 60s in KV)
                │
editor   ──▶  Worker ──▶ GitHub Git Data API         (1 atomic commit per save)
```

- **Source of truth**: `Mulholland-Inc/site` on GitHub. No R2, no DB — every edit is a commit.
- **Auth**: GitHub App. Bot reads via installation token; user-to-server OAuth gates writes. Push-access on the configured repo is the only access check.
- **Components**: `<include src="/_chrome/nav.html"></include>` is replaced server-side, recursively, before the editor injects its overlay. Edit a nav element on any page → cross-page sync writes to `_chrome/nav.html` once.
- **Edit model**:
  ```html
  <h1 data-edit="hero.title">…</h1>           <!-- right-click → Edit text -->
  <a  data-edit-href="cta.url" href="…">…    <!-- right-click → Edit href -->
  <img data-edit-src="hero.image" src="…">   <!-- right-click → Edit src -->
  <img data-edit-alt="hero.alt" alt="…">     <!-- right-click → Edit alt -->
  ```

## Setup

1. **KV namespaces** — create once, paste ids into `wrangler.toml`:
   ```
   wrangler kv namespace create OAUTH_KV
   wrangler kv namespace create SITE_CACHE
   ```
2. **Secret**:
   ```
   wrangler secret put COOKIE_SECRET     # `openssl rand -hex 32`
   ```
3. **Deploy**:
   ```
   npm install
   wrangler deploy
   ```
4. **Register the GitHub App** — visit `https://<worker>/__setup` and click through twice:
   - "Create GitHub App from manifest" → GitHub creates an App scoped to `Contents: read/write` + `Metadata: read` on `Mulholland-Inc`. Worker captures the credentials.
   - "Install on Mulholland-Inc" → grant access to `Mulholland-Inc/site`. Worker captures `installation_id` and bounces you to `/__login`.

After that, anyone with push access to the repo can sign in at `/__login` and edit.

## Editing

1. Tag any element you want editable (or any link/image attribute):
   ```html
   <h1 data-edit="hero.title">Run every surface from one model.</h1>
   <a data-edit-href="cta.url" href="/signup">Get started</a>
   ```
2. Visit `/__login`, sign in via GitHub.
3. Right-click any tagged element → pick the action → enter the value → hit **Save**. Same key on multiple pages = one commit, all pages updated.

## Files

```
src/
  app.js            entry — Hono router
  site.js           serve from GitHub, expand <include>, inject editor on auth
  edit.js           /__login, /__edit/callback, /__edit/save (cookie session → commit)
  setup.js          /__setup — one-time GitHub App manifest + install
  github.js         GitHub client (App JWT, OAuth, raw reads, Git Data API)
  editor-client.js  inlined right-click overlay (text + attribute edits, save bar)
  util.js           sessions in KV, signed OAuth state
```
