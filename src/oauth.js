// MCP /authorize handler. Delegates auth to GitHub OAuth — there's no
// password prompt anymore. We bounce the user to GitHub with the original
// MCP request encoded in our signed `state`; the shared /__edit/callback
// handler completes the OAuth grant once GitHub returns the user.

import { signState } from './util.js'
import { getAppConfig } from './github.js'

export function mountOAuthRoutes(app) {
    app.get('/authorize', async (c) => {
        const provider = c.env.OAUTH_PROVIDER
        if (!provider) return c.text('OAuth provider not configured.', 500)
        const oauthReq = await provider.parseAuthRequest(c.req.raw)

        const cfg = await getAppConfig(c.env)
        if (!cfg?.clientId) {
            return c.html(
                `<!doctype html><meta charset="utf-8"><title>Setup needed</title>
                <h1>Setup needed</h1>
                <p>Visit <a href="/__setup">/__setup</a> to register the GitHub App
                before authorizing MCP clients.</p>`,
                503,
            )
        }

        const state = await signState(c.env.COOKIE_SECRET, { kind: 'mcp', oauthReq })
        const url = new URL('https://github.com/login/oauth/authorize')
        url.searchParams.set('client_id', cfg.clientId)
        url.searchParams.set('state', state)
        url.searchParams.set('redirect_uri', `${new URL(c.req.url).origin}/__edit/callback`)
        return Response.redirect(url.toString(), 302)
    })
}
