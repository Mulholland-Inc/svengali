// One-time GitHub App provisioning via the manifest flow.
//
//   GET /__setup
//     Renders a self-submitting POST form whose action is
//     https://github.com/organizations/<owner>/settings/apps/new — body
//     contains a JSON manifest. User clicks "Create" once on github.com.
//
//   GET /__setup/callback?code=...
//     GitHub bounces back here with a temporary code. We exchange it for the
//     App's permanent credentials (App ID, private key, client secret), stash
//     them in KV, then show a one-button "Install" link.
//
//   GET /__setup/installed?installation_id=...
//     GitHub sends the user here after they install the App. We capture
//     installation_id and redirect to /__login.

import {
    convertManifest,
    findInstallationId,
    getAppConfig,
    patchAppConfig,
    putAppConfig,
} from './github.js'

const escapeAttr = (s) =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

function buildManifest(env, origin) {
    return {
        name: 'Mulholland Svengali',
        url: origin,
        hook_attributes: { url: `${origin}/__webhook`, active: false },
        redirect_url: `${origin}/__setup/callback`,
        callback_urls: [`${origin}/__edit/callback`],
        setup_url: `${origin}/__setup/installed`,
        public: false,
        request_oauth_on_install: true,
        default_permissions: { contents: 'write', metadata: 'read' },
        default_events: [],
    }
}

export function mountSetupRoutes(app) {
    app.get('/__setup', async (c) => {
        const cfg = await getAppConfig(c.env)
        const origin = new URL(c.req.url).origin

        if (cfg?.installationId) {
            return c.html(
                page(
                    'Already configured',
                    `<h1>Already configured</h1>
<p>Svengali is set up and installed. <a href="/__login">Sign in</a> to start editing.</p>
<details style="margin-top:32px"><summary>Reset (start over)</summary>
<form method="post" action="/__setup/reset" style="margin-top:12px">
<button type="submit">Wipe app config from KV</button>
</form></details>`,
                ),
            )
        }

        if (cfg?.appId && !cfg?.installationId) {
            return c.html(
                page(
                    'Install the App',
                    `<h1>App created</h1>
<p>Now install <strong>${escapeAttr(cfg.slug)}</strong> on the
<strong>${escapeAttr(c.env.GITHUB_OWNER)}</strong> org so it can read and write
<code>${escapeAttr(c.env.GITHUB_REPO)}</code>.</p>
<p style="margin-top:24px">
  <a class="btn" href="${escapeAttr(cfg.htmlUrl)}/installations/new">Install on ${escapeAttr(c.env.GITHUB_OWNER)} →</a>
</p>`,
                ),
            )
        }

        const manifest = JSON.stringify(buildManifest(c.env, origin))
        const action = `https://github.com/organizations/${encodeURIComponent(c.env.GITHUB_OWNER)}/settings/apps/new`
        return c.html(
            page(
                'Create the GitHub App',
                `<h1>Create the GitHub App</h1>
<p>Click below; GitHub creates an App named "Svengali", scoped to read/write
contents on <code>${escapeAttr(c.env.GITHUB_OWNER)}/${escapeAttr(c.env.GITHUB_REPO)}</code>,
and bounces you back here.</p>
<form method="post" action="${escapeAttr(action)}" style="margin-top:24px">
  <input type="hidden" name="manifest" value="${escapeAttr(manifest)}">
  <button class="btn" type="submit">Create GitHub App →</button>
</form>`,
            ),
        )
    })

    app.get('/__setup/callback', async (c) => {
        const code = c.req.query('code')
        if (!code) return c.html(page('Setup error', `<h1>Missing code</h1>`), 400)
        try {
            const conv = await convertManifest(code)
            const config = {
                appId: conv.id,
                slug: conv.slug,
                name: conv.name,
                ownerLogin: conv.owner?.login ?? c.env.GITHUB_OWNER,
                htmlUrl: conv.html_url,
                clientId: conv.client_id,
                clientSecret: conv.client_secret,
                privateKey: conv.pem,
                webhookSecret: conv.webhook_secret ?? null,
                installationId: null,
            }
            await putAppConfig(c.env, config)
        } catch (e) {
            return c.html(
                page('Setup error', `<h1>Conversion failed</h1><pre>${escapeAttr(e.message)}</pre>`),
                500,
            )
        }
        return Response.redirect(`${new URL(c.req.url).origin}/__setup`, 302)
    })

    app.get('/__setup/installed', async (c) => {
        const installationId = c.req.query('installation_id')
        try {
            let id = installationId
            if (!id) id = await findInstallationId(c.env, c.env.GITHUB_OWNER)
            if (!id) {
                return c.html(
                    page(
                        'Setup error',
                        `<h1>Couldn't find the installation</h1>
<p>The App is created but doesn't appear to be installed on
<code>${escapeAttr(c.env.GITHUB_OWNER)}</code>. Visit
<a href="/__setup">/__setup</a> to retry the install.</p>`,
                    ),
                    500,
                )
            }
            await patchAppConfig(c.env, { installationId: Number(id) })
        } catch (e) {
            return c.html(
                page('Setup error', `<h1>Install lookup failed</h1><pre>${escapeAttr(e.message)}</pre>`),
                500,
            )
        }
        return Response.redirect(`${new URL(c.req.url).origin}/__login`, 302)
    })

    app.post('/__setup/reset', async (c) => {
        await c.env.OAUTH_KV.delete('app_config')
        await c.env.OAUTH_KV.delete('install_token')
        return Response.redirect(`${new URL(c.req.url).origin}/__setup`, 302)
    })
}

function page(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)} · Svengali</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,system-ui,"SF Pro Display",sans-serif;font-size:16px;
  color:#1e2124;background:#fff;display:grid;place-items:center;min-height:100vh;padding:24px;line-height:1.5}
main{width:min(520px,100%)}
h1{font-size:28px;font-weight:500;letter-spacing:-0.02em;margin-bottom:18px}
p{color:#5a5d63;margin-bottom:14px}
code{font-family:ui-monospace,Menlo,monospace;font-size:14px;color:#1e2124;background:#f3f4f6;padding:2px 6px;border-radius:4px}
.btn,a.btn{display:inline-block;background:#1e2124;color:#fff;text-decoration:none;
  border:0;border-radius:999px;padding:12px 22px;font:inherit;font-weight:500;cursor:pointer}
.btn:hover{opacity:0.85}
details{font-size:14px;color:#9a9a9a}
details summary{cursor:pointer}
details button{font:inherit;font-size:14px;background:transparent;color:#b91c1c;border:1px solid #e5e7eb;border-radius:8px;padding:6px 10px;cursor:pointer}
pre{font-family:ui-monospace,Menlo,monospace;font-size:13px;background:#f3f4f6;padding:12px;border-radius:6px;overflow:auto}
</style></head><body><main>${body}</main></body></html>`
}
