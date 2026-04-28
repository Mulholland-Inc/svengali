// All things GitHub. No SDK — just fetch + WebCrypto.
//
//   App auth (server-to-server) — JWT signed with the App's private key
//     ↳ exchanged for a 1-hour installation access token (cached in KV)
//     ↳ used to read the repo
//
//   User-to-server — standard OAuth code → user access token
//     ↳ stored in the session, used to commit (commits attributed to user)

const UA = 'svengali-editor'
const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const CACHE_TTL_S = 60
const CACHE_MAX_BYTES = 512 * 1024
const CONFIG_KEY = 'app_config'
const TOKEN_KEY = 'install_token'

// ── thin fetch helpers ──────────────────────────────────────────────────

async function gh(token, path, init = {}) {
    const headers = new Headers()
    if (token) headers.set('authorization', `Bearer ${token}`)
    headers.set('accept', 'application/vnd.github+json')
    headers.set('user-agent', UA)
    if (init.body) headers.set('content-type', 'application/json')
    return fetch(`${API}${path}`, { ...init, headers })
}

async function ghJson(token, path, init = {}) {
    const res = await gh(token, path, init)
    if (!res.ok) {
        throw new Error(
            `GitHub ${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`,
        )
    }
    return res.json()
}

const repoPath = (env, suffix) => `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${suffix}`
const branchRef = (env) => `heads/${env.GITHUB_BRANCH}`
const cacheKey = (env, path) => `f:${env.GITHUB_BRANCH}:${path}`

// ── App config (persisted in KV after the manifest flow) ────────────────

export async function getAppConfig(env) {
    const raw = await env.OAUTH_KV.get(CONFIG_KEY)
    return raw ? JSON.parse(raw) : null
}

export async function putAppConfig(env, config) {
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify(config))
}

export async function patchAppConfig(env, patch) {
    const next = { ...((await getAppConfig(env)) ?? {}), ...patch }
    await putAppConfig(env, next)
    return next
}

// Exchange the temporary code from the manifest redirect for the App's
// permanent credentials (App ID, private key, client secret, webhook secret).
export async function convertManifest(code) {
    return ghJson(null, `/app-manifests/${code}/conversions`, { method: 'POST' })
}

// ── App auth (RS256 JWT → installation token) ───────────────────────────

function b64url(input) {
    const bytes =
        typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function appJwt(appId, privateKeyPem) {
    const body = privateKeyPem
        .replace(/-----BEGIN [^-]+-----/, '')
        .replace(/-----END [^-]+-----/, '')
        .replace(/\s+/g, '')
    const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0))
    const key = await crypto.subtle.importKey(
        'pkcs8',
        der,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
    )
    const now = Math.floor(Date.now() / 1000)
    const data =
        b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) +
        '.' +
        b64url(JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: String(appId) }))
    const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        key,
        new TextEncoder().encode(data),
    )
    return `${data}.${b64url(sig)}`
}

// Mint or reuse a cached installation access token (~50 minute reuse window).
export async function getInstallationToken(env) {
    const cached = await env.OAUTH_KV.get(TOKEN_KEY, 'json')
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token

    const cfg = await getAppConfig(env)
    if (!cfg?.privateKey || !cfg?.appId) throw new Error('App not configured. Visit /__setup.')
    if (!cfg.installationId) throw new Error('App not installed. Visit /__setup.')

    const jwt = await appJwt(cfg.appId, cfg.privateKey)
    const json = await ghJson(jwt, `/app/installations/${cfg.installationId}/access_tokens`, {
        method: 'POST',
    })
    const expiresAt = new Date(json.expires_at).getTime()
    const ttl = Math.max(60, Math.floor((expiresAt - Date.now()) / 1000) - 60)
    await env.OAUTH_KV.put(
        TOKEN_KEY,
        JSON.stringify({ token: json.token, expiresAt }),
        { expirationTtl: ttl },
    )
    return json.token
}

// Look up the App's installation on the configured org. Used after the install
// redirect to discover installation_id automatically.
export async function findInstallationId(env, owner) {
    const cfg = await getAppConfig(env)
    if (!cfg?.privateKey || !cfg?.appId) throw new Error('App not configured.')
    const jwt = await appJwt(cfg.appId, cfg.privateKey)
    const list = await ghJson(jwt, '/app/installations')
    const match = list.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase())
    return match?.id ?? null
}

