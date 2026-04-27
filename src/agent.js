// MCP agent — exposes the same edit primitives as the browser editor, gated
// by the OAuth wrapper in app.js. Same shared password.

import { McpAgent } from 'agents/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { readFile, listTree, commitFiles } from './github.js'
import { applyEditsInMemory } from './edit.js'

const text = (t) => ({ content: [{ type: 'text', text: t }] })

const isHtml = (p) => p.endsWith('.html') || p.endsWith('.htm')

// Pull every [data-edit="…"] key out of an HTML buffer.
async function extractKeys(bytes) {
    const keys = []
    const seen = new Set()
    const res = new Response(bytes, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    await new HTMLRewriter()
        .on('[data-edit]', {
            element(el) {
                const k = el.getAttribute('data-edit')
                if (k && !seen.has(k)) {
                    seen.add(k)
                    keys.push(k)
                }
            },
        })
        .transform(res)
        .arrayBuffer()
    return keys
}

// Capture the current inner HTML of [data-edit="key"] in `bytes`.
async function readKey(bytes, key) {
    let captured = null
    const safe = String(key).replace(/"/g, '\\"')
    const res = new Response(bytes, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    await new HTMLRewriter()
        .on(`[data-edit="${safe}"]`, {
            element(el) {
                captured = ''
            },
            text(t) {
                if (captured !== null) captured += t.text
            },
        })
        .transform(res)
        .arrayBuffer()
    return captured
}

export class EditorAgent extends McpAgent {
    server = new McpServer({ name: 'Svengali', version: '0.1.0' })

    async init() {
        if (this._initPromise) return this._initPromise
        this._initPromise = this._doInit()
        return this._initPromise
    }

    async _doInit() {
        this.server = new McpServer({
            name: 'Svengali',
            title: 'Svengali',
            version: '0.1.0',
            description:
                'Edit the marketing site over MCP. Files live in GitHub; every set_value commits.',
        })

        const safe = (fn) => {
            try {
                return fn()
            } catch (e) {
                if (/already registered/i.test(e?.message ?? '')) return
                throw e
            }
        }
        const tool = (...args) => safe(() => this.server.registerTool(...args))

        tool(
            'list_files',
            {
                title: 'List files',
                description:
                    'Return every editable HTML file in the site. Use the result paths with list_keys/get_value/set_value.',
                inputSchema: {},
                annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
            },
            async () => {
                const all = await listTree(this.env)
                const html = all.filter(isHtml).sort()
                if (!html.length) return text('No HTML files in the repo.')
                return text(html.map((p) => `  ${p}`).join('\n'))
            },
        )

        tool(
            'list_keys',
            {
                title: 'List edit keys',
                description:
                    'Return every [data-edit="…"] key on a page. The path is a repo-relative HTML path (e.g. "index.html").',
                inputSchema: { path: z.string() },
                annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
            },
            async ({ path }) => {
                const bytes = await readFile(this.env, path)
                if (!bytes) throw new Error(`No file at ${path}`)
                const keys = await extractKeys(bytes)
                if (!keys.length) return text(`${path}: no [data-edit] keys.`)
                return text(`${path}:\n${keys.map((k) => `  ${k}`).join('\n')}`)
            },
        )

        tool(
            'get_value',
            {
                title: 'Get value',
                description: 'Return the current inner text of [data-edit="<key>"] on a page.',
                inputSchema: { path: z.string(), key: z.string() },
                annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
            },
            async ({ path, key }) => {
                const bytes = await readFile(this.env, path)
                if (!bytes) throw new Error(`No file at ${path}`)
                const value = await readKey(bytes, key)
                if (value === null) throw new Error(`No [data-edit="${key}"] in ${path}`)
                return text(value)
            },
        )

        tool(
            'set_value',
            {
                title: 'Set value',
                description:
                    'Edit content tagged with [data-edit] (or [data-edit-href|src|alt]) and commit to GitHub. Pass attr="href"/"src"/"alt" to edit attributes; omit attr to replace inner HTML. Returns the commit SHA.',
                inputSchema: {
                    path: z.string(),
                    key: z.string(),
                    value: z.string(),
                    attr: z.enum(['href', 'src', 'alt']).optional(),
                },
                annotations: {
                    readOnlyHint: false,
                    destructiveHint: false,
                    idempotentHint: true,
                    openWorldHint: false,
                },
            },
            async ({ path, key, value, attr }) => {
                if (!isHtml(path)) throw new Error('Can only edit .html files.')
                const userToken = this.props?.accessToken
                if (!userToken) throw new Error('Missing user access token on session.')
                const bytes = await applyEditsInMemory(this.env, path, [
                    { key, attr: attr ?? null, value },
                ])
                const label = attr ? `${key}@${attr}` : key
                const result = await commitFiles(
                    this.env,
                    [{ path, bytes }],
                    `mcp set_value: ${path} (${label})`,
                    userToken,
                )
                return text(`Committed ${result.commitSha.slice(0, 7)} — ${result.url}`)
            },
        )
    }
}
