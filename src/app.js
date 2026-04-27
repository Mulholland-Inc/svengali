import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import { Hono } from 'hono'
import { mountEditRoutes } from './edit.js'
import { mountOAuthRoutes } from './oauth.js'
import { mountSetupRoutes } from './setup.js'
import { serveSite } from './site.js'
import { EditorAgent } from './agent.js'

export { EditorAgent }

function buildDefaultHandler() {
    const app = new Hono()
    app.get('/healthz', (c) => c.json({ ok: true }))
    mountSetupRoutes(app) // /__setup, /__setup/callback, /__setup/installed
    mountOAuthRoutes(app) // GET /authorize (MCP)
    mountEditRoutes(app) // /__login, /__edit/*
    // Everything else is the site itself.
    app.all('*', (c) => serveSite(c.req.raw, c.env))
    return { fetch: app.fetch.bind(app) }
}

const apiHandler = EditorAgent.serve('/mcp', { binding: 'EDITOR_AGENT' })

const provider = new OAuthProvider({
    apiRoute: ['/mcp'],
    apiHandler,
    defaultHandler: buildDefaultHandler(),
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    scopesSupported: ['mcp'],
    accessTokenTTL: 3600,
    refreshTokenTTL: 30 * 24 * 60 * 60,
})

export default {
    fetch(request, env, ctx) {
        return provider.fetch(request, env, ctx)
    },
}
