import {
    getSession,
    createSession,
    deleteSession,
    readSessionId,
    setSessionCookie,
    clearSessionCookie,
    signState,
    verifyState,
} from './util.js'
import {
    readFile,
    commitFiles,
    exchangeOAuthCode,
    checkRepoPushAccess,
    getAppConfig,
    patchAppConfig,
    listTree,
} from './github.js'
import { brandPage, escapeAttr } from './chrome.js'

// 'list' is a pseudo-attribute that means "this whole list/section's innerHTML
// changed" — used for structural ops (add/remove/reorder items).
const ALLOWED_ATTRS = new Set(['href', 'src', 'alt', 'list'])
const escapeAttrValue = (s) => String(s).replace(/"/g, '\\"')

function selectorFor(edit) {
    const key = escapeAttrValue(edit.key)
    if (!edit.attr) return `[data-edit="${key}"]`
    if (edit.attr === 'list') return `[data-edit-list="${key}"]`
    return `[data-edit-${edit.attr}="${key}"]`
}

class SetInner {
    constructor(html) {
        this.html = html
    }
    element(el) {
        el.setInnerContent(this.html, { html: true })
    }
}

class SetAttr {
    constructor(attr, value) {
        this.attr = attr
        this.value = value
    }
    element(el) {
        el.setAttribute(this.attr, this.value)
    }
}

// Apply a set of edits (mix of innerHTML and attribute edits) to one file,
// returning the new bytes. Edits whose key is not present in this file are
// silently skipped — that lets the caller fan out the same edit list across
// every HTML file in the repo for cross-page sync. If `bytes` are passed in
// (from a previous read), skip the network round-trip.
export async function applyEditsInMemory(env, repoPath, edits, bytes) {
    if (!bytes) bytes = await readFile(env, repoPath)
    if (!bytes) throw new Error(`No file at ${repoPath}`)
    const res = new Response(bytes, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    let rewriter = new HTMLRewriter()
    for (const e of edits) {
        const value = String(e.value ?? '')
        if (!e.attr || e.attr === 'list') {
            rewriter = rewriter.on(selectorFor(e), new SetInner(value))
        } else {
            rewriter = rewriter.on(selectorFor(e), new SetAttr(e.attr, value))
        }
    }
    return new Uint8Array(await rewriter.transform(res).arrayBuffer())
}

// Find every HTML file in the repo whose contents reference any of the given
// (key, attr) pairs. Used to fan out cross-page edits.
async function filesContainingKeys(env, edits) {
    const all = await listTree(env)
    const html = all.filter((b) => b.path.endsWith('.html') || b.path.endsWith('.htm'))
    const matches = new Map() // path → bytes (reused later by applyEditsInMemory)
    const targets = edits.map((e) => {
        const key = escapeAttrValue(e.key)
        const attrName = !e.attr ? 'data-edit' : `data-edit-${e.attr}`
        return new RegExp(`${attrName}\\s*=\\s*"${key}"`)
    })
    await Promise.all(
        html.map(async (b) => {
            const bytes = await readFile(env, b.path)
            if (!bytes) return
            const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
            if (targets.some((re) => re.test(text))) matches.set(b.path, bytes)
        }),
    )
    return matches
}

async function startBrowserOAuth(c, next) {
    const cfg = await getAppConfig(c.env)
    if (!cfg?.clientId) {
        return c.html(setupNeededPage(), 503)
    }
    const state = await signState(c.env.COOKIE_SECRET, { kind: 'browser', next: next || '/' })
    const url = new URL('https://github.com/login/oauth/authorize')
    url.searchParams.set('client_id', cfg.clientId)
    url.searchParams.set('state', state)
    url.searchParams.set(
        'redirect_uri',
        `${new URL(c.req.url).origin}/__edit/callback`,
    )
    return Response.redirect(url.toString(), 302)
}

export function mountEditRoutes(app) {
    app.get('/__login', (c) => startBrowserOAuth(c, c.req.query('next') ?? '/'))

    app.get('/__edit/callback', async (c) => {
        const code = c.req.query('code')
        const state = c.req.query('state')
        const installationId = c.req.query('installation_id')
        if (!code) return c.text('Missing code', 400)

        // Post-install flow (manifest had `request_oauth_on_install: true`):
        // GitHub combines install completion with an OAuth grant, so we get
        // code + installation_id but no signed state. Capture the install id
        // into app_config; otherwise verify the signed state we minted.
        let next = '/'
        if (installationId && !state) {
            await patchAppConfig(c.env, { installationId: Number(installationId) })
        } else {
            if (!state) return c.text('Missing state', 400)
            const decoded = await verifyState(c.env.COOKIE_SECRET, state)
            if (!decoded) return c.text('Bad or expired state', 400)
            if (typeof decoded.next === 'string' && decoded.next.startsWith('/')) {
                next = decoded.next
            }
        }

        let token
        try {
            const tokenRes = await exchangeOAuthCode(c.env, code)
            token = tokenRes.access_token
        } catch (e) {
            return c.text(`OAuth: ${e.message}`, 401)
        }

        const access = await checkRepoPushAccess(c.env, token)
        if (!access.ok) {
            return c.html(noAccessPage(c.env.GITHUB_OWNER, c.env.GITHUB_REPO), 403)
        }

        const sessionId = await createSession(c.env, { login: access.login, accessToken: token })
        const headers = new Headers()
        headers.set('set-cookie', setSessionCookie(sessionId))
        headers.set('location', next)
        return new Response(null, { status: 302, headers })
    })

    // Fetch a component template from `_components/`, with `{{id}}` placeholders
    // replaced by a random short id so newly-inserted items get unique
    // data-edit keys. Used by the editor when adding items / sections.
    app.get('/__edit/template', async (c) => {
        const session = await getSession(c.req.raw, c.env)
        if (!session) return c.text('Unauthorized', 401)
        const path = String(c.req.query('path') ?? '')
        if (!path.startsWith('/_components/') || !path.endsWith('.html') || path.includes('..')) {
            return c.text('Bad path', 400)
        }
        const repoPath = path.slice(1)
        const bytes = await readFile(c.env, repoPath)
        if (!bytes) return c.text('Template not found', 404)
        const id = `it_${Math.random().toString(36).slice(2, 8)}`
        const html = new TextDecoder().decode(bytes).replace(/\{\{id\}\}/g, id)
        return c.json({ html, id })
    })

    // Upload a binary asset to the repo (commits to /assets/ by default).
    app.post('/__edit/upload', async (c) => {
        const session = await getSession(c.req.raw, c.env)
        if (!session) return c.text('Unauthorized', 401)
        let form
        try {
            form = await c.req.formData()
        } catch {
            return c.text('Bad form', 400)
        }
        const file = form.get('file')
        if (!file || typeof file === 'string') return c.text('Missing file', 400)
        const dir = String(form.get('dir') || 'assets').replace(/^\/+|\/+$/g, '') || 'assets'
        const path = `${dir}/${slugifyFilename(file.name)}`
        const bytes = new Uint8Array(await file.arrayBuffer())
        if (!bytes.byteLength) return c.text('Empty file', 400)
        try {
            const result = await commitFiles(
                c.env,
                [{ path, bytes }],
                `upload ${path} (${bytes.byteLength}B)`,
                session.accessToken,
            )
            return c.json({ ok: true, path: `/${path}`, bytes: bytes.byteLength, ...result })
        } catch (err) {
            return c.text(String(err?.message ?? err), 500)
        }
    })

    app.post('/__edit/logout', async (c) => {
        const id = readSessionId(c.req.raw)
        await deleteSession(c.env, id)
        const headers = new Headers()
        headers.set('set-cookie', clearSessionCookie())
        return new Response(null, { status: 204, headers })
    })

    app.post('/__edit/save', async (c) => {
        const session = await getSession(c.req.raw, c.env)
        if (!session) return c.text('Unauthorized', 401)

        let payload
        try {
            payload = await c.req.json()
        } catch {
            return c.text('Bad JSON', 400)
        }
        const edits = Array.isArray(payload?.edits) ? payload.edits : []
        if (edits.length === 0) return c.text('Nothing to save', 400)

        for (const e of edits) {
            if (typeof e?.key !== 'string' || typeof e?.value !== 'string') {
                return c.text('Bad edit shape', 400)
            }
            if (e.attr != null && !ALLOWED_ATTRS.has(e.attr)) {
                return c.text(`Disallowed attribute: ${e.attr}`, 400)
            }
        }

        try {
            const targetMap = await filesContainingKeys(c.env, edits)
            if (!targetMap.size) return c.text('No matching keys found', 404)

            const files = await Promise.all(
                [...targetMap.entries()].map(async ([path, bytes]) => ({
                    path,
                    bytes: await applyEditsInMemory(c.env, path, edits, bytes),
                })),
            )

            const targetPaths = [...targetMap.keys()]
            const keys = edits
                .map((e) => (e.attr ? `${e.key}@${e.attr}` : e.key))
                .join(', ')
            const fileSummary =
                targetPaths.length === 1 ? targetPaths[0] : `${targetPaths.length} files`
            const result = await commitFiles(
                c.env,
                files,
                `edit ${fileSummary}: ${keys}`,
                session.accessToken,
            )
            return c.json({
                ok: true,
                applied: edits.length,
                files: targetPaths.length,
                paths: targetPaths,
                ...result,
            })
        } catch (err) {
            return c.text(String(err?.message ?? err), 500)
        }
    })
}

function slugifyFilename(name) {
    const dot = name.lastIndexOf('.')
    const base = dot >= 0 ? name.slice(0, dot) : name
    const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
    const cleaned = base
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'file'
    return cleaned + ext
}

function setupNeededPage() {
    return brandPage(
        'Setup needed',
        `<h1>Setup needed</h1>
<p>Svengali isn't configured yet. Register the GitHub App to start.</p>
<div class="actions"><a class="btn" href="/__setup">Open setup →</a></div>`,
    )
}

function noAccessPage(owner, repo) {
    return brandPage(
        'No push access',
        `<h1>No push access</h1>
<p>Your GitHub account doesn't have push access to <code>${escapeAttr(owner)}/${escapeAttr(repo)}</code>. Ask the owner to add you as a collaborator and try again.</p>`,
    )
}
