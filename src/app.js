import { Hono } from 'hono'
import { mountEditRoutes } from './edit.js'
import { mountSetupRoutes } from './setup.js'
import { serveSite } from './site.js'

const app = new Hono()
app.get('/healthz', (c) => c.json({ ok: true }))
mountSetupRoutes(app) // /__setup, /__setup/callback, /__setup/installed
mountEditRoutes(app) // /__login, /__edit/*
app.all('*', (c) => serveSite(c.req.raw, c.env))

export default { fetch: app.fetch.bind(app) }
