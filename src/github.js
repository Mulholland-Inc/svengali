// All things GitHub. No SDK — just fetch + WebCrypto.
//
//   App authentication (server-to-server)
//     ─ JWT signed with the App's private key (RS256)
//     ─ exchanged for a 1-hour installation access token (cached in KV)
//     ─ used to read the repo for serving anonymous traffic
//
//   User-to-server authentication
//     ─ standard OAuth flow with the App's client_id / client_secret
//     ─ user access token is stored in the session
//     ─ commits are made using the user's token, attributed to them
//
//   Reads use the installation token; writes use the user's token.

const UA = 'svengali-editor'
const API = 'https://api.github.com'
const RAW = 'https://raw.githubusercontent.com'
const CACHE_TTL_S = 60
const CACHE_MAX_BYTES = 512 * 1024

// ── App config (persisted in KV after the manifest flow) ────────────────

const CONFIG_KEY = 'app_config'

export async function getAppConfig(env) {
    const raw = await env.OAUTH_KV.get(CONFIG_KEY)
    if (!raw) return null
    return JSON.parse(raw)
}

export async function putAppConfig(env, config) {
    await env.OAUTH_KV.put(CONFIG_KEY, JSON.stringify(config))
}

export async function patchAppConfig(env, patch) {
    const current = (await getAppConfig(env)) ?? {}
    const next = { ...current, ...patch }
    await putAppConfig(env, next)
    return next
}

// ── Manifest flow ───────────────────────────────────────────────────────

// Exchange the temporary code from the manifest redirect for the App's
// permanent credentials (App ID, private key, client secret, webhook secret).
export async function convertManifest(code) {
    const res = await fetch(`${API}/app-manifests/${code}/conversions`, {
        method: 'POST',
        headers: {
            accept: 'application/vnd.github+json',
            'user-agent': UA,
        },
    })
    if (!res.ok) throw new Error(`Manifest conversion ${res.status}: ${await res.text()}`)
    return res.json()
}

// ── App auth (server-to-server) ─────────────────────────────────────────

function pemToDer(pem) {
    const body = pem
        .replace(/-----BEGIN [^-]+-----/, '')
        .replace(/-----END [^-]+-----/, '')
        .replace(/\s+/g, '')
    const bin = atob(body)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
}

function b64url(input) {
    const bytes =
        typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function appJwt(appId, privateKeyPem) {
    const der = pemToDer(privateKeyPem)
    const key = await crypto.subtle.importKey(
        'pkcs8',
        der,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign'],
    )
    const now = Math.floor(Date.now() / 1000)
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
    const payload = b64url(
        JSON.stringify({ iat: now - 30, exp: now + 9 * 60, iss: String(appId) }),
    )
    const data = `${header}.${payload}`
    const sig = await crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        key,
        new TextEncoder().encode(data),
    )
    return `${data}.${b64url(sig)}`
}

const TOKEN_KEY = 'install_token'

// Mint (or reuse a cached) installation access token. Cached for ~50 minutes.
export async function getInstallationToken(env) {
    const cachedRaw = await env.OAUTH_KV.get(TOKEN_KEY)
    if (cachedRaw) {
        const cached = JSON.parse(cachedRaw)
        if (cached.expiresAt - 60_000 > Date.now()) return cached.token
    }
    const cfg = await getAppConfig(env)
    if (!cfg?.privateKey || !cfg?.appId) throw new Error('App not configured. Visit /__setup.')
    if (!cfg.installationId) throw new Error('App not installed. Visit /__setup.')

    const jwt = await appJwt(cfg.appId, cfg.privateKey)
    const res = await fetch(
        `${API}/app/installations/${cfg.installationId}/access_tokens`,
        {
            method: 'POST',
            headers: {
                authorization: `Bearer ${jwt}`,
                accept: 'application/vnd.github+json',
                'user-agent': UA,
            },
        },
    )
    if (!res.ok) {
        throw new Error(`Installation token ${res.status}: ${await res.text()}`)
    }
    const json = await res.json()
    const expiresAt = new Date(json.expires_at).getTime()
    const ttl = Math.floor((expiresAt - Date.now()) / 1000) - 60
    await env.OAUTH_KV.put(
        TOKEN_KEY,
        JSON.stringify({ token: json.token, expiresAt }),
        { expirationTtl: Math.max(ttl, 60) },
    )
    return json.token
}

// Look up the App's installation on the configured org/owner. Used after
// the install redirect to discover installation_id automatically.
export async function findInstallationId(env, owner) {
    const cfg = await getAppConfig(env)
    if (!cfg?.privateKey || !cfg?.appId) throw new Error('App not configured.')
    const jwt = await appJwt(cfg.appId, cfg.privateKey)
    const res = await fetch(`${API}/app/installations`, {
        headers: {
            authorization: `Bearer ${jwt}`,
            accept: 'application/vnd.github+json',
            'user-agent': UA,
        },
    })
    if (!res.ok) throw new Error(`List installations ${res.status}`)
    const list = await res.json()
    const match = list.find((i) => i.account?.login?.toLowerCase() === owner.toLowerCase())
    return match?.id ?? null
}

