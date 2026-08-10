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

  /* Clickable version for the listing page. Browse cards can't use these — the
     whole card is already an anchor, and anchors can't nest. */
  function tagLinks(tags) {
    return (tags || []).map(function (t) {
      return '<a class="tag" href="#/browse?tag=' + encodeURIComponent(t) + '">' + esc(t) + '</a>';
    }).join('');
  }
  function statusPill(s) {
    return '<span class="pill st-' + esc(s) + '">' + esc(STATUS_LABELS[s] || s) + '</span>';
  }
  function fail(e) {
    return '<div class="empty"><h3>Something broke</h3><p>' + esc(e.message || e) + '</p></div>';
  }

  /* Sets message text and state without clobbering the element's other classes.
   * Assigning .className wipes identifying hooks like .review-msg, which then
   * can't be found again on the next interaction. */
  function setMsg(node, text, kind) {
    if (!node) return;
    node.textContent = text;
    node.classList.remove('ok', 'err');
    if (kind) node.classList.add(kind);
  }

  /* ------------------------------------------------------------- chrome */
  function paintNav() {
    var u = DB.currentUser();
    var right = el('nav-right');
    var links = el('nav-links');
    var route = (location.hash || '#/browse').split('/')[1];

    // Match on the route, not a substring: "#/seller/<id>" is a public profile,
    // not the seller dashboard, and shouldn't light up "Selling".
    var onBrowse = route === 'browse' || route === 'listing' || route === 'seller' || route === '';
    var onSelling = /^#\/dashboard\/seller/.test(location.hash);
    var onBuying = /^#\/dashboard\/buyer/.test(location.hash);

    links.innerHTML =
      '<a href="#/browse" class="' + (onBrowse ? 'on' : '') + '">Browse</a>' +
      (u ? '<a href="#/dashboard/seller" class="' + (onSelling ? 'on' : '') + '">Selling</a>' +
           '<a href="#/dashboard/buyer" class="' + (onBuying ? 'on' : '') + '">Purchases</a>' : '');

    if (u) {
      right.innerHTML = '<a class="who" href="#/dashboard/profile">' + esc(u.email) + '</a>' +
                        '<button class="btn btn-quiet btn-sm" id="signout">Sign out</button>';
      el('signout').onclick = function () {
        DB.signOut().then(function () { paintNav(); go('#/browse'); render(); });
      };
    } else {
      right.innerHTML = '<a href="#/auth" class="btn btn-primary btn-sm">Sign in</a>';
    }
  }

  /* ------------------------------------------------------------- browse */
  /* Filters live in the URL so a search is shareable and Back works. */
  var browseState = { q: '', category: '', tag: '', sort: 'newest' };

  function syncBrowseUrl() {
    var p = new URLSearchParams();
    if (browseState.q) p.set('q', browseState.q);
    if (browseState.category) p.set('cat', browseState.category);
    if (browseState.tag) p.set('tag', browseState.tag);
    if (browseState.sort !== 'newest') p.set('sort', browseState.sort);
    var qs = p.toString();
    // replaceState so typing in the search box doesn't fill up history.
    history.replaceState(null, '', '#/browse' + (qs ? '?' + qs : ''));
  }

  function stars(avg, count, size) {
    if (!count) return '<span class="stars none">no reviews yet</span>';
    var full = Math.round(avg);
    var out = '';
    for (var i = 1; i <= 5; i++) out += '<span class="' + (i <= full ? 'on' : '') + '">★</span>';
    return '<span class="stars' + (size === 'lg' ? ' lg' : '') + '">' + out +
      '<b>' + Number(avg).toFixed(1) + '</b><span class="n">(' + count + ')</span></span>';
  }

  function demoBadge(l) {
    if (!l.demo_url) return '';
    if (l.demo_status === 'error') {
      return '<span class="pill st-delisted" title="Our health check could not reach this demo">demo down</span>';
    }
    return '<span class="pill pill-live"><span class="dot"></span>live demo</span>';
  }

  function viewBrowse(query) {
    browseState.q = query.q || '';
    browseState.category = query.cat || '';
    browseState.tag = query.tag || '';
    browseState.sort = query.sort || 'newest';

    view.innerHTML =
      '<div class="page-head"><div>' +
        '<h1>Browse tools</h1>' +
        '<p>Every listing has a live demo. Use it before you decide.</p>' +
      '</div></div>' +
      '<div class="filters">' +
        '<input id="q" type="search" placeholder="Search title, description, stack…" value="' + esc(browseState.q) + '">' +
        '<select id="sort" aria-label="Sort">' +
          '<option value="newest">Newest first</option>' +
          '<option value="rating">Best rated</option>' +
          '<option value="price_asc">Price: low to high</option>' +
          '<option value="price_desc">Price: high to low</option>' +
        '</select>' +
        '<div class="chips" id="chips"></div>' +
      '</div>' +
      '<div id="active-tag"></div>' +
      '<div id="results"><div class="empty"><p>Loading…</p></div></div>';

    el('sort').value = browseState.sort;

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

    el('sort').onchange = function (e) { browseState.sort = e.target.value; loadResults(); };

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
    syncBrowseUrl();

    var tagBox = el('active-tag');
    if (tagBox) {
      tagBox.innerHTML = browseState.tag
        ? '<div class="active-filter">Filtered by stack: <b>' + esc(browseState.tag) + '</b> ' +
          '<button class="btn btn-quiet btn-sm" id="clear-tag">clear</button></div>'
        : '';
      if (browseState.tag) {
        el('clear-tag').onclick = function () { browseState.tag = ''; loadResults(); };
      }
    }

    DB.listListings({
      q: browseState.q, category: browseState.category,
      tag: browseState.tag, sort: browseState.sort
    }).then(function (rows) {
      if (!box.isConnected) return;
      var live = rows.filter(function (l) { return l.status === 'live'; });

      if (!live.length) {
        box.innerHTML = '<div class="empty"><h3>Nothing matches</h3>' +
          '<p>No live listings fit those filters.</p>' +
          '<button class="btn btn-ghost" id="clear-all">Clear filters</button></div>';
        el('clear-all').onclick = function () {
          browseState = { q: '', category: '', tag: '', sort: 'newest' };
          viewBrowse({});
        };
        return;
      }

      box.innerHTML =
        '<div class="result-count">' + live.length + ' tool' + (live.length === 1 ? '' : 's') + '</div>' +
        '<div class="grid">' + live.map(function (l) {
          return '<a class="card" href="#/listing/' + esc(l.id) + '">' +
            '<div class="row-top">' +
              demoBadge(l) +
              '<span class="pill">' + esc(CATEGORY_LABELS[l.category] || l.category) + '</span>' +
            '</div>' +
            '<h3>' + esc(l.title) + '</h3>' +
            '<div style="margin-bottom:9px">' + stars(l.avg_rating, l.review_count) + '</div>' +
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

          '<div class="prose" id="reviews-section">' +
            '<h2>Reviews</h2><div id="reviews"><p class="hint">Loading…</p></div>' +
          '</div>' +
        '</div>' +

        '<div class="side">' +
          '<div class="buybox">' +
            '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px">' +
              '<span class="price">' + money(l.price_cents) + '</span>' +
              '<span style="font-family:var(--mono);font-size:11px;color:var(--dimmer)">one-time</span>' +
            '</div>' +
            '<button class="btn btn-primary" style="width:100%" id="buy">Buy this tool</button>' +
            '<div class="msg" id="buy-msg"></div>' +
            '<div class="kv"><span>Seller</span><span>' +
              '<a href="#/seller/' + esc(l.seller_id) + '">' + esc(l.seller_name || '—') + '</a></span></div>' +
            '<div class="kv"><span>Rating</span><span>' + stars(l.avg_rating, l.review_count) + '</span></div>' +
            '<div class="kv"><span>Category</span><span>' + esc(CATEGORY_LABELS[l.category] || l.category) + '</span></div>' +
            '<div class="kv"><span>Repo access</span><span>' + (l.repo_url ? 'unlocked' : 'after purchase') + '</span></div>' +
            (l.demo_last_checked_at
              ? '<div class="kv"><span>Demo checked</span><span>' +
                (l.demo_status === 'error' ? '<span style="color:var(--red)">failing</span>'
                                           : new Date(l.demo_last_checked_at).toLocaleDateString()) +
                '</span></div>'
              : '') +
          '</div>' +
          '<div class="guarantee"><b>Outcome guarantee</b>' +
            'If your deployment doesn\'t do what this demo just did, refund yourself within 14 days. ' +
            'The seller isn\'t paid until that window closes.</div>' +
          (l.tech_stack_tags && l.tech_stack_tags.length
            ? '<div><label>Stack</label><div class="tags">' + tagLinks(l.tech_stack_tags) + '</div>' +
              '<div class="hint">Click a tag to find other tools on the same stack.</div></div>' : '') +
          (l.repo_url ? '<div><label>Repository</label><div class="tags">' +
            '<a class="tag" href="' + esc(l.repo_url) + '" target="_blank" rel="noopener">' +
            esc(l.repo_url) + ' ↗</a></div></div>' : '') +
        '</div></div>';

      // Reviews load after the page paints — the demo is what people came for.
      DB.listReviews(l.id).then(function (rs) {
        var box = el('reviews');
        if (!box) return;
        if (!rs.length) {
          box.innerHTML = '<p class="hint">No reviews yet. Every review here comes from a ' +
            'verified purchase — there is no way to post one without buying first.</p>';
          return;
        }
        box.innerHTML = rs.map(function (r) {
          return '<div class="review">' +
            '<div class="review-head">' +
              stars(r.rating, 1) +
              '<span class="pill">verified purchase</span>' +
              '<span class="spacer"></span>' +
              '<span class="hint">' + new Date(r.created_at).toLocaleDateString() + '</span>' +
            '</div>' +
            (r.body ? '<p>' + esc(r.body) + '</p>' : '') +
            '<div class="hint">— ' + esc(r.reviewer_name || 'A buyer') + '</div>' +
          '</div>';
        }).join('');
      }).catch(function () {
        var box = el('reviews');
        if (box) box.innerHTML = '<p class="hint">Reviews are unavailable right now.</p>';
      });

      el('buy').onclick = function () {
        var m = el('buy-msg'), btn = el('buy');

        if (!DB.currentUser()) {
          m.className = 'msg err';
          m.textContent = 'Sign in first — your purchase needs somewhere to live.';
          setTimeout(function () { go('#/auth'); }, 900);
          return;
        }

        btn.disabled = true;
        m.className = 'msg';
        m.textContent = 'Starting checkout…';

        DB.startCheckout(l.id).then(function (r) {
          if (r && r.url) { location.href = r.url; return; }   // Stripe Checkout
          // Local mode books it immediately; there is no hosted page to visit.
          m.className = 'msg ok';
          m.textContent = 'Simulated purchase (local mode). Opening your purchases…';
          setTimeout(function () { go('#/dashboard/buyer'); }, 700);
        }).catch(function (err) {
          btn.disabled = false;
          m.className = 'msg err';
          m.textContent = err.message;
        });
      };
    }).catch(function (e) { view.innerHTML = fail(e); });
  }

  /* ------------------------------------------------------------- seller profile */
  function viewSellerProfile(id) {
    view.innerHTML = '<div class="empty"><p>Loading…</p></div>';

    Promise.all([DB.getSeller(id), DB.listingsBySeller(id)]).then(function (res) {
      var s = res[0], listings = (res[1] || []).filter(function (l) { return l.status === 'live'; });
      if (!s) {
        view.innerHTML = '<div class="empty"><h3>No such seller</h3>' +
          '<a class="btn btn-ghost" href="#/browse">Back to browse</a></div>';
        return;
      }
      var me = DB.currentUser();

      view.innerHTML =
        '<div class="seller-hero">' +
          '<div class="avatar">' + esc((s.display_name || '?').charAt(0).toUpperCase()) + '</div>' +
          '<div>' +
            '<h1>' + esc(s.display_name || 'Unnamed builder') + '</h1>' +
            '<div class="row-top" style="margin-top:9px">' +
              '<span class="pill">' + (s.live_listing_count || 0) + ' live tool' +
                (Number(s.live_listing_count) === 1 ? '' : 's') + '</span>' +
              '<span class="pill">building here since ' +
                new Date(s.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) +
              '</span>' +
              '<span class="pill">' + stars(s.avg_rating, s.review_count) + '</span>' +
            '</div>' +
            (s.bio ? '<p class="bio">' + esc(s.bio) + '</p>' : '') +
          '</div>' +
          (me && me.id === id
            ? '<div class="spacer"></div><a class="btn btn-quiet btn-sm" href="#/dashboard/profile">Edit profile</a>'
            : '') +
        '</div>' +

        (listings.length
          ? '<div class="grid">' + listings.map(function (l) {
              return '<a class="card" href="#/listing/' + esc(l.id) + '">' +
                '<div class="row-top">' + demoBadge(l) +
                  '<span class="pill">' + esc(CATEGORY_LABELS[l.category] || l.category) + '</span></div>' +
                '<h3>' + esc(l.title) + '</h3>' +
                '<div style="margin-bottom:9px">' + stars(l.avg_rating, l.review_count) + '</div>' +
                '<p>' + esc(l.short_description) + '</p>' +
                '<div class="tags">' + tagList(l.tech_stack_tags) + '</div>' +
                '<div class="card-foot"><span class="price">' + money(l.price_cents) + '</span></div>' +
              '</a>';
            }).join('') + '</div>'
          : '<div class="empty"><h3>Nothing listed yet</h3></div>');
    }).catch(function (e) { view.innerHTML = fail(e); });
  }

  /* ------------------------------------------------------------- own profile */
  function viewProfile() {
    if (needAuth()) return;
    view.innerHTML = '<div class="empty"><p>Loading…</p></div>';

    DB.myProfile().then(function (p) {
      p = p || {};
      view.innerHTML =
        '<div class="page-head"><div><h1>Your profile</h1>' +
          '<p>This is what buyers see next to your listings.</p></div>' +
          '<div class="spacer"></div>' +
          '<a class="btn btn-quiet btn-sm" href="#/seller/' + esc(p.id) + '">View public page</a></div>' +

        '<form id="f" class="card-form" style="max-width:620px">' +
          '<div class="field"><label for="name">Display name</label>' +
            '<input id="name" value="' + esc(p.display_name) + '" placeholder="How buyers see you"></div>' +

          '<div class="field"><label for="bio">Bio</label>' +
            '<textarea id="bio" placeholder="What you build, who for. Two sentences is plenty.">' +
              esc(p.bio) + '</textarea>' +
            '<div class="hint">Buyers here are other builders. What you\'ve shipped matters more ' +
              'than adjectives.</div></div>' +

          '<div class="field"><label>I want to</label><div class="roles" id="roles">' +
            ['buyer', 'seller', 'both'].map(function (r) {
              return '<button type="button" data-r="' + r + '" aria-pressed="' + (p.role === r) + '">' +
                (r === 'buyer' ? 'Buy' : r === 'seller' ? 'Sell' : 'Both') + '</button>';
            }).join('') + '</div></div>' +

          '<div class="form-actions">' +
            '<button class="btn btn-primary" id="save">Save profile</button>' +
            '<span class="msg" id="m"></span>' +
          '</div>' +
        '</form>';

      var role = p.role || 'both';
      el('roles').onclick = function (e) {
        var b = e.target.closest('button[data-r]');
        if (!b) return;
        role = b.dataset.r;
        Array.prototype.forEach.call(this.children, function (x) {
          x.setAttribute('aria-pressed', String(x === b));
        });
      };

      el('f').onsubmit = function (e) {
        e.preventDefault();
        var m = el('m'), btn = el('save');
        var name = el('name').value.trim();
        if (!name) { m.className = 'msg err'; m.textContent = 'Buyers need a name to trust.'; return; }

        btn.disabled = true;
        m.className = 'msg';
        m.textContent = 'Saving…';

        DB.updateProfile({ display_name: name, bio: el('bio').value.trim() || null, role: role })
          .then(function () {
            btn.disabled = false;
            m.className = 'msg ok';
            m.textContent = 'Saved.';
            paintNav();
          })
          .catch(function (err) {
            btn.disabled = false;
            m.className = 'msg err';
            m.textContent = err.message;
          });
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

    Promise.all([
      DB.myListings(),
      DB.connectStatus().catch(function (e) { return { error: e.message }; }),
      DB.sellerEarnings().catch(function () { return null; })
    ]).then(function (res) {
      var rows = res[0], connect = res[1] || {}, earn = res[2] || {};
      var live = rows.filter(function (l) { return l.status === 'live'; }).length;
      var drafts = rows.filter(function (l) { return l.status === 'draft'; }).length;
      var pending = rows.filter(function (l) { return l.status === 'pending_review'; }).length;

      var connectBanner;
      if (connect.local) {
        connectBanner = '<div class="notice">' +
          '<b>Payouts need the live backend.</b> Stripe Connect onboarding runs through ' +
          'the API functions — add Supabase and Stripe keys, then deploy, to enable it.</div>';
      } else if (!connect.connected) {
        connectBanner = '<div class="notice warn">' +
          '<b>You can\'t be paid yet.</b> Connect a Stripe account to receive payouts. ' +
          'Stripe handles identity and bank details — we never see them.' +
          '<div style="margin-top:12px"><button class="btn btn-primary btn-sm" id="connect-btn">' +
          'Set up payouts</button> <span class="msg" id="connect-msg"></span></div></div>';
      } else if (!connect.charges_enabled || !connect.payouts_enabled) {
        connectBanner = '<div class="notice warn">' +
          '<b>Stripe still needs a few details.</b> Your listings can\'t sell until this is done.' +
          ((connect.requirements_due || []).length
            ? '<div class="hint" style="margin-top:6px">Outstanding: ' +
              esc(connect.requirements_due.slice(0, 4).join(', ')) + '</div>' : '') +
          '<div style="margin-top:12px"><button class="btn btn-primary btn-sm" id="connect-btn">' +
          'Finish setup</button> <span class="msg" id="connect-msg"></span></div></div>';
      } else {
        connectBanner = '<div class="notice ok"><b>Payouts active.</b> ' +
          'Earnings are transferred once each buyer\'s refund window closes.</div>';
      }

      view.innerHTML =
        '<div class="page-head"><div>' +
          '<h1>Selling</h1><p>Your listings and what you\'ve earned.</p>' +
        '</div><div class="spacer"></div>' +
        '<a class="btn btn-primary" href="#/dashboard/seller/new">+ New listing</a></div>' +

        connectBanner +

        '<div class="stat-row">' +
          '<div class="stat"><div class="n">' + (earn.sales_count || 0) + '</div><div class="l">Sales</div></div>' +
          '<div class="stat"><div class="n">' + money(earn.held_cents || 0) + '</div>' +
            '<div class="l">Held (guarantee window)</div></div>' +
          '<div class="stat"><div class="n">' + money(earn.paid_out_cents || 0) + '</div>' +
            '<div class="l">Paid out</div></div>' +
          '<div class="stat"><div class="n">' + live + '</div><div class="l">Live listings</div></div>' +
        '</div>' +

        '<div class="stat-row" style="margin-bottom:24px">' +
          '<div class="stat"><div class="n">' + rows.length + '</div><div class="l">Listings</div></div>' +
          '<div class="stat"><div class="n">' + pending + '</div><div class="l">In review</div></div>' +
          '<div class="stat"><div class="n">' + drafts + '</div><div class="l">Drafts</div></div>' +
          '<div class="stat"><div class="n">' + (earn.refund_count || 0) + '</div><div class="l">Refunds</div></div>' +
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

      var cbtn = el('connect-btn');
      if (cbtn) {
        cbtn.onclick = function () {
          var m = el('connect-msg');
          cbtn.disabled = true;
          m.className = 'msg';
          m.textContent = 'Opening Stripe…';
          DB.startConnect().then(function (r) {
            if (r && r.url) location.href = r.url;
            else throw new Error('Stripe did not return an onboarding link.');
          }).catch(function (err) {
            cbtn.disabled = false;
            m.className = 'msg err';
            m.textContent = err.message;
          });
        };
      }
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
            '<div class="row"><input id="demo" value="' + esc(l.demo_url) + '" placeholder="https://your-demo.pages.dev">' +
              '<button type="button" class="btn btn-ghost" id="test-demo">Test it</button></div>' +
            '<div class="msg" id="demo-msg"></div>' +
            '<div class="hint">Public, seeded with fake data, and actually working. This is the whole pitch — ' +
              'a listing without one won\'t pass review. We re-check live demos automatically and flag ' +
              'the ones that stop responding.</div></div>' +

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

      el('test-demo').onclick = function () {
        var url = el('demo').value.trim();
        var m = el('demo-msg'), btn = el('test-demo');
        if (!url) { m.className = 'msg err'; m.textContent = 'Enter a URL first.'; return; }

        btn.disabled = true;
        m.className = 'msg';
        m.textContent = 'Checking…';

        DB.checkDemo(url).then(function (r) {
          btn.disabled = false;
          if (r.ok === null) {           // local mode has no server to check with
            m.className = 'msg';
            m.textContent = r.error;
            return;
          }
          if (r.ok) {
            m.className = 'msg ok';
            m.textContent = 'Reachable — HTTP ' + r.status + ' in ' + r.latency_ms + 'ms' +
              (r.looks_like_html === false ? '. Heads up: that did not look like a web page.' : '.');
          } else {
            m.className = 'msg err';
            m.textContent = r.error || 'Could not reach it.';
          }
        }).catch(function (err) {
          btn.disabled = false;
          m.className = 'msg err';
          m.textContent = err.message;
        });
      };

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
  function daysLeft(iso) {
    return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  }

  function viewBuyer() {
    if (needAuth()) return;
    view.innerHTML = '<div class="empty"><p>Loading…</p></div>';

    DB.myPurchases().then(function (rows) {
      if (!rows.length) {
        view.innerHTML =
          '<div class="page-head"><div><h1>Purchases</h1>' +
            '<p>Repo access, setup docs, and your refund window live here.</p></div></div>' +
          '<div class="empty"><h3>No purchases yet</h3>' +
          '<p>Browse the catalog, try the demos, buy the one that already does what you need.</p>' +
          '<a class="btn btn-primary" href="#/browse">Browse tools</a></div>';
        return;
      }

      view.innerHTML =
        '<div class="page-head"><div><h1>Purchases</h1>' +
          '<p>Repo access, setup docs, and your refund window live here.</p></div></div>' +
        '<div id="purchases">' + rows.map(function (p) {
          var l = p.listing;
          var left = daysLeft(p.refund_window_expires_at);
          var open = p.status === 'complete' && left > 0;

          return '<div class="purchase" data-id="' + esc(p.id) + '">' +
            '<div class="purchase-head">' +
              '<div>' +
                '<h3>' + esc(l ? l.title : 'Removed listing') + '</h3>' +
                '<div class="row-top" style="margin-top:8px">' +
                  '<span class="pill">' + money(p.amount_cents) + '</span>' +
                  '<span class="pill st-' + (p.status === 'refunded' ? 'delisted' : 'live') + '">' +
                    esc(p.status) + '</span>' +
                  (p.simulated ? '<span class="pill">simulated</span>' : '') +
                '</div>' +
              '</div>' +
              '<div class="spacer"></div>' +
              (l ? '<a class="btn btn-quiet btn-sm" href="#/listing/' + esc(l.id) + '">View listing</a>' : '') +
            '</div>' +

            '<div class="purchase-body">' +
              '<div>' +
                '<label>Repository</label>' +
                (l && l.repo_url
                  ? '<a class="repo" href="' + esc(l.repo_url) + '" target="_blank" rel="noopener">' +
                    esc(l.repo_url) + ' ↗</a>'
                  : '<div class="hint">' + (p.status === 'refunded'
                      ? 'Access ended with the refund.'
                      : 'Unlocking — reload in a moment.') + '</div>') +

                (l && l.setup_instructions
                  ? '<div style="margin-top:16px"><label>Setup &amp; deploy</label>' +
                    '<div class="setup">' + esc(l.setup_instructions) + '</div></div>'
                  : '') +
              '</div>' +

              '<div class="side-col">' +
              (p.status === 'complete'
                ? '<div class="review-box" data-purchase="' + esc(p.id) + '">' +
                    '<b>Rate this tool</b>' +
                    '<div class="star-pick" role="radiogroup" aria-label="Rating">' +
                      [1, 2, 3, 4, 5].map(function (n) {
                        return '<button type="button" data-n="' + n + '" role="radio" ' +
                          'aria-checked="false" aria-label="' + n + ' star' + (n === 1 ? '' : 's') + '">★</button>';
                      }).join('') +
                    '</div>' +
                    '<textarea class="review-body" rows="2" placeholder="Did it deploy? Did it do what the demo showed?"></textarea>' +
                    '<button class="btn btn-ghost btn-sm review-submit">Post review</button>' +
                    '<div class="msg review-msg"></div>' +
                  '</div>'
                : '') +

              '<div class="refund-box' + (open ? '' : ' closed') + '">' +
                (p.status === 'refunded'
                  ? '<b>Refunded</b><p>This purchase was refunded' +
                    (p.refunded_at ? ' on ' + new Date(p.refunded_at).toLocaleDateString() : '') + '.</p>'
                  : open
                    ? '<b>Guarantee — ' + left + ' day' + (left === 1 ? '' : 's') + ' left</b>' +
                      '<p>If this doesn\'t do what the demo showed, refund yourself. ' +
                      'No ticket, no argument. The seller isn\'t paid until ' +
                      new Date(p.refund_window_expires_at).toLocaleDateString() + '.</p>' +
                      '<button class="btn btn-danger btn-sm refund-btn">Request refund</button>'
                    : '<b>Window closed</b><p>The refund window closed on ' +
                      new Date(p.refund_window_expires_at).toLocaleDateString() + '.</p>') +
                '<div class="msg refund-msg"></div>' +
              '</div>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';

      // Replace the rating widget with the existing review where there is one.
      rows.filter(function (p) { return p.status === 'complete'; }).forEach(function (p) {
        DB.myReviewFor(p.id).then(function (r) {
          if (!r) return;
          var box = document.querySelector('.review-box[data-purchase="' + p.id + '"]');
          if (!box) return;
          box.innerHTML = '<b>Your review</b>' + stars(r.rating, 1) +
            (r.body ? '<p class="hint" style="margin-top:8px">' + esc(r.body) + '</p>' : '') +
            '<div class="hint">Posted ' + new Date(r.created_at).toLocaleDateString() + '</div>';
        }).catch(function () { /* leave the form up */ });
      });

      el('purchases').addEventListener('click', function (e) {
        var star = e.target.closest('.star-pick button');
        if (star) {
          var picker = star.parentElement;
          var n = Number(star.dataset.n);
          picker.dataset.value = n;
          Array.prototype.forEach.call(picker.children, function (b) {
            var on = Number(b.dataset.n) <= n;
            b.classList.toggle('on', on);
            b.setAttribute('aria-checked', String(Number(b.dataset.n) === n));
          });
          return;
        }

        var submit = e.target.closest('.review-submit');
        if (submit) {
          var box = submit.closest('.review-box');
          var msg = box.querySelector('.review-msg');
          var rating = Number(box.querySelector('.star-pick').dataset.value || 0);

          if (!rating) {
            setMsg(msg, 'Pick a star rating first.', 'err');
            return;
          }

          submit.disabled = true;
          setMsg(msg, 'Posting…');

          DB.createReview(box.dataset.purchase, rating, box.querySelector('.review-body').value.trim())
            .then(function (r) {
              box.innerHTML = '<b>Your review</b>' + stars(r.rating, 1) +
                (r.body ? '<p class="hint" style="margin-top:8px">' + esc(r.body) + '</p>' : '') +
                '<div class="hint">Thanks — it\'s live on the listing.</div>';
            })
            .catch(function (err) {
              submit.disabled = false;
              setMsg(msg, err.message, 'err');
            });
          return;
        }

        var refund = e.target.closest('.refund-btn');
        if (!refund) return;

        var card = refund.closest('.purchase');
        var rmsg = card.querySelector('.refund-msg');

        var reason = prompt('What went wrong? (optional — helps us fix the listing)');
        if (reason === null) return;   // cancelled

        refund.disabled = true;
        setMsg(rmsg, 'Processing…');

        DB.requestRefund(card.dataset.id, reason).then(function () {
          setMsg(rmsg, 'Refunded. Reloading…', 'ok');
          setTimeout(viewBuyer, 700);
        }).catch(function (err) {
          refund.disabled = false;
          setMsg(rmsg, err.message, 'err');
        });
      });
    }).catch(function (e) { view.innerHTML = fail(e); });
  }

  /* ------------------------------------------------------------- router */
  function render() {
    var raw = (location.hash || '#/browse').replace(/^#\/?/, '');
    var qIndex = raw.indexOf('?');
    var query = {};
    if (qIndex !== -1) {
      new URLSearchParams(raw.slice(qIndex + 1)).forEach(function (v, k) { query[k] = v; });
      raw = raw.slice(0, qIndex);
    }
    var parts = raw.split('/');
    window.scrollTo(0, 0);
    paintNav();

    switch (parts[0]) {
      case '':
      case 'browse':    return viewBrowse(query);
      case 'listing':   return viewListing(parts[1]);
      case 'seller':    return viewSellerProfile(parts[1]);
      case 'auth':      return viewAuth();
      case 'dashboard':
        if (parts[1] === 'buyer')   return viewBuyer();
        if (parts[1] === 'profile') return viewProfile();
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
