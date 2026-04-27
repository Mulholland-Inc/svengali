// Session and OAuth-state helpers.
//
// Session cookie holds an opaque session id; the actual session record (GitHub
// login + access token) lives in OAUTH_KV under `sess:<id>`.
//
// OAuth state (used while bouncing through GitHub OAuth) is HMAC-signed JSON
// — no KV roundtrip on the callback. State is short-lived (10 min).

const enc = new TextEncoder()

export function constantTimeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    if (a.length !== b.length) return false
    let diff = 0
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
    return diff === 0
}

async function importHmacKey(secret) {
    return crypto.subtle.importKey(
        'raw',
        enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    )
}

async function hmacB64Url(secret, message) {
    const key = await importHmacKey(secret)
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message))
    return b64url(new Uint8Array(sig))
}

function b64url(bytes) {
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s) {
    const pad = '='.repeat((4 - (s.length % 4)) % 4)
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
}

const SESSION_COOKIE = '__edit'
const SESSION_TTL_S = 7 * 24 * 60 * 60
const STATE_TTL_MS = 10 * 60 * 1000

export function setSessionCookie(sessionId) {
    return `${SESSION_COOKIE}=${sessionId}; Path=/; Max-Age=${SESSION_TTL_S}; HttpOnly; Secure; SameSite=Lax`
}

export function clearSessionCookie() {
    return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

function readCookie(req, name) {
    const header = req.headers.get('cookie') ?? ''
    for (const part of header.split(';')) {
        const [k, ...rest] = part.trim().split('=')
        if (k === name) return rest.join('=')
    }
    return null
}

export function readSessionId(req) {
    return readCookie(req, SESSION_COOKIE)
}

const sessionKey = (id) => `sess:${id}`

export async function getSession(req, env) {
    const id = readSessionId(req)
    if (!id) return null
    const raw = await env.OAUTH_KV.get(sessionKey(id))
    if (!raw) return null
    try {
        const s = JSON.parse(raw)
        if (s?.expiresAt && s.expiresAt < Date.now()) return null
        return s
    } catch {
        return null
    }
}

export async function createSession(env, { login, accessToken }) {
    const bytes = new Uint8Array(32)
    crypto.getRandomValues(bytes)
    const id = b64url(bytes)
    const record = {
        login,
        accessToken,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TTL_S * 1000,
    }
    await env.OAUTH_KV.put(sessionKey(id), JSON.stringify(record), {
        expirationTtl: SESSION_TTL_S,
    })
    return id
}

export async function deleteSession(env, id) {
    if (!id) return
    await env.OAUTH_KV.delete(sessionKey(id))
}

// Signed, short-lived OAuth state. Holds whatever JSON-serializable context
// (browser `next` URL, MCP authorize request, etc.) we need on the callback.
export async function signState(secret, payload) {
    const body = JSON.stringify({ ...payload, exp: Date.now() + STATE_TTL_MS })
    const b = b64url(enc.encode(body))
    const sig = await hmacB64Url(secret, b)
    return `${b}.${sig}`
}

export async function verifyState(secret, value) {
    if (typeof value !== 'string') return null
    const dot = value.indexOf('.')
    if (dot < 0) return null
    const b = value.slice(0, dot)
    const sig = value.slice(dot + 1)
    const expected = await hmacB64Url(secret, b)
    if (!constantTimeEqual(sig, expected)) return null
    let parsed
    try {
        parsed = JSON.parse(new TextDecoder().decode(fromB64url(b)))
    } catch {
        return null
    }
    if (!parsed?.exp || parsed.exp < Date.now()) return null
    return parsed
}