// ── User-to-server auth ─────────────────────────────────────────────────

export async function exchangeOAuthCode(env, code) {
    const cfg = await getAppConfig(env)
    if (!cfg?.clientId || !cfg?.clientSecret) throw new Error('App not configured.')
    const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({
            client_id: cfg.clientId,
            client_secret: cfg.clientSecret,
            code,
        }),
    })
    if (!res.ok) throw new Error(`OAuth code exchange ${res.status}`)
    const json = await res.json()
    if (!json.access_token) {
        throw new Error(`OAuth: ${json.error_description ?? json.error ?? 'no access token'}`)
    }
    return json
}

// True iff `userToken` has push access to the configured repo.
export async function checkRepoPushAccess(env, userToken) {
    try {
        const repo = await ghJson(userToken, repoPath(env, ''))
        if (!repo?.permissions?.push) return { ok: false, login: null }
        const me = await ghJson(userToken, '/user')
        return { ok: true, login: me.login }
    } catch {
        return { ok: false, login: null }
    }
}

// ── Repo reads (installation token + KV cache) ──────────────────────────

export async function readFile(env, path) {
    const ckey = cacheKey(env, path)
    const cached = await env.SITE_CACHE.get(ckey, 'arrayBuffer')
    if (cached) return new Uint8Array(cached)

    const token = await getInstallationToken(env)
    const res = await fetch(
        `${RAW}/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${path}`,
        { headers: { authorization: `Bearer ${token}`, 'user-agent': UA } },
    )
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`GitHub raw ${path} → ${res.status}`)
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.byteLength <= CACHE_MAX_BYTES) {
        await env.SITE_CACHE.put(ckey, buf, { expirationTtl: CACHE_TTL_S })
    }
    return buf
}

export async function bustCache(env, paths) {
    await Promise.all(paths.map((p) => env.SITE_CACHE.delete(cacheKey(env, p))))
}

// Recursive list of every path on the configured branch.
export async function listTree(env) {
    const token = await getInstallationToken(env)
    const branch = await ghJson(token, repoPath(env, `/branches/${env.GITHUB_BRANCH}`))
    const tree = await ghJson(
        token,
        repoPath(env, `/git/trees/${branch.commit.commit.tree.sha}?recursive=1`),
    )
    return tree.tree.filter((n) => n.type === 'blob').map((n) => n.path)
}

// ── Repo writes — single atomic commit via the Git Data API ─────────────

function bytesToBase64(bytes) {
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s)
}

export async function commitFiles(env, files, message, userToken) {
    if (!files.length) throw new Error('commitFiles: nothing to commit')
    if (!userToken) throw new Error('commitFiles: missing user token')

    const ref = await ghJson(userToken, repoPath(env, `/git/ref/${branchRef(env)}`))
    const head = await ghJson(userToken, repoPath(env, `/git/commits/${ref.object.sha}`))

    const blobs = await Promise.all(
        files.map(async (f) => {
            const bytes =
                typeof f.bytes === 'string' ? new TextEncoder().encode(f.bytes) : f.bytes
            const blob = await ghJson(userToken, repoPath(env, '/git/blobs'), {
                method: 'POST',
                body: JSON.stringify({ content: bytesToBase64(bytes), encoding: 'base64' }),
            })
            return { path: f.path, sha: blob.sha }
        }),
    )

    const tree = await ghJson(userToken, repoPath(env, '/git/trees'), {
        method: 'POST',
        body: JSON.stringify({
            base_tree: head.tree.sha,
            tree: blobs.map((b) => ({
                path: b.path,
                mode: '100644',
                type: 'blob',
                sha: b.sha,
            })),
        }),
    })

    const commit = await ghJson(userToken, repoPath(env, '/git/commits'), {
        method: 'POST',
        body: JSON.stringify({ message, tree: tree.sha, parents: [ref.object.sha] }),
    })

    await ghJson(userToken, repoPath(env, `/git/refs/${branchRef(env)}`), {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false }),
    })

    await bustCache(env, files.map((f) => f.path))
    return { commitSha: commit.sha, url: commit.html_url }
}
