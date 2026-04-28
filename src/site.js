import { getSession } from './util.js'
import { EDITOR_CLIENT } from './editor-client.js'
import { readFile } from './github.js'

const CONTENT_TYPES = {
    html: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'application/javascript; charset=utf-8',
    mjs: 'application/javascript; charset=utf-8',
    json: 'application/json; charset=utf-8',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    ico: 'image/x-icon',
    mp4: 'video/mp4',
    webm: 'video/webm',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    txt: 'text/plain; charset=utf-8',
}

const MAX_INCLUDE_DEPTH = 4

function contentTypeFor(path) {
    const dot = path.lastIndexOf('.')
    const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
    return CONTENT_TYPES[ext] ?? 'application/octet-stream'
}

// URL path → repo path.
//   /            -> index.html
//   /manifesto   -> manifesto.html  (tried as a fallback when there's no extension)
//   /styles.css  -> styles.css
export function pathToKey(pathname) {
    let p = decodeURIComponent(pathname)
    if (p.startsWith('/')) p = p.slice(1)
    if (p === '' || p.endsWith('/')) p = p + 'index.html'
    return p
}

async function resolve(env, pathname) {
    const direct = pathToKey(pathname)
    const bytes = await readFile(env, direct)
    if (bytes) return { path: direct, bytes }
    if (!direct.includes('.')) {
        const html = await readFile(env, `${direct}.html`)
        if (html) return { path: `${direct}.html`, bytes: html }
    }
    return null
}

// Replace every <include src="…"></include> with the referenced file's
// contents, recursively. Lets pages share chrome (nav, footer) by living
// in a single source file.
class IncludeReplacer {
    constructor(env, depth) {
        this.env = env
        this.depth = depth
    }
    async element(el) {
        const src = el.getAttribute('src')
        if (!src) {
            el.remove()
            return
        }
        const path = src.replace(/^\/+/, '')
        const bytes = await readFile(this.env, path)
        if (!bytes) {
            el.replace(`<!-- include "${src}" not found -->`, { html: true })
            return
        }
        let text = new TextDecoder().decode(bytes)
        if (this.depth > 0) text = await expandIncludes(this.env, text, this.depth - 1)
        el.replace(text, { html: true })
    }
}

export async function expandIncludes(env, html, depth = MAX_INCLUDE_DEPTH) {
    if (!html.includes('<include')) return html
    const res = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    return new HTMLRewriter()
        .on('include[src]', new IncludeReplacer(env, depth))
        .transform(res)
        .text()
}

class EditorInjector {
    element(el) {
        el.append(`<script>${EDITOR_CLIENT}</script>`, { html: true })
    }
}

export async function serveSite(req, env) {
    const url = new URL(req.url)

    // Hide chrome partials — they're for include resolution, not direct viewing.
    if (url.pathname.startsWith('/_chrome/') || url.pathname.startsWith('/_chrome')) {
        return new Response('Not found', { status: 404 })
    }

    // Clean URLs: redirect /foo.html → /foo, /index.html → /.
    if (url.pathname.endsWith('.html')) {
        const stripped = url.pathname.slice(0, -'.html'.length)
        const target = stripped === '/index' ? '/' : stripped
        return Response.redirect(`${url.origin}${target}${url.search}`, 301)
    }

    const hit = await resolve(env, url.pathname)
    if (!hit) return new Response('Not found', { status: 404 })

    const ct = contentTypeFor(hit.path)
    if (!ct.startsWith('text/html')) {
        return new Response(hit.bytes, { headers: { 'content-type': ct } })
    }

    let html = new TextDecoder().decode(hit.bytes)
    html = await expandIncludes(env, html)

    const headers = {
        'content-type': ct,
        // HTML must vary on cookie because we inject the editor for authed users.
        'cache-control': 'no-store',
        vary: 'cookie',
    }
    let response = new Response(html, { headers })
    if (await getSession(req, env)) {
        response = new HTMLRewriter().on('body', new EditorInjector()).transform(response)
    }
    return response
}
