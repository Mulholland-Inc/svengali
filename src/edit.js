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

const ALLOWED_ATTRS = new Set(['href', 'src', 'alt'])
const escapeAttrValue = (s) => String(s).replace(/"/g, '\\"')

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
// every HTML file in the repo for cross-page sync.
export async function applyEditsInMemory(env, repoPath, edits) {
    const bytes = await readFile(env, repoPath)
    if (!bytes) throw new Error(`No file at ${repoPath}`)
    const res = new Response(bytes, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    let rewriter = new HTMLRewriter()
    for (const e of edits) {
        const key = escapeAttrValue(e.key)
        if (!e.attr) {
            rewriter = rewriter.on(`[data-edit="${key}"]`, new SetInner(String(e.value ?? '')))
        } else {
            rewriter = rewriter.on(
                `[data-edit-${e.attr}="${key}"]`,
                new SetAttr(e.attr, String(e.value ?? '')),
            )
        }
    }
    return new Uint8Array(await rewriter.transform(res).arrayBuffer())
}

// Find every HTML file in the repo whose contents reference any of the given
// (key, attr) pairs. Used to fan out cross-page edits.
async function filesContainingKeys(env, edits) {
    const all = await listTree(env)
    const html = all.filter((p) => p.endsWith('.html') || p.endsWith('.htm'))
    const matches = new Set()
    const targets = edits.map((e) => {
        const key = escapeAttrValue(e.key)
        return e.attr
            ? new RegExp(`data-edit-${e.attr}\\s*=\\s*"${key}"`)
            : new RegExp(`data-edit\\s*=\\s*"${key}"`)
    })
    await Promise.all(
        html.map(async (path) => {
            const bytes = await readFile(env, path)
            if (!bytes) return
            const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
            if (targets.some((re) => re.test(text))) matches.add(path)
        }),
    )
    return [...matches]
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

        // Post-install flow (manifest had `request_oauth_on_install: true`).
        // GitHub combines installation completion with an OAuth grant, so we
        // get `code` + `installation_id` but no `state`. Capture the install
        // id into app_config and sign the user in.
        let decoded
        if (installationId && !state) {
            await patchAppConfig(c.env, { installationId: Number(installationId) })
            decoded = { kind: 'browser', next: '/' }
        } else {
            if (!state) return c.text('Missing state', 400)
            decoded = await verifyState(c.env.COOKIE_SECRET, state)
            if (!decoded) return c.text('Bad or expired state', 400)
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
            return c.html(
                noAccessPage(c.env.GITHUB_OWNER, c.env.GITHUB_REPO),
                403,
            )
        }

        if (decoded.kind === 'mcp') {
            const provider = c.env.OAUTH_PROVIDER
            if (!provider) return c.text('OAuth provider missing', 500)
            const { redirectTo } = await provider.completeAuthorization({
                request: decoded.oauthReq,
                userId: access.login,
                metadata: { login: access.login },
                scope: decoded.oauthReq?.scope ?? ['mcp'],
                props: { login: access.login, accessToken: token },
            })
            return Response.redirect(redirectTo, 302)
        }

        // Browser flow → mint a session and bounce back to wherever they were.
        const sessionId = await createSession(c.env, { login: access.login, accessToken: token })
        const headers = new Headers()
        headers.set('set-cookie', setSessionCookie(sessionId))
        const next = typeof decoded.next === 'string' && decoded.next.startsWith('/')
            ? decoded.next
            : '/'
        headers.set('location', next)
        return new Response(null, { status: 302, headers })
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
            const targetPaths = await filesContainingKeys(c.env, edits)
            if (!targetPaths.length) return c.text('No matching keys found', 404)

            const files = await Promise.all(
                targetPaths.map(async (path) => ({
                    path,
                    bytes: await applyEditsInMemory(c.env, path, edits),
                })),
            )

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

function setupNeededPage() {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Setup needed</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;padding:60px;color:#1e2124;line-height:1.5;max-width:480px;margin:0 auto}
a{color:#1e2124}</style></head><body>
<h1>Setup needed</h1>
<p>Svengali isn't configured yet. Visit <a href="/__setup">/__setup</a> to register the GitHub App.</p>
</body></html>`
}

function noAccessPage(owner, repo) {
    return `<!doctype html><html><head><meta charset="utf-8"><title>No access</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;padding:60px;color:#1e2124;line-height:1.5;max-width:480px;margin:0 auto}
code{font-family:ui-monospace,Menlo,monospace;background:#f3f4f6;padding:2px 6px;border-radius:4px}</style></head><body>
<h1>No push access</h1>
<p>Your GitHub account doesn't have push access to <code>${owner}/${repo}</code>.
Ask the owner to add you as a collaborator and try again.</p>
</body></html>`
}
