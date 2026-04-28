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
    // Re-collapse worker-injected include sentinels so the source file's
    // <include> tags survive structural edits.
    function markListDirty(list) {
        var key = list.getAttribute('data-edit-list');
        if (!key) return;
        var html = list.innerHTML.replace(
            /<!--include:start src="([^"]+)"(?: id="([^"]+)")?-->[\\s\\S]*?<!--include:end-->/g,
            function (_, src, id) {
                return id
                    ? '<include src="' + src + '" id="' + id + '"></include>'
                    : '<include src="' + src + '"></include>';
            },
        );
        setDirty(key, 'list', html);
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

        // Surface "Open link" first so navigation is one click away.
        var anchor = target && target.closest && target.closest('a[href]');
        if (anchor && !anchor.closest('#__edit-bar') && !anchor.closest('#__edit-menu')) {
            (function (a) {
                out.push({
                    label: 'Open link',
                    sub: a.getAttribute('href'),
                    run: function () { location.href = a.getAttribute('href'); },
                });
            })(anchor);
        }

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
                var itemTpls = listTemplates(list);
                if (itemTpls.length === 1) {
                    (function (l, i, tpl) {
                        out.push({
                            label: tpl.label + ' below',
                            sub: listKey,
                            run: function () { addItem(l, 'after', i, tpl.path); },
                        });
                    })(list, item, itemTpls[0]);
                } else if (itemTpls.length > 1) {
                    (function (l, i, tpls) {
                        out.push({
                            label: 'Insert below…',
                            sub: listKey,
                            run: function () { showPicker(l, 'after', i, tpls); },
                        });
                    })(list, item, itemTpls);
                }
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
                if (tpls.length === 1) {
                    (function (l, tpl) {
                        out.push({
                            label: tpl.label,
                            sub: listKey,
                            run: function () { addItem(l, 'end', null, tpl.path); },
                        });
                    })(list, tpls[0]);
                } else if (tpls.length > 1) {
                    (function (l, all) {
                        out.push({
                            label: 'Add section…',
                            sub: listKey,
                            run: function () { showPicker(l, 'end', null, all); },
                        });
                    })(list, tpls);
                }
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

    var picker = null;
    function closePicker() { if (picker) { picker.remove(); picker = null; } }

    // Centered modal for picking from many templates. Used when a list has
    // more than one template — keeps the right-click menu compact.
    function showPicker(list, position, refItem, templates) {
        closePicker();
        picker = document.createElement('div');
        picker.id = '__edit-picker';
        var backdrop = document.createElement('div');
        backdrop.className = '__edit-picker-backdrop';
        backdrop.addEventListener('click', closePicker);
        picker.appendChild(backdrop);

        var card = document.createElement('div');
        card.className = '__edit-picker-card';
        var header = document.createElement('header');
        header.textContent = position === 'after' ? 'Insert below' : 'Add section';
        card.appendChild(header);

        var input = document.createElement('input');
        input.type = 'search';
        input.placeholder = 'Filter…';
        input.autocomplete = 'off';
        input.spellcheck = false;
        card.appendChild(input);

        var listEl = document.createElement('div');
        listEl.className = '__edit-picker-list';
        templates.forEach(function (t) {
            var row = document.createElement('button');
            row.type = 'button';
            row.dataset.label = (t.label || '').toLowerCase();
            row.dataset.path = (t.path || '').toLowerCase();
            var label = document.createElement('span');
            label.textContent = t.label;
            var path = document.createElement('em');
            path.textContent = t.path;
            row.appendChild(label);
            row.appendChild(path);
            row.addEventListener('click', function () {
                closePicker();
                addItem(list, position, refItem, t.path);
            });
            listEl.appendChild(row);
        });
        card.appendChild(listEl);

        input.addEventListener('input', function () {
            var q = input.value.trim().toLowerCase();
            listEl.querySelectorAll('button').forEach(function (b) {
                var match = !q || b.dataset.label.indexOf(q) >= 0 || b.dataset.path.indexOf(q) >= 0;
                b.style.display = match ? '' : 'none';
            });
        });
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') closePicker();
            if (e.key === 'Enter') {
                var first = listEl.querySelector('button:not([style*="display: none"])');
                if (first) first.click();
            }
        });

        picker.appendChild(card);
        document.body.appendChild(picker);
        setTimeout(function () { input.focus(); }, 0);
    }
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && picker) closePicker();
    });

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
        // Suppress link navigation while in edit mode — right-click is the
        // way to interact. Modifier-clicks (Cmd, Ctrl, Shift, Alt, middle
        // mouse) fall through so users can still open links in new tabs.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        var a = e.target && e.target.closest && e.target.closest('a[href]');
        if (a && !a.closest('#__edit-bar') && !a.closest('#__edit-menu')) {
            e.preventDefault();
        }
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
    // Brand-flat editor chrome — no rounded corners, 1px borders in
    // --color-line, --space-* tokens for spacing, Alliance body for UI text,
    // JetBrains Mono italic for keys (matches the .mono helper on the marketing site).
    style.textContent = [
        '#__edit-bar{',
        '  position:fixed;bottom:var(--space-5,24px);right:var(--space-5,24px);z-index:99999;',
        '  display:flex;align-items:stretch;',
        '  background:#fff;color:var(--color-fg,#1a1a1a);',
        '  border:1px solid var(--color-line,rgba(160,160,160,0.5));',
        '  font-family:var(--font-body,system-ui,sans-serif);',
        '  font-size:var(--text-sm,13px);line-height:1;',
        '}',
        '#__edit-bar #__edit-count{',
        '  display:flex;align-items:center;padding:0 var(--space-4,16px);',
        '  color:var(--color-muted,#a0a0a0);',
        '  font-family:var(--font-mono,ui-monospace,Menlo,monospace);',
        '  font-style:italic;font-variant-numeric:tabular-nums;',
        '  border-right:1px solid var(--color-line,rgba(160,160,160,0.5));',
        '}',
        '#__edit-bar.has-changes #__edit-count{color:var(--color-fg,#1a1a1a)}',
        '#__edit-bar button{',
        '  font:inherit;border:0;cursor:pointer;',
        '  padding:var(--space-3,12px) var(--space-4,16px);',
        '  border-right:1px solid var(--color-line,rgba(160,160,160,0.5));',
        '  transition:background 120ms var(--easing,ease),color 120ms var(--easing,ease);',
        '}',
        '#__edit-bar button:last-child{border-right:0}',
        '#__edit-save{background:var(--color-fg,#1a1a1a);color:#fff;font-weight:500}',
        '#__edit-save:hover{background:var(--color-accent,#2244ff)}',
        '#__edit-bar.has-changes #__edit-save{background:var(--color-accent,#2244ff)}',
        '#__edit-bar.has-changes #__edit-save:hover{filter:brightness(0.9)}',
        '#__edit-save[disabled]{opacity:0.45;cursor:default;background:var(--color-fg,#1a1a1a)!important}',
        '#__edit-logout{',
        '  background:transparent;color:var(--color-muted,#a0a0a0);',
        '  padding:0 var(--space-4,16px);font-size:var(--text-base,15px);',
        '}',
        '#__edit-logout:hover{color:var(--color-fg,#1a1a1a);background:var(--color-bg,#ebebeb)}',

        // Tagged elements: thin solid hairline that goes solid-fg on hover and
        // accent on focus. Matches the marketing site\'s use of --color-line.
        '.__edit-tag{outline:1px solid var(--color-line,rgba(160,160,160,0.5));',
        '  outline-offset:2px;cursor:context-menu;',
        '  transition:outline-color 120ms var(--easing,ease)}',
        '.__edit-tag:hover{outline-color:var(--color-fg,#1a1a1a)}',
        '[contenteditable].__edit-tag:focus{',
        '  outline:1px solid var(--color-accent,#2244ff);',
        '  background:#fff;cursor:text}',

        '#__edit-menu{',
        '  position:fixed;z-index:100000;',
        '  background:#fff;color:var(--color-fg,#1a1a1a);',
        '  border:1px solid var(--color-line,rgba(160,160,160,0.5));',
        '  padding:0;min-width:240px;',
        '  font-family:var(--font-body,system-ui,sans-serif);',
        '  font-size:var(--text-sm,13px);display:flex;flex-direction:column;',
        '}',
        '#__edit-menu button{',
        '  background:transparent;color:var(--color-fg,#1a1a1a);border:0;',
        '  padding:var(--space-3,12px) var(--space-4,16px);text-align:left;',
        '  font:inherit;cursor:pointer;line-height:1.25;',
        '  display:flex;flex-direction:column;align-items:flex-start;gap:var(--space-1,4px);',
        '  border-bottom:1px solid var(--color-line,rgba(160,160,160,0.5));',
        '  transition:background 80ms var(--easing,ease),color 80ms var(--easing,ease);',
        '}',
        '#__edit-menu button:last-child{border-bottom:0}',
        '#__edit-menu button em{',
        '  font-style:italic;font-weight:400;',
        '  color:var(--color-muted,#a0a0a0);',
        '  font-family:var(--font-mono,ui-monospace,Menlo,monospace);',
        '  font-size:var(--text-sm,13px);',
        '}',
        '#__edit-menu button:hover{background:var(--color-bg,#ebebeb)}',
        '#__edit-menu button:hover em{color:var(--color-fg,#1a1a1a)}',
        '#__edit-menu button.danger{color:#b91c1c}',
        '#__edit-menu button.danger:hover{background:#fff;color:#fff;background-color:#b91c1c}',
        '#__edit-menu button.danger:hover em{color:rgba(255,255,255,0.7)}',
        '#__edit-menu hr{display:none}', // we use border-bottom on each row instead

        // Centered modal picker for "Add section" with many options.
        '#__edit-picker{position:fixed;inset:0;z-index:100001;display:flex;align-items:center;justify-content:center;padding:var(--space-5,24px)}',
        '#__edit-picker .__edit-picker-backdrop{position:absolute;inset:0;background:rgba(26,26,26,0.32)}',
        '#__edit-picker .__edit-picker-card{position:relative;background:#fff;color:var(--color-fg,#1a1a1a);',
        '  border:1px solid var(--color-line,rgba(160,160,160,0.5));',
        '  width:min(520px,100%);max-height:min(560px,80vh);',
        '  display:flex;flex-direction:column;font-family:var(--font-body,system-ui,sans-serif)}',
        '#__edit-picker header{padding:var(--space-4,16px) var(--space-4,16px) var(--space-3,12px);',
        '  border-bottom:1px solid var(--color-line,rgba(160,160,160,0.5));',
        '  font-family:var(--font-mono,ui-monospace,Menlo,monospace);',
        '  font-style:italic;font-size:var(--text-sm,13px);color:var(--color-muted,#a0a0a0);',
        '  text-transform:uppercase;letter-spacing:0.04em}',
        '#__edit-picker input[type=search]{',
        '  appearance:none;-webkit-appearance:none;',
        '  width:100%;border:0;border-bottom:1px solid var(--color-line,rgba(160,160,160,0.5));',
        '  padding:var(--space-3,12px) var(--space-4,16px);background:transparent;',
        '  font:inherit;font-size:var(--text-base,15px);color:var(--color-fg,#1a1a1a);',
        '  outline:0}',
        '#__edit-picker input[type=search]::placeholder{color:var(--color-muted,#a0a0a0)}',
        '#__edit-picker input[type=search]:focus{border-bottom-color:var(--color-accent,#2244ff)}',
        '#__edit-picker .__edit-picker-list{overflow-y:auto;flex:1;min-height:0}',
        '#__edit-picker .__edit-picker-list button{',
        '  display:flex;align-items:baseline;gap:var(--space-3,12px);',
        '  width:100%;padding:var(--space-3,12px) var(--space-4,16px);',
        '  border:0;border-bottom:1px solid var(--color-line,rgba(160,160,160,0.5));',
        '  background:transparent;color:var(--color-fg,#1a1a1a);text-align:left;',
        '  font:inherit;font-size:var(--text-sm,13px);cursor:pointer;',
        '  transition:background 80ms var(--easing,ease)}',
        '#__edit-picker .__edit-picker-list button:last-child{border-bottom:0}',
        '#__edit-picker .__edit-picker-list button:hover{background:var(--color-bg,#ebebeb)}',
        '#__edit-picker .__edit-picker-list button em{',
        '  font-style:italic;color:var(--color-muted,#a0a0a0);',
        '  font-family:var(--font-mono,ui-monospace,Menlo,monospace);',
        '  font-size:var(--text-sm,13px);margin-left:auto;text-align:right}',
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
