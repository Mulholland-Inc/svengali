// Inlined into every HTML response when the visitor has a valid edit cookie.
//
// Convention:
//   <h1 data-edit="hero.title">…</h1>            inner-HTML edit (contenteditable)
//   <a  data-edit-href="cta.url" href="…">…     href edit (right-click)
//   <img data-edit-src="hero.image" src="…">    src edit (right-click)
//   <img data-edit-alt="hero.alt" alt="…">      alt edit (right-click)
//
// Same key on multiple pages = same content. The server applies each edit to
// every HTML file containing that key, in one atomic commit.
export const EDITOR_CLIENT = `
(function () {
    if (window.__svengaliEditor) return;
    window.__svengaliEditor = true;

    var dirty = new Map(); // key|attr → {key, attr, value}
    function setDirty(key, attr, value) {
        dirty.set(key + '\\u0000' + (attr || ''), { key: key, attr: attr || null, value: value });
        bar.classList.add('has-changes');
        count.textContent = dirty.size + ' edit' + (dirty.size === 1 ? '' : 's');
    }

    var ATTR_MAP = { 'data-edit-href': 'href', 'data-edit-src': 'src', 'data-edit-alt': 'alt' };

    function activate() {
        // Inner-text edits — contenteditable on every [data-edit].
        document.querySelectorAll('[data-edit]').forEach(function (el) {
            el.setAttribute('contenteditable', 'true');
            el.setAttribute('spellcheck', 'true');
            el.classList.add('__edit-tag');
            el.addEventListener('input', function () {
                setDirty(el.getAttribute('data-edit'), null, el.innerHTML);
            });
            el.addEventListener('paste', function (e) {
                e.preventDefault();
                var t = (e.clipboardData || window.clipboardData).getData('text/plain');
                document.execCommand('insertText', false, t);
            });
            if (el.tagName === 'A') {
                el.addEventListener('click', function (e) { e.preventDefault(); });
            }
        });

        // Mark attribute-tagged elements visually too — no buttons.
        Object.keys(ATTR_MAP).forEach(function (attrName) {
            document.querySelectorAll('[' + attrName + ']').forEach(function (el) {
                el.classList.add('__edit-tag');
            });
        });
    }

    // ── right-click menu ────────────────────────────────────────────
    // Walk up the ancestor chain and aggregate every editable target.
    // This way right-clicking a <span data-edit="…"> inside an
    // <a data-edit-href="…"> shows both "Edit text" and "Edit href".
    function collectOptions(node) {
        var out = [];
        while (node && node !== document) {
            if (node.nodeType === 1) {
                if (node.hasAttribute('data-edit')) {
                    (function (el) {
                        out.push({
                            label: 'Edit text',
                            sub: el.getAttribute('data-edit'),
                            run: function () { focusText(el); },
                        });
                    })(node);
                }
                for (var attrName in ATTR_MAP) {
                    if (node.hasAttribute(attrName)) {
                        (function (el, name, attr) {
                            out.push({
                                label: 'Edit ' + attr,
                                sub: el.getAttribute(name),
                                run: function () { editAttr(el, name, attr); },
                            });
                        })(node, attrName, ATTR_MAP[attrName]);
                    }
                }
            }
            node = node.parentNode;
        }
        return out;
    }

    function focusText(el) {
        el.focus();
        var sel = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function editAttr(el, attrName, attr) {
        var key = el.getAttribute(attrName);
        var current = el.getAttribute(attr) || '';
        var next = window.prompt('Set ' + attr + ' for "' + key + '":', current);
        if (next == null || next === current) return;
        el.setAttribute(attr, next);
        setDirty(key, attr, next);
    }

    var menu = null;
    function closeMenu() { if (menu) { menu.remove(); menu = null; } }

    document.addEventListener('contextmenu', function (e) {
        var opts = collectOptions(e.target);
        if (!opts.length) return; // let browser show its native menu
        e.preventDefault();
        closeMenu();
        menu = document.createElement('div');
        menu.id = '__edit-menu';
        opts.forEach(function (o) {
            var b = document.createElement('button');
            b.type = 'button';
            var label = document.createElement('span');
            label.textContent = o.label;
            var sub = document.createElement('em');
            sub.textContent = o.sub;
            b.appendChild(label);
            b.appendChild(sub);
            b.addEventListener('click', function () { closeMenu(); o.run(); });
            menu.appendChild(b);
        });
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        document.body.appendChild(menu);
    });
    document.addEventListener('click', function (e) {
        if (menu && !menu.contains(e.target)) closeMenu();
    });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeMenu();
    });

    // ── floating bar ────────────────────────────────────────────────
    var bar = document.createElement('div');
    bar.id = '__edit-bar';
    bar.innerHTML =
        '<span id="__edit-count">0 edits</span>' +
        '<button id="__edit-save" type="button">Save</button>' +
        '<button id="__edit-logout" type="button" title="Log out">×</button>';
    var style = document.createElement('style');
    style.textContent =
        '#__edit-bar{position:fixed;bottom:18px;right:18px;z-index:99999;display:flex;align-items:center;gap:10px;' +
        'background:#1e2124;color:#fff;border-radius:999px;padding:8px 8px 8px 16px;' +
        'font:500 13px/1 -apple-system,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,0.18)}' +
        '#__edit-bar #__edit-count{opacity:0.55;letter-spacing:0.01em}' +
        '#__edit-bar.has-changes #__edit-count{opacity:1;color:#7ddc8c}' +
        '#__edit-bar button{font:inherit;border:0;border-radius:999px;padding:8px 14px;cursor:pointer}' +
        '#__edit-save{background:#fff;color:#1e2124}' +
        '#__edit-save[disabled]{opacity:0.4;cursor:default}' +
        '#__edit-logout{background:transparent;color:#fff;padding:4px 8px;font-size:16px;line-height:1}' +
        '.__edit-tag{outline:1px dashed rgba(0,0,0,0.18);outline-offset:2px;cursor:context-menu}' +
        '.__edit-tag:hover{outline-color:rgba(30,33,36,0.55)}' +
        '[contenteditable].__edit-tag:focus{outline:2px solid #1e2124;background:#fffbe6;cursor:text}' +
        '#__edit-menu{position:fixed;z-index:100000;background:#1e2124;color:#fff;border-radius:8px;' +
        'padding:4px;box-shadow:0 8px 24px rgba(0,0,0,0.25);min-width:140px;' +
        'font:500 13px/1 -apple-system,system-ui,sans-serif;display:flex;flex-direction:column}' +
        '#__edit-menu button{background:transparent;color:#fff;border:0;padding:8px 12px;text-align:left;' +
        'font:inherit;cursor:pointer;border-radius:5px;display:flex;flex-direction:column;align-items:flex-start;gap:2px;line-height:1.2}' +
        '#__edit-menu button em{font-style:normal;font-weight:400;font-size:11px;opacity:0.5;font-family:ui-monospace,Menlo,monospace}' +
        '#__edit-menu button:hover{background:rgba(255,255,255,0.12)}';
    document.head.appendChild(style);
    document.body.appendChild(bar);

    var count = bar.querySelector('#__edit-count');
    var save = bar.querySelector('#__edit-save');
    var logout = bar.querySelector('#__edit-logout');

    save.addEventListener('click', async function () {
        if (dirty.size === 0) return;
        save.disabled = true;
        save.textContent = 'Saving…';
        var edits = Array.from(dirty.values());
        try {
            var res = await fetch('/__edit/save', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ from: location.pathname, edits: edits }),
            });
            if (!res.ok) throw new Error(await res.text());
            var data = await res.json().catch(function () { return {}; });
            dirty.clear();
            bar.classList.remove('has-changes');
            count.textContent = data.files
                ? 'Saved (' + data.files + ' file' + (data.files === 1 ? '' : 's') + ')'
                : 'Saved';
            save.textContent = 'Save';
            setTimeout(function () { count.textContent = '0 edits'; }, 1800);
        } catch (e) {
            count.textContent = 'Error';
            save.textContent = 'Save';
            console.error(e);
        } finally {
            save.disabled = false;
        }
    });

    logout.addEventListener('click', async function () {
        await fetch('/__edit/logout', { method: 'POST' });
        location.reload();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', activate);
    } else {
        activate();
    }
})();
`
