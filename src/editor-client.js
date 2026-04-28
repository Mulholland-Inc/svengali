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

    // Mark a [data-edit-list] container as dirty: capture its current innerHTML.
    // Called after any structural mutation (add/remove/move) on items inside.
    function markListDirty(list) {
        var key = list.getAttribute('data-edit-list');
        if (!key) return;
        setDirty(key, 'list', list.innerHTML);
    }

    function listAncestor(node) {
        while (node && node !== document) {
            if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute('data-edit-list')) {
                return node;
            }
            node = node.parentNode;
        }
        return null;
    }

    // Find the immediate child of "list" that contains "node". That child is
    // the item we move/remove. (Lists are usually <ul>; items <li>. But the
    // convention works for any containing element.)
    function itemInList(list, node) {
        var n = node;
        while (n && n !== list && n.parentNode !== list) n = n.parentNode;
        return n && n.parentNode === list ? n : null;
    }

    async function fetchTemplate(path) {
        var res = await fetch('/__edit/template?path=' + encodeURIComponent(path));
        if (!res.ok) throw new Error(await res.text());
        return res.json();
    }

    function activateItem(item) {
        // Newly-inserted items need their tagged elements wired up too.
        item.querySelectorAll('[data-edit]').forEach(function (el) {
            if (el.getAttribute('contenteditable') === 'true') return;
            el.setAttribute('contenteditable', 'true');
            el.setAttribute('spellcheck', 'true');
            el.classList.add('__edit-tag');
            el.addEventListener('input', function () {
                setDirty(el.getAttribute('data-edit'), null, el.innerHTML);
            });
            if (el.tagName === 'A') {
                el.addEventListener('click', function (e) { e.preventDefault(); });
            }
        });
        Object.keys(ATTR_MAP).forEach(function (attrName) {
            item.querySelectorAll('[' + attrName + ']').forEach(function (el) {
                el.classList.add('__edit-tag');
            });
        });
    }

    function listTemplates(list) {
        // Multi-template lists declare an array via data-edit-list-templates
        // (JSON: [{label,path},...]). Single-template lists use the singular
        // data-edit-list-template attribute. Returns an array of {label,path}.
        var raw = list.getAttribute('data-edit-list-templates');
        if (raw) {
            try {
                var parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) return parsed.filter(function (t) { return t && t.path; });
            } catch (e) {}
        }
        var single = list.getAttribute('data-edit-list-template');
        if (single) {
            return [{ label: list.getAttribute('data-edit-add-label') || 'Add item', path: single }];
        }
        return [];
    }

    async function addItem(list, position, refItem, templatePath) {
        var path = templatePath || (listTemplates(list)[0] || {}).path;
        if (!path) {
            window.alert('This list has no template configured.');
            return;
        }
        try {
            var data = await fetchTemplate(path);
            var wrap = document.createElement('div');
            wrap.innerHTML = data.html.trim();
            var nodes = Array.from(wrap.childNodes);
            nodes.forEach(function (n) {
                if (position === 'before' && refItem) list.insertBefore(n, refItem);
                else if (position === 'after' && refItem) list.insertBefore(n, refItem.nextSibling);
                else list.appendChild(n);
            });
            nodes.forEach(function (n) {
                if (n.nodeType === 1) activateItem(n);
            });
            markListDirty(list);
        } catch (e) {
            window.alert('Add failed: ' + e.message);
        }
    }

    function moveItem(list, item, dir) {
        if (dir === 'up' && item.previousElementSibling) {
            list.insertBefore(item, item.previousElementSibling);
        } else if (dir === 'down' && item.nextElementSibling) {
            list.insertBefore(item.nextElementSibling, item);
        } else {
            return;
        }
        markListDirty(list);
    }

    function removeItem(list, item) {
        item.remove();
        markListDirty(list);
    }

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
    // Right-clicking a <span data-edit="…"> inside an <a data-edit-href="…">
    // inside a <li data-edit-list-item> inside a <ul data-edit-list="…">
    // surfaces every applicable edit (text, href, item ops, list ops).
    function collectOptions(target) {
        var out = [];
        var node = target;
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
                            if (attr === 'src') {
                                out.push({
                                    label: 'Upload new file',
                                    sub: el.getAttribute(name),
                                    run: function () { uploadFile(el, name, attr); },
                                });
                            }
                        })(node, attrName, ATTR_MAP[attrName]);
                    }
                }
            }
            node = node.parentNode;
        }

        // List operations (move/remove/add) — drawn from the nearest
        // [data-edit-list] ancestor of the right-click target.
        var list = listAncestor(target);
        if (list) {
            var listKey = list.getAttribute('data-edit-list');
            var item = itemInList(list, target);
            if (item) {
                if (out.length) out.push({ divider: true });
                if (item.previousElementSibling) {
                    (function (l, i) {
                        out.push({
                            label: 'Move up',
                            sub: listKey,
                            run: function () { moveItem(l, i, 'up'); },
                        });
                    })(list, item);
                }
                if (item.nextElementSibling) {
                    (function (l, i) {
                        out.push({
                            label: 'Move down',
                            sub: listKey,
                            run: function () { moveItem(l, i, 'down'); },
                        });
                    })(list, item);
                }
                listTemplates(list).forEach(function (t) {
                    (function (l, i, tpl) {
                        out.push({
                            label: tpl.label + ' below',
                            sub: listKey,
                            run: function () { addItem(l, 'after', i, tpl.path); },
                        });
                    })(list, item, t);
                });
                (function (l, i) {
                    out.push({
                        label: 'Remove',
                        sub: listKey,
                        danger: true,
                        run: function () { removeItem(l, i); },
                    });
                })(list, item);
            } else {
                var tpls = listTemplates(list);
                if (tpls.length && out.length) out.push({ divider: true });
                tpls.forEach(function (t) {
                    (function (l, tpl) {
                        out.push({
                            label: tpl.label,
                            sub: listKey,
                            run: function () { addItem(l, 'end', null, tpl.path); },
                        });
                    })(list, t);
                });
            }
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

    function uploadFile(el, attrName, attr) {
        var input = document.createElement('input');
        input.type = 'file';
        var tag = el.tagName.toLowerCase();
        input.accept = tag === 'img' ? 'image/*' : tag === 'video' ? 'video/*' : '*/*';
        input.addEventListener('change', async function () {
            var file = input.files && input.files[0];
            if (!file) return;
            var key = el.getAttribute(attrName);
            count.textContent = 'Uploading…';
            var fd = new FormData();
            fd.append('file', file);
            try {
                var res = await fetch('/__edit/upload', { method: 'POST', body: fd });
                if (!res.ok) throw new Error(await res.text());
                var data = await res.json();
                el.setAttribute(attr, data.path);
                setDirty(key, attr, data.path);
                count.textContent = dirty.size + ' edit' + (dirty.size === 1 ? '' : 's');
            } catch (e) {
                count.textContent = 'Upload failed';
                window.alert('Upload failed: ' + e.message);
            }
        });
        input.click();
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
            if (o.divider) {
                menu.appendChild(document.createElement('hr'));
                return;
            }
            var b = document.createElement('button');
            b.type = 'button';
            if (o.danger) b.className = 'danger';
            var label = document.createElement('span');
            label.textContent = o.label;
            b.appendChild(label);
            if (o.sub) {
                var sub = document.createElement('em');
                sub.textContent = o.sub;
                b.appendChild(sub);
            }
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
    // Hooks into the brand tokens defined on :root in /assets/branding.css
    // (--color-fg, --color-bg, --color-accent, --font-body/display/mono, etc.)
    style.textContent = [
        '#__edit-bar{',
        '  position:fixed;bottom:var(--space-5,24px);right:var(--space-5,24px);z-index:99999;',
        '  display:flex;align-items:center;gap:var(--space-2,8px);',
        '  background:var(--color-fg,#1a1a1a);color:var(--color-bg,#ebebeb);',
        '  border-radius:8px;padding:var(--space-2,8px) var(--space-2,8px) var(--space-2,8px) var(--space-4,16px);',
        '  font-family:var(--font-body,system-ui,sans-serif);',
        '  font-size:13px;font-weight:500;letter-spacing:0.02em;line-height:1;',
        '  text-transform:uppercase;',
        '  box-shadow:0 1px 2px rgba(26,26,26,0.04),0 8px 32px rgba(26,26,26,0.18);',
        '}',
        '#__edit-bar #__edit-count{opacity:0.45;font-variant-numeric:tabular-nums;letter-spacing:0.04em}',
        '#__edit-bar.has-changes #__edit-count{opacity:1;color:var(--color-bg,#ebebeb)}',
        '#__edit-bar button{',
        '  font:inherit;letter-spacing:inherit;text-transform:inherit;',
        '  border:0;border-radius:6px;padding:8px 14px;cursor:pointer;',
        '  transition:background 120ms cubic-bezier(0.2,0,0,1),color 120ms cubic-bezier(0.2,0,0,1);',
        '}',
        '#__edit-save{background:var(--color-bg,#ebebeb);color:var(--color-fg,#1a1a1a)}',
        '#__edit-save:hover{background:var(--color-accent,#2244ff);color:#fff}',
        '#__edit-bar.has-changes #__edit-save{background:var(--color-accent,#2244ff);color:#fff}',
        '#__edit-bar.has-changes #__edit-save:hover{background:#3556ff}',
        '#__edit-save[disabled]{opacity:0.45;cursor:default;background:var(--color-bg,#ebebeb)!important;color:var(--color-fg,#1a1a1a)!important}',
        '#__edit-logout{background:transparent;color:var(--color-bg,#ebebeb);',
        '  padding:6px 9px;font-size:16px;line-height:1;opacity:0.5;text-transform:none}',
        '#__edit-logout:hover{opacity:1;background:rgba(235,235,235,0.1)}',

        '.__edit-tag{outline:1px dashed color-mix(in srgb,var(--color-accent,#2244ff) 30%,transparent);',
        '  outline-offset:3px;cursor:context-menu;',
        '  transition:outline-color 120ms cubic-bezier(0.2,0,0,1)}',
        '.__edit-tag:hover{outline-color:var(--color-accent,#2244ff)}',
        '[contenteditable].__edit-tag:focus{',
        '  outline:1.5px solid var(--color-accent,#2244ff);',
        '  background:color-mix(in srgb,var(--color-accent,#2244ff) 5%,transparent);',
        '  cursor:text}',

        '#__edit-menu{',
        '  position:fixed;z-index:100000;',
        '  background:#fff;color:var(--color-fg,#1a1a1a);',
        '  border:1px solid var(--color-line,rgba(160,160,160,0.5));',
        '  border-radius:8px;padding:var(--space-1,4px);',
        '  box-shadow:0 1px 2px rgba(26,26,26,0.04),0 12px 32px rgba(26,26,26,0.12);',
        '  min-width:220px;font-family:var(--font-body,system-ui,sans-serif);',
        '  font-size:13px;display:flex;flex-direction:column}',
        '#__edit-menu button{',
        '  background:transparent;color:var(--color-fg,#1a1a1a);border:0;',
        '  padding:8px var(--space-3,12px);text-align:left;font:inherit;cursor:pointer;',
        '  border-radius:5px;display:flex;flex-direction:column;align-items:flex-start;',
        '  gap:2px;line-height:1.25;',
        '  transition:background 80ms cubic-bezier(0.2,0,0,1),color 80ms cubic-bezier(0.2,0,0,1)}',
        '#__edit-menu button em{',
        '  font-style:normal;font-weight:400;font-size:11px;',
        '  color:var(--color-muted,#a0a0a0);',
        '  font-family:var(--font-mono,ui-monospace,Menlo,monospace);',
        '  letter-spacing:-0.005em}',
        '#__edit-menu button:hover{background:var(--color-bg,#ebebeb)}',
        '#__edit-menu button:hover em{color:var(--color-fg,#1a1a1a)}',
        '#__edit-menu button.danger{color:#b91c1c}',
        '#__edit-menu button.danger:hover{background:rgba(185,28,28,0.06)}',
        '#__edit-menu hr{border:0;border-top:1px solid var(--color-line,rgba(160,160,160,0.4));margin:4px 6px}',
    ].join('\\n');
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
