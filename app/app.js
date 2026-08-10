/* Forkable app — router + views.
 *
 * Hash routing (#/browse, #/listing/<id>, …) so the whole thing is a static file
 * with no build step and no host-side rewrite rules. Swap to the History API and a
 * _redirects file when clean URLs matter more than zero config.
 *
 * No payments here: step 2 is auth + profiles + listing CRUD only. The buy button
 * deliberately dead-ends at an explanation rather than pretending to charge.
 */
(function () {
  'use strict';

  var DB = window.DB;
  var view = document.getElementById('view');
  var CATEGORY_LABELS = {
    scheduling: 'Scheduling', dashboard: 'Dashboard', intake_form: 'Intake form',
    payroll: 'Payroll', ai_integration: 'AI integration', other: 'Other'
  };
  var STATUS_LABELS = {
    draft: 'Draft', pending_review: 'Pending review', live: 'Live', delisted: 'Delisted'
  };

  /* ------------------------------------------------------------- helpers */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(cents) {
    return '$' + (Number(cents || 0) / 100).toFixed(Number(cents || 0) % 100 ? 2 : 0);
  }
  function el(id) { return document.getElementById(id); }
  function go(hash) { location.hash = hash; }
  function tagList(tags) {
    return (tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('');
  }
  function statusPill(s) {
    return '<span class="pill st-' + esc(s) + '">' + esc(STATUS_LABELS[s] || s) + '</span>';
  }
  function fail(e) {
    return '<div class="empty"><h3>Something broke</h3><p>' + esc(e.message || e) + '</p></div>';
  }

  /* ------------------------------------------------------------- chrome */
  function paintNav() {
    var u = DB.currentUser();
    var right = el('nav-right');
    var links = el('nav-links');
    var route = (location.hash || '#/browse').split('/')[1];

    links.innerHTML =
      '<a href="#/browse" class="' + (route === 'browse' || route === 'listing' ? 'on' : '') + '">Browse</a>' +
      (u ? '<a href="#/dashboard/seller" class="' + (location.hash.indexOf('seller') > -1 ? 'on' : '') + '">Selling</a>' +
           '<a href="#/dashboard/buyer" class="' + (location.hash.indexOf('buyer') > -1 ? 'on' : '') + '">Purchases</a>' : '');

    if (u) {
      right.innerHTML = '<span class="who" id="who">' + esc(u.email) + '</span>' +
                        '<button class="btn btn-quiet btn-sm" id="signout">Sign out</button>';
      el('signout').onclick = function () {
        DB.signOut().then(function () { paintNav(); go('#/browse'); render(); });
      };
    } else {
      right.innerHTML = '<a href="#/auth" class="btn btn-primary btn-sm">Sign in</a>';
    }
  }

  /* ------------------------------------------------------------- browse */
  var browseState = { q: '', category: '' };

  function viewBrowse() {
    view.innerHTML =
      '<div class="page-head"><div>' +
        '<h1>Browse tools</h1>' +
        '<p>Every listing has a live demo. Use it before you decide.</p>' +
      '</div></div>' +
      '<div class="filters">' +
        '<input id="q" type="search" placeholder="Search title, description, stack…" value="' + esc(browseState.q) + '">' +
        '<div class="chips" id="chips"></div>' +
      '</div>' +
      '<div id="results"><div class="empty"><p>Loading…</p></div></div>';

    var chips = el('chips');
    chips.innerHTML = ['', 'scheduling', 'dashboard', 'intake_form', 'payroll', 'ai_integration', 'other']
      .map(function (c) {
        return '<button class="chip" data-c="' + c + '" aria-pressed="' +
          (browseState.category === c) + '">' + (c ? CATEGORY_LABELS[c] : 'All') + '</button>';
      }).join('');

    chips.onclick = function (e) {
      var b = e.target.closest('.chip');
      if (!b) return;
      browseState.category = b.dataset.c;
      Array.prototype.forEach.call(chips.children, function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
      loadResults();
    };

    var t;
    el('q').oninput = function (e) {
      browseState.q = e.target.value;
      clearTimeout(t);
      t = setTimeout(loadResults, 180);
    };

    loadResults();
  }

  function loadResults() {
    var box = el('results');
    if (!box) return;
    DB.listListings({ q: browseState.q, category: browseState.category }).then(function (rows) {
      if (!box.isConnected) return;
      var live = rows.filter(function (l) { return l.status === 'live'; });
      if (!live.length) {
        box.innerHTML = '<div class="empty"><h3>Nothing here yet</h3>' +
          '<p>No live listings match that. Try clearing the filters.</p>' +
          '<a class="btn btn-ghost" href="#/dashboard/seller/new">List your own tool</a></div>';
        return;
      }
      box.innerHTML = '<div class="grid">' + live.map(function (l) {
        return '<a class="card" href="#/listing/' + esc(l.id) + '">' +
          '<div class="row-top">' +
            (l.demo_url ? '<span class="pill pill-live"><span class="dot"></span>live demo</span>' : '') +
            '<span class="pill">' + esc(CATEGORY_LABELS[l.category] || l.category) + '</span>' +
          '</div>' +
          '<h3>' + esc(l.title) + '</h3>' +
          '<p>' + esc(l.short_description) + '</p>' +
          '<div class="tags">' + tagList(l.tech_stack_tags) + '</div>' +
          '<div class="card-foot">' +
            '<span class="price">' + money(l.price_cents) + '</span>' +
            '<span class="pill">by ' + esc(l.seller_name || '—') + '</span>' +
          '</div></a>';
      }).join('') + '</div>';
    }).catch(function (e) { box.innerHTML = fail(e); });
  }

  /* ------------------------------------------------------------- listing detail */
  function viewListing(id) {
    view.innerHTML = '<div class="empty"><p>Loading…</p></div>';
    DB.getListing(id).then(function (l) {
      if (!l) {
        view.innerHTML = '<div class="empty"><h3>Listing not found</h3>' +
          '<p>It may be a draft, or delisted.</p><a class="btn btn-ghost" href="#/browse">Back to browse</a></div>';
        return;
      }
      var me = DB.currentUser();
      var mine = me && l.seller_id === me.id;

      view.innerHTML =
        '<div class="page-head"><div>' +
          '<div class="row-top" style="margin-bottom:9px">' +
            (l.demo_url ? '<span class="pill pill-live"><span class="dot"></span>live demo</span>' : '') +
            '<span class="pill">' + esc(CATEGORY_LABELS[l.category] || l.category) + '</span>' +
            (l.status !== 'live' ? statusPill(l.status) : '') +
          '</div>' +
          '<h1>' + esc(l.title) + '</h1>' +
          '<p>' + esc(l.short_description) + '</p>' +
        '</div>' +
        (mine ? '<div class="spacer"></div><a class="btn btn-quiet btn-sm" href="#/dashboard/seller/edit/' +
                esc(l.id) + '">Edit listing</a>' : '') +
        '</div>' +

        '<div class="detail"><div>' +
          '<div class="demo-box">' +
            (l.demo_url
              ? '<div class="demo-bar"><div class="lights"><i></i><i></i><i></i></div>' +
                  '<span>' + esc(l.demo_url) + '</span>' +
                  '<span style="margin-left:auto;color:var(--cyan)">● live sandbox</span></div>' +
                '<iframe class="demo-frame" title="Live demo" referrerpolicy="no-referrer" ' +
                  'sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" ' +
                  'src="' + esc(l.demo_url) + '"></iframe>' +
                '<div class="demo-note">Real running instance with demo data. ' +
                  '<a href="' + esc(l.demo_url) + '" target="_blank" rel="noopener">Open in a new tab ↗</a></div>'
              : '<div class="no-demo">No demo URL on this listing yet.<br>' +
                  'A listing without a working demo will not pass review.</div>') +
          '</div>' +

          (l.long_description ? '<div class="prose"><h2>What it is</h2>' +
            '<div class="body">' + esc(l.long_description) + '</div></div>' : '') +

          (l.setup_instructions ? '<div class="prose"><h2>Setup &amp; deploy</h2>' +
            '<div class="body">' + esc(l.setup_instructions) + '</div></div>' : '') +
        '</div>' +

        '<div class="side">' +
          '<div class="buybox">' +
            '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px">' +
              '<span class="price">' + money(l.price_cents) + '</span>' +
              '<span style="font-family:var(--mono);font-size:11px;color:var(--dimmer)">one-time</span>' +
            '</div>' +
            '<button class="btn btn-primary" style="width:100%" id="buy">Buy this tool</button>' +
            '<div class="msg" id="buy-msg"></div>' +
            '<div class="kv"><span>Seller</span><span>' + esc(l.seller_name || '—') + '</span></div>' +
            '<div class="kv"><span>Category</span><span>' + esc(CATEGORY_LABELS[l.category] || l.category) + '</span></div>' +
            '<div class="kv"><span>Repo access</span><span>' + (l.repo_url ? 'unlocked' : 'after purchase') + '</span></div>' +
          '</div>' +
          '<div class="guarantee"><b>Outcome guarantee</b>' +
            'If your deployment doesn\'t do what this demo just did, refund yourself within 14 days. ' +
            'The seller isn\'t paid until that window closes.</div>' +
          (l.tech_stack_tags && l.tech_stack_tags.length
            ? '<div><label>Stack</label><div class="tags">' + tagList(l.tech_stack_tags) + '</div></div>' : '') +
          (l.repo_url ? '<div><label>Repository</label><div class="tags">' +
            '<a class="tag" href="' + esc(l.repo_url) + '" target="_blank" rel="noopener">' +
            esc(l.repo_url) + ' ↗</a></div></div>' : '') +
        '</div></div>';

      el('buy').onclick = function () {
        var m = el('buy-msg');
        m.className = 'msg ok';
        m.textContent = 'Checkout lands in step 3 (Stripe Connect). Nothing was charged.';
      };
    }).catch(function (e) { view.innerHTML = fail(e); });
  }

  /* ------------------------------------------------------------- auth */
  function viewAuth() {
    var mode = 'signin', role = 'both';

    function paint() {
      view.innerHTML =
        '<div class="auth-wrap">' +
          '<h1>' + (mode === 'signin' ? 'Welcome back' : 'Create your account') + '</h1>' +
          '<p>One account. Buy tools, sell tools, or both.</p>' +
          '<div class="tabs">' +
            '<button id="t-in" aria-selected="' + (mode === 'signin') + '">Sign in</button>' +
            '<button id="t-up" aria-selected="' + (mode === 'signup') + '">Sign up</button>' +
          '</div>' +
          '<form id="f" class="card-form" novalidate>' +
            (mode === 'signup'
              ? '<div class="field"><label for="name">Display name</label>' +
                  '<input id="name" placeholder="How buyers see you"></div>' +
                '<div class="field"><label>I want to</label><div class="roles" id="roles">' +
                  '<button type="button" data-r="buyer" aria-pressed="false">Buy</button>' +
                  '<button type="button" data-r="seller" aria-pressed="false">Sell</button>' +
                  '<button type="button" data-r="both" aria-pressed="true">Both</button>' +
                '</div></div>'
              : '') +
            '<div class="field"><label for="email">Email</label>' +
              '<input id="email" type="email" autocomplete="email" placeholder="you@domain.com"></div>' +
            '<div class="field" style="margin-bottom:6px"><label for="pw">Password</label>' +
              '<input id="pw" type="password" autocomplete="' +
                (mode === 'signin' ? 'current-password' : 'new-password') + '" placeholder="••••••••">' +
              (mode === 'signup' ? '<div class="hint">At least 8 characters.</div>' : '') +
            '</div>' +
            '<button class="btn btn-primary" style="width:100%;margin-top:14px" id="go">' +
              (mode === 'signin' ? 'Sign in' : 'Create account') + '</button>' +
            '<div class="msg" id="m"></div>' +
          '</form>' +
        '</div>';

      el('t-in').onclick = function () { mode = 'signin'; paint(); };
      el('t-up').onclick = function () { mode = 'signup'; paint(); };

      if (mode === 'signup') {
        el('roles').onclick = function (e) {
          var b = e.target.closest('button[data-r]');
          if (!b) return;
          role = b.dataset.r;
          Array.prototype.forEach.call(this.children, function (x) {
            x.setAttribute('aria-pressed', String(x === b));
          });
        };
      }

      el('f').onsubmit = function (e) {
        e.preventDefault();
        var m = el('m'), btn = el('go');
        var email = el('email').value.trim();
        var pw = el('pw').value;

        function bad(t) { m.className = 'msg err'; m.textContent = t; }

        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad('That email doesn\'t look right.');
        if (mode === 'signup' && pw.length < 8) return bad('Password needs at least 8 characters.');
        if (!pw) return bad('Enter your password.');

        btn.disabled = true;
        m.className = 'msg';
        m.textContent = 'Working…';

        var p = mode === 'signin'
          ? DB.signIn(email, pw)
          : DB.signUp(email, pw, el('name').value.trim(), role);

        p.then(function () {
          if (!DB.currentUser()) {
            // Supabase with email confirmation on: account made, no session yet.
            btn.disabled = false;
            m.className = 'msg ok';
            m.textContent = 'Account created. Check your email to confirm, then sign in.';
            mode = 'signin';
            return;
          }
          paintNav();
          go('#/dashboard/seller');
        }).catch(function (err) {
          btn.disabled = false;
          bad(err.message || 'That didn\'t work.');
        });
      };
    }
    paint();
  }

  /* ------------------------------------------------------------- seller dashboard */
  function needAuth() {
    if (DB.currentUser()) return false;
    view.innerHTML = '<div class="empty"><h3>Sign in first</h3>' +
      '<p>You need an account to manage listings.</p>' +
      '<a class="btn btn-primary" href="#/auth">Sign in or sign up</a></div>';
    return true;
  }

  function viewSeller() {
    if (needAuth()) return;
    view.innerHTML = '<div class="empty"><p>Loading…</p></div>';

    DB.myListings().then(function (rows) {
      var live = rows.filter(function (l) { return l.status === 'live'; }).length;
      var drafts = rows.filter(function (l) { return l.status === 'draft'; }).length;
      var pending = rows.filter(function (l) { return l.status === 'pending_review'; }).length;

      view.innerHTML =
        '<div class="page-head"><div>' +
          '<h1>Selling</h1><p>Your listings. Payouts arrive with Stripe Connect in step 3.</p>' +
        '</div><div class="spacer"></div>' +
        '<a class="btn btn-primary" href="#/dashboard/seller/new">+ New listing</a></div>' +

        '<div class="stat-row">' +
          '<div class="stat"><div class="n">' + rows.length + '</div><div class="l">Listings</div></div>' +
          '<div class="stat"><div class="n">' + live + '</div><div class="l">Live</div></div>' +
          '<div class="stat"><div class="n">' + pending + '</div><div class="l">In review</div></div>' +
          '<div class="stat"><div class="n">' + drafts + '</div><div class="l">Drafts</div></div>' +
        '</div>' +

        (rows.length
          ? '<div class="tbl-wrap"><table><thead><tr>' +
              '<th>Listing</th><th>Category</th><th>Price</th><th>Demo</th><th>Status</th><th></th>' +
            '</tr></thead><tbody>' + rows.map(function (l) {
              return '<tr>' +
                '<td class="t-title">' + esc(l.title) +
                  '<small>updated ' + new Date(l.updated_at).toLocaleDateString() + '</small></td>' +
                '<td><span class="pill">' + esc(CATEGORY_LABELS[l.category] || l.category) + '</span></td>' +
                '<td style="font-family:var(--mono)">' + money(l.price_cents) + '</td>' +
                '<td>' + (l.demo_url
                  ? '<span class="pill pill-live"><span class="dot"></span>set</span>'
                  : '<span class="pill st-delisted">missing</span>') + '</td>' +
                '<td>' + statusPill(l.status) + '</td>' +
                '<td><div class="actions">' +
                  '<a class="btn btn-quiet btn-sm" href="#/listing/' + esc(l.id) + '">View</a>' +
                  '<a class="btn btn-ghost btn-sm" href="#/dashboard/seller/edit/' + esc(l.id) + '">Edit</a>' +
                '</div></td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<div class="empty"><h3>No listings yet</h3>' +
            '<p>List a tool you\'ve already built for a client. The demo is what sells it.</p>' +
            '<a class="btn btn-primary" href="#/dashboard/seller/new">Create your first listing</a></div>');
    }).catch(function (e) { view.innerHTML = fail(e); });
  }

  /* ------------------------------------------------------------- listing form */
  function viewListingForm(id) {
    if (needAuth()) return;
    var editing = !!id;

    function paint(l) {
      l = l || { category: 'other', status: 'draft', tech_stack_tags: [], price_cents: 0 };

      view.innerHTML =
        '<div class="page-head"><div>' +
          '<h1>' + (editing ? 'Edit listing' : 'New listing') + '</h1>' +
          '<p>' + (editing ? 'Changes go live as soon as you save.'
                           : 'Save as a draft, then submit for review when the demo works.') + '</p>' +
        '</div><div class="spacer"></div>' +
        '<a class="btn btn-quiet btn-sm" href="#/dashboard/seller">Back</a></div>' +

        '<form id="f" class="card-form">' +
          '<div class="field"><label for="title">Title</label>' +
            '<input id="title" value="' + esc(l.title) + '" placeholder="Shift Scheduler w/ AI Constraint Parser"></div>' +

          '<div class="field"><label for="short">Short description</label>' +
            '<input id="short" value="' + esc(l.short_description) + '" placeholder="One line a buyer skims in the grid.">' +
            '<div class="hint">Shown on the browse card. Keep it under ~140 characters.</div></div>' +

          '<div class="two">' +
            '<div class="field"><label for="cat">Category</label><select id="cat">' +
              DB.categories.map(function (c) {
                return '<option value="' + c + '"' + (l.category === c ? ' selected' : '') + '>' +
                  CATEGORY_LABELS[c] + '</option>';
              }).join('') + '</select></div>' +
            '<div class="field"><label for="price">Price (USD)</label>' +
              '<input id="price" type="number" min="0" step="1" value="' +
                (Number(l.price_cents || 0) / 100) + '">' +
              '<div class="hint">Most tools here land between $50 and $500.</div></div>' +
          '</div>' +

          '<div class="field"><label for="demo">Demo URL</label>' +
            '<input id="demo" value="' + esc(l.demo_url) + '" placeholder="https://your-demo.pages.dev">' +
            '<div class="hint">Public, seeded with fake data, and actually working. This is the whole pitch — ' +
              'a listing without one won\'t pass review.</div></div>' +

          '<div class="field"><label for="repo">Repo URL</label>' +
            '<input id="repo" value="' + esc(l.repo_url) + '" placeholder="https://github.com/you/template">' +
            '<div class="hint">Private. Buyers only see this after purchase.</div></div>' +

          '<div class="field"><label for="tags">Tech stack tags</label>' +
            '<input id="tags" value="' + esc((l.tech_stack_tags || []).join(', ')) + '" placeholder="React, Supabase, Stripe">' +
            '<div class="hint">Comma separated.</div></div>' +

          '<div class="field"><label for="long">Long description</label>' +
            '<textarea id="long" placeholder="What it does, who it\'s for, and why buying beats rebuilding.">' +
              esc(l.long_description) + '</textarea></div>' +

          '<div class="field"><label for="setup">Setup instructions (markdown)</label>' +
            '<textarea id="setup" class="code" placeholder="Env vars, accounts to create, deploy commands.">' +
              esc(l.setup_instructions) + '</textarea>' +
            '<div class="hint">Aim for under an hour from purchase to a working deployment.</div></div>' +

          '<div class="field"><label for="status">Status</label><select id="status">' +
            DB.statuses.map(function (s) {
              return '<option value="' + s + '"' + (l.status === s ? ' selected' : '') + '>' +
                STATUS_LABELS[s] + '</option>';
            }).join('') + '</select>' +
            '<div class="hint">A human reviews <em>pending review</em> listings before they go live.</div></div>' +

          '<div class="form-actions">' +
            '<button class="btn btn-primary" id="save">' + (editing ? 'Save changes' : 'Create listing') + '</button>' +
            (editing ? '<a class="btn btn-quiet" href="#/listing/' + esc(l.id) + '">View</a>' : '') +
            '<div class="spacer"></div>' +
            (editing ? '<button type="button" class="btn btn-danger" id="del">Delete</button>' : '') +
          '</div>' +
          '<div class="msg" id="m"></div>' +
        '</form>';

      function collect() {
        return {
          title: el('title').value.trim(),
          short_description: el('short').value.trim(),
          long_description: el('long').value.trim(),
          category: el('cat').value,
          price_cents: Math.round(Number(el('price').value || 0) * 100),
          demo_url: el('demo').value.trim() || null,
          repo_url: el('repo').value.trim() || null,
          setup_instructions: el('setup').value.trim() || null,
          tech_stack_tags: el('tags').value.split(',').map(function (t) { return t.trim(); })
            .filter(Boolean),
          status: el('status').value
        };
      }

      el('f').onsubmit = function (e) {
        e.preventDefault();
        var m = el('m'), btn = el('save');
        var data = collect();

        if (!data.title) { m.className = 'msg err'; m.textContent = 'Give it a title.'; return; }
        if (!data.short_description) {
          m.className = 'msg err'; m.textContent = 'A short description is what buyers skim.'; return;
        }
        if (data.status === 'live' && !data.demo_url) {
          m.className = 'msg err';
          m.textContent = 'A live listing needs a demo URL — that is the entire differentiator.';
          return;
        }

        btn.disabled = true;
        m.className = 'msg';
        m.textContent = 'Saving…';

        var p = editing ? DB.updateListing(id, data) : DB.createListing(data);
        p.then(function () { go('#/dashboard/seller'); })
         .catch(function (err) {
           btn.disabled = false;
           m.className = 'msg err';
           m.textContent = err.message;
         });
      };

      if (editing) {
        el('del').onclick = function () {
          if (!confirm('Delete "' + (l.title || 'this listing') + '"? This cannot be undone.')) return;
          DB.deleteListing(id).then(function () { go('#/dashboard/seller'); })
            .catch(function (err) {
              el('m').className = 'msg err';
              el('m').textContent = err.message;
            });
        };
      }
    }

    if (editing) {
      view.innerHTML = '<div class="empty"><p>Loading…</p></div>';
      DB.getListing(id).then(function (l) {
        if (!l) {
          view.innerHTML = '<div class="empty"><h3>Not found</h3>' +
            '<p>That listing doesn\'t exist, or isn\'t yours.</p>' +
            '<a class="btn btn-ghost" href="#/dashboard/seller">Back</a></div>';
          return;
        }
        paint(l);
      }).catch(function (e) { view.innerHTML = fail(e); });
    } else {
      paint(null);
    }
  }

  /* ------------------------------------------------------------- buyer dashboard */
  function viewBuyer() {
    if (needAuth()) return;
    DB.myPurchases().then(function (rows) {
      view.innerHTML =
        '<div class="page-head"><div><h1>Purchases</h1>' +
          '<p>Repo access, setup docs, and your refund window live here.</p></div></div>' +
        (rows.length
          ? '<div class="tbl-wrap"><table><thead><tr>' +
              '<th>Tool</th><th>Paid</th><th>Status</th><th>Refund window</th><th></th>' +
            '</tr></thead><tbody>' + rows.map(function (p) {
              return '<tr>' +
                '<td class="t-title">' + esc(p.listing ? p.listing.title : 'Removed listing') + '</td>' +
                '<td style="font-family:var(--mono)">' + money(p.amount_cents) + '</td>' +
                '<td>' + esc(p.status) + '</td>' +
                '<td style="font-family:var(--mono)">' +
                  new Date(p.refund_window_expires_at).toLocaleDateString() + '</td>' +
                '<td><div class="actions">' + (p.listing
                  ? '<a class="btn btn-quiet btn-sm" href="#/listing/' + esc(p.listing.id) + '">View</a>' : '') +
                '</div></td></tr>';
            }).join('') + '</tbody></table></div>'
          : '<div class="empty"><h3>No purchases yet</h3>' +
            '<p>Checkout arrives in step 3. Until then, browse the catalog and try the demos.</p>' +
            '<a class="btn btn-primary" href="#/browse">Browse tools</a></div>');
    }).catch(function (e) { view.innerHTML = fail(e); });
  }

  /* ------------------------------------------------------------- router */
  function render() {
    var parts = (location.hash || '#/browse').replace(/^#\/?/, '').split('/');
    window.scrollTo(0, 0);
    paintNav();

    switch (parts[0]) {
      case '':
      case 'browse':    return viewBrowse();
      case 'listing':   return viewListing(parts[1]);
      case 'auth':      return viewAuth();
      case 'dashboard':
        if (parts[1] === 'buyer') return viewBuyer();
        if (parts[2] === 'new')  return viewListingForm(null);
        if (parts[2] === 'edit') return viewListingForm(parts[3]);
        return viewSeller();
      default:
        view.innerHTML = '<div class="empty"><h3>No such page</h3>' +
          '<a class="btn btn-ghost" href="#/browse">Back to browse</a></div>';
    }
  }

  window.addEventListener('hashchange', render);

  // Tell the user which backend they're on rather than letting them guess.
  var banner = el('mode-banner');
  if (DB.mode === 'local') {
    banner.innerHTML = 'Local mode — accounts and listings are stored in this browser only. ' +
      'Add Supabase keys to <code>config.js</code> to go live.';
  } else {
    banner.style.display = 'none';
  }

  render();
})();
