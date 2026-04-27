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

class EditorInjector {
    element(el) {
        el.append(`<script>${EDITOR_CLIENT}</script>`, { html: true })
    }
}

export async function serveSite(req, env) {
    const url = new URL(req.url)
    const hit = await resolve(env, url.pathname)
    if (!hit) return new Response('Not found', { status: 404 })

    const ct = contentTypeFor(hit.path)
    const headers = {
        'content-type': ct,
        // HTML must vary on cookie because we inject the editor for authed users.
        ...(ct.startsWith('text/html') ? { 'cache-control': 'no-store', vary: 'cookie' } : {}),
    }
    const res = new Response(hit.bytes, { headers })

    if (!ct.startsWith('text/html')) return res
    if (!(await getSession(req, env))) return res

    return new HTMLRewriter().on('body', new EditorInjector()).transform(res)
}
