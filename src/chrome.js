// Shared HTML chrome for worker-rendered pages (login, /__setup, errors).
// Inherits the brand stylesheet from the site (Alliance fonts, color tokens),
// served from /assets/.

export const escapeAttr = (s) =>
    String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

export function page(title, body, { variant = 'card' } = {}) {
    return `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeAttr(title)} · Svengali</title>
<link rel="stylesheet" href="/assets/styles.css">
<link rel="icon" href="/assets/icon-01-ad58af7111.svg" type="image/svg+xml">
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{
    font-family:var(--font-body);
    font-size:var(--text-base);
    line-height:var(--leading-normal);
    letter-spacing:var(--tracking-tight);
    color:var(--color-fg);
    background:var(--color-bg);
    display:grid;
    place-items:center;
    padding:var(--space-5);
  }
  main{
    width:min(440px,100%);
    background:#fff;
    border:var(--border-thin);
    border-radius:14px;
    padding:var(--space-7) var(--space-6) var(--space-6);
  }
  .logo{
    display:block;
    width:32px;
    height:auto;
    margin-bottom:var(--space-5);
    opacity:0.85;
  }
  h1{
    font-family:var(--font-display);
    font-size:var(--text-xl);
    font-weight:500;
    letter-spacing:var(--tracking-tight);
    line-height:var(--leading-tight);
    margin-bottom:var(--space-3);
  }
  p{
    color:var(--color-muted);
    font-size:var(--text-base);
    line-height:var(--leading-snug);
    margin-bottom:var(--space-4);
  }
  p:last-child{margin-bottom:0}
  a{color:var(--color-fg);text-decoration:underline;text-underline-offset:3px}
  a:hover{color:var(--color-accent)}
  code{
    font-family:var(--font-mono);
    font-size:var(--text-sm);
    background:var(--color-bg);
    padding:2px 6px;
    border-radius:4px;
  }
  pre{
    font-family:var(--font-mono);
    font-size:12px;
    line-height:var(--leading-snug);
    background:var(--color-bg);
    padding:var(--space-3);
    border-radius:6px;
    overflow:auto;
    color:var(--color-muted);
    margin-top:var(--space-4);
  }
  .btn{
    display:inline-flex;
    align-items:center;
    gap:var(--space-2);
    background:var(--color-fg);
    color:#fff;
    border:0;
    border-radius:999px;
    padding:12px 22px;
    font:inherit;
    font-weight:500;
    cursor:pointer;
    text-decoration:none;
    transition:background var(--duration-fast) var(--easing);
  }
  .btn:hover{background:var(--color-accent);color:#fff}
  .btn-secondary{background:transparent;color:var(--color-fg);border:1px solid var(--color-line)}
  .btn-secondary:hover{background:var(--color-bg);color:var(--color-fg)}
  .actions{display:flex;gap:var(--space-3);margin-top:var(--space-5);flex-wrap:wrap}
  .field{position:relative;border-bottom:1px solid var(--color-fg);margin-bottom:var(--space-5)}
  .field input{
    width:100%;font:inherit;font-size:var(--text-lg);
    padding:12px 40px 12px 0;border:0;background:transparent;outline:0;color:var(--color-fg);
  }
  .field input::placeholder{color:var(--color-muted)}
  .field button{
    position:absolute;right:0;top:50%;transform:translateY(-50%);
    background:none;border:0;padding:6px 2px;
    font:inherit;font-size:22px;line-height:1;color:var(--color-fg);cursor:pointer;
    transition:opacity var(--duration-fast),transform var(--duration-base) var(--easing);
  }
  .field button:hover{opacity:0.6;transform:translateY(-50%) translateX(3px)}
  .err{
    color:#b91c1c;
    font-size:var(--text-sm);
    margin-bottom:var(--space-3);
    padding:var(--space-2) var(--space-3);
    background:rgba(185,28,28,0.06);
    border-radius:6px;
  }
  details{font-size:var(--text-sm);color:var(--color-muted);margin-top:var(--space-5)}
  details summary{cursor:pointer;user-select:none}
  details form{margin-top:var(--space-3)}
  details button{font:inherit;font-size:var(--text-sm);background:transparent;
    color:#b91c1c;border:1px solid var(--color-line);border-radius:6px;
    padding:6px 12px;cursor:pointer}
  details button:hover{background:rgba(185,28,28,0.06)}
  ${variant === 'plain' ? 'main{background:transparent;border:0;padding:0}' : ''}
</style>
</head><body><main>${body}</main></body></html>`
}

const LOGO = '<img class="logo" src="/assets/icon-01-ad58af7111.svg" alt="">'

export function brandPage(title, body, opts) {
    return page(title, LOGO + body, opts)
}