// ── User-to-server auth ─────────────────────────────────────────────────

// Exchange an OAuth `code` (from the GitHub redirect) for a user access token.
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
    const repo = await fetch(`${API}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`, {
        headers: {
            authorization: `Bearer ${userToken}`,
            accept: 'application/vnd.github+json',
            'user-agent': UA,
        },
    })
    if (!repo.ok) return { ok: false, login: null }
    const repoJson = await repo.json()
    if (!repoJson?.permissions?.push) return { ok: false, login: null }
    const me = await fetch(`${API}/user`, {
        headers: {
            authorization: `Bearer ${userToken}`,
            accept: 'application/vnd.github+json',
            'user-agent': UA,
        },
    })
    if (!me.ok) return { ok: false, login: null }
    const profile = await me.json()
    return { ok: true, login: profile.login }
}

// ── Repo reads (via installation token) ─────────────────────────────────

const cacheKey = (env, path) => `f:${env.GITHUB_BRANCH}:${path}`

export async function readFile(env, path) {
    const ckey = cacheKey(env, path)
    const cached = await env.SITE_CACHE.get(ckey, 'arrayBuffer')
    if (cached) return new Uint8Array(cached)

    const token = await getInstallationToken(env)
    const url = `${RAW}/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/${env.GITHUB_BRANCH}/${path}`
    const res = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, 'user-agent': UA },
    })
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

// Recursive tree of every path on the configured branch (uses installation token).
export async function listTree(env) {
    const token = await getInstallationToken(env)
    const branch = await ghJson(token, repoPath(env, `/branches/${env.GITHUB_BRANCH}`))
    const treeSha = branch.commit.commit.tree.sha
    const tree = await ghJson(token, repoPath(env, `/git/trees/${treeSha}?recursive=1`))
    return tree.tree.filter((n) => n.type === 'blob').map((n) => n.path)
}

// ── Repo writes (atomic commit using a user token) ──────────────────────

const repoPath = (env, suffix) => `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}${suffix}`
const branchRef = (env) => `heads/${env.GITHUB_BRANCH}`

function ghHeaders(token, body) {
    const h = new Headers()
    h.set('authorization', `Bearer ${token}`)
    h.set('accept', 'application/vnd.github+json')
    h.set('user-agent', UA)
    if (body) h.set('content-type', 'application/json')
    return h
}

async function ghJson(token, path, init = {}) {
    const res = await fetch(`${API}${path}`, {
        ...init,
        headers: ghHeaders(token, init.body),
    })
    if (!res.ok) {
        throw new Error(
            `GitHub ${init.method ?? 'GET'} ${path} → ${res.status}: ${await res.text()}`,
        )
    }
    return res.json()
}

export async function commitFiles(env, files, message, userToken) {
    if (!files.length) throw new Error('commitFiles: nothing to commit')
    if (!userToken) throw new Error('commitFiles: missing user token')

    const ref = await ghJson(userToken, repoPath(env, `/git/ref/${branchRef(env)}`))
    const refSha = ref.object.sha
    const headCommit = await ghJson(userToken, repoPath(env, `/git/commits/${refSha}`))
    const baseTreeSha = headCommit.tree.sha

    const blobs = await Promise.all(
        files.map(async (f) => {
            const bytes =
                typeof f.bytes === 'string' ? new TextEncoder().encode(f.bytes) : f.bytes
            const content = bytesToBase64(bytes)
            const blob = await ghJson(userToken, repoPath(env, '/git/blobs'), {
                method: 'POST',
                body: JSON.stringify({ content, encoding: 'base64' }),
            })
            return { path: f.path, sha: blob.sha }
        }),
    )

    const newTree = await ghJson(userToken, repoPath(env, '/git/trees'), {
        method: 'POST',
        body: JSON.stringify({
            base_tree: baseTreeSha,
            tree: blobs.map((b) => ({
                path: b.path,
                mode: '100644',
                type: 'blob',
                sha: b.sha,
            })),
        }),
    })

    const newCommit = await ghJson(userToken, repoPath(env, '/git/commits'), {
        method: 'POST',
        body: JSON.stringify({ message, tree: newTree.sha, parents: [refSha] }),
    })

    await ghJson(userToken, repoPath(env, `/git/refs/${branchRef(env)}`), {
        method: 'PATCH',
        body: JSON.stringify({ sha: newCommit.sha, force: false }),
    })

    await bustCache(env, files.map((f) => f.path))
    return { commitSha: newCommit.sha, url: newCommit.html_url }
}

function bytesToBase64(bytes) {
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s)
}
