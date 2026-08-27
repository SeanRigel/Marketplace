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

  /* Repo links go to buyers who have paid, which is exactly the audience worth
   * attacking. A non-http(s) repo_url renders as plain text, never a link. */
  function repoLink(rawUrl) {
    var href = FKUrl.safeHref(rawUrl);
    if (!href) {
      return '<div class="hint">The seller\'s repository link isn\'t a valid web ' +
        'address. Contact them, or refund.</div>';
    }
    return '<a class="repo" href="' + esc(href) + '" target="_blank" rel="noopener">' +
      esc(href) + ' ↗</a>';
  }

  /* The demo panel on a listing page.
   *
   * Every branch that refuses to embed is a security decision, not a styling
   * one — see the URL safety notes in db.js. A seller can put anything in
   * demo_url, so this never trusts it enough to build an href from the raw
   * string; FKUrl hands back a vetted src or nothing. */
  function demoBox(rawUrl) {
    if (!rawUrl) {
      return '<div class="no-demo">No demo URL on this listing yet.<br>' +
        'A listing without a working demo will not pass review.</div>';
    }

    var f = FKUrl.demoFrame(rawUrl);

    if (!f.ok && f.reason === 'scheme') {
      return '<div class="no-demo">This demo link isn\'t a valid web address.<br>' +
        'Only http and https links can be shown here.</div>';
    }

    if (!f.ok && f.reason === 'same-origin') {
      return '<div class="no-demo">This demo is hosted on the marketplace\'s own ' +
        'domain, so it can\'t be embedded safely.<br>' +
        'Host it on your own domain and update the listing.</div>';
    }

    return '<div class="chrome"><div class="lights"><i></i><i></i><i></i></div>' +
        '<div class="addr">' + esc(f.src) + '</div>' +
        '<span class="badge badge-live"><span class="dot"></span>live sandbox</span></div>' +
      '<iframe class="demo-frame" title="Live demo" referrerpolicy="no-referrer" ' +
        'sandbox="' + esc(f.sandbox) + '" ' +
        'src="' + esc(f.src) + '"></iframe>' +
      '<div class="demo-note">Real running instance with demo data. ' +
        '<a href="' + esc(f.src) + '" target="_blank" rel="noopener">Open in a new tab ↗</a></div>';
  }

  /* Stable hue per listing so generated covers look designed, not random. */
  function hue(seed) {
    var h = 0, s = String(seed || '');
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  function monogram(title) {
    // Only letters/digits start a word, or "RECONSOLE — OSINT" renders as "R—".
    var w = String(title || '?').split(/[^A-Za-z0-9]+/).filter(Boolean);
    if (!w.length) return '?';
    return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[1][0]).toUpperCase();
  }

  function avatarFor(name, cls) {
    return '<span class="avatar ' + (cls || '') + '">' +
      esc(String(name || '?').trim().charAt(0).toUpperCase() || '?') + '</span>';
  }

  /* One product tile, used by browse, seller profiles and related tools. */
  function listingCard(l) {
    return '<a class="card" href="#/listing/' + esc(l.id) + '">' +
      '<div class="cover" style="--h:' + hue(l.id) + '">' +
        (l.demo_url
          ? (l.demo_status === 'error'
              ? '<span class="badge badge-danger cover-badge">Demo down</span>'
              : '<span class="badge badge-live cover-badge"><span class="dot"></span>Live demo</span>')
          : '') +
        '<span class="monogram">' + esc(monogram(l.title)) + '</span>' +
        '<span class="cover-cat">' + esc(CATEGORY_LABELS[l.category] || l.category) + '</span>' +
      '</div>' +
      '<div class="card-body">' +
        '<h3>' + esc(l.title) + '</h3>' +
        '<p class="card-desc">' + esc(l.short_description) + '</p>' +
        stars(l.avg_rating, l.review_count) +
      '</div>' +
      '<div class="card-foot">' +
        '<span class="price">' + money(l.price_cents) + '</span>' +
        '<span class="seller-inline spacer">' + avatarFor(l.seller_name) +
          esc(l.seller_name || '—') + '</span>' +
      '</div>' +
    '</a>';
  }

  /* Clickable version for the listing page. Browse cards can't use these — the
     whole card is already an anchor, and anchors can't nest. */
  function tagLinks(tags) {
    return (tags || []).map(function (t) {
      return '<a class="tag" href="#/browse?tag=' + encodeURIComponent(t) + '">' + esc(t) + '</a>';
    }).join('');
  }
  function statusPill(s) {
    var cls = s === 'live' ? 'badge-live' : s === 'pending_review' ? 'badge-accent'
            : s === 'delisted' ? 'badge-danger' : '';
    return '<span class="badge ' + cls + '">' + esc(STATUS_LABELS[s] || s) + '</span>';
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
    var onRequests = route === 'requests' || route === 'request';
    var onSelling = /^#\/dashboard\/seller/.test(location.hash);
    var onBuying = /^#\/dashboard\/buyer/.test(location.hash);

    links.innerHTML =
      '<a href="#/browse" class="' + (onBrowse ? 'on' : '') + '">Browse</a>' +
      '<a href="#/requests" class="' + (onRequests ? 'on' : '') + '">Requests</a>' +
      (u ? '<a href="#/dashboard/seller" class="' + (onSelling ? 'on' : '') + '">Selling</a>' +
           '<a href="#/dashboard/buyer" class="' + (onBuying ? 'on' : '') + '">Purchases</a>' : '');

    /* The admin link appears only for admins, but that is cosmetic. Every rule
     * that matters is enforced by the database: is_admin() gates the queue and
     * admin_set_listing_status() re-checks it server-side. Someone typing
     * #/admin by hand reaches a screen that shows them nothing. */
    if (u && DB.isAdmin) {
      DB.isAdmin().then(function (admin) {
        if (!admin) return;
        var onAdmin = location.hash.indexOf('#/admin') === 0;
        links.insertAdjacentHTML('beforeend',
          '<a href="#/admin" class="' + (onAdmin ? 'on' : '') + '">Moderate</a>');
      }).catch(function () {});
    }

    if (u) {
      right.innerHTML =
        '<a class="who" href="#/dashboard/profile" title="' + esc(u.email) + '">' +
          avatarFor(u.email) + '<span class="hide-sm">' + esc(u.email.split('@')[0]) + '</span></a>' +
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

  function stars(avg, count) {
    if (!count) return '<span class="stars none">No reviews yet</span>';
    var full = Math.round(avg), s = '';
    for (var i = 1; i <= 5; i++) s += (i <= full ? '<b>★</b>' : '★');
    return '<span class="stars"><span class="s">' + s + '</span>' +
      '<span class="val">' + Number(avg).toFixed(1) + '</span>' +
      '<span>(' + count + ')</span></span>';
  }

  function demoBadge(l) {
    if (!l.demo_url) return '';
    if (l.demo_status === 'error') {
      return '<span class="badge badge-danger" title="Our health check could not reach this demo">Demo down</span>';
    }
    return '<span class="badge badge-live"><span class="dot"></span>Live demo</span>';
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

      '<div class="browse-layout">' +
        '<aside class="filters-rail">' +
          '<div class="filter-group">' +
            '<h4>Category</h4>' +
            '<div class="filter-list" id="cats"></div>' +
          '</div>' +
          '<div class="filter-group">' +
            '<h4>Search</h4>' +
            '<input id="q" type="search" placeholder="Title, stack…" value="' + esc(browseState.q) + '">' +
          '</div>' +
        '</aside>' +

        '<div>' +
          '<div class="results-bar">' +
            '<span class="count" id="count"></span>' +
            '<select id="sort" aria-label="Sort">' +
              '<option value="newest">Newest first</option>' +
              '<option value="rating">Best rated</option>' +
              '<option value="price_asc">Price: low to high</option>' +
              '<option value="price_desc">Price: high to low</option>' +
            '</select>' +
          '</div>' +
          '<div id="active-tag"></div>' +
          '<div id="results"><div class="empty"><p>Loading…</p></div></div>' +
        '</div>' +
      '</div>';

    el('sort').value = browseState.sort;

    var cats = el('cats');
    cats.innerHTML = ['', 'scheduling', 'dashboard', 'intake_form', 'payroll', 'ai_integration', 'other']
      .map(function (c) {
        return '<button data-c="' + c + '" aria-pressed="' + (browseState.category === c) + '">' +
          (c ? CATEGORY_LABELS[c] : 'All tools') + '</button>';
      }).join('');

    cats.onclick = function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      browseState.category = b.dataset.c;
      Array.prototype.forEach.call(cats.children, function (x) {
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
        ? '<div class="active-filter">Stack: <b>' + esc(browseState.tag) + '</b>' +
          '<button class="btn btn-quiet btn-sm spacer" id="clear-tag">Clear</button></div>'
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

      var counter = el('count');
      if (counter) {
        counter.textContent = live.length + ' tool' + (live.length === 1 ? '' : 's');
      }

      if (!live.length) {
        box.innerHTML = '<div class="empty"><h3>Nothing matches</h3>' +
          '<p>No live listings fit those filters.</p>' +
          '<button class="btn btn-secondary" id="clear-all">Clear filters</button></div>';
        el('clear-all').onclick = function () {
          browseState = { q: '', category: '', tag: '', sort: 'newest' };
          viewBrowse({});
        };
        return;
      }

      box.innerHTML = '<div class="grid">' + live.map(listingCard).join('') + '</div>';
    }).catch(function (e) { box.innerHTML = fail(e); });
  }

  /* ------------------------------------------------------------- listing detail */
  function viewListing(id) {
    view.innerHTML = '<div class="empty"><p>Loading…</p></div>';
    DB.getListing(id).then(function (l) {
      if (!l) {
        view.innerHTML = '<div class="empty"><h3>Listing not found</h3>' +
          '<p>It may be a draft, or delisted.</p><a class="btn btn-secondary" href="#/browse">Back to browse</a></div>';
        return;
      }
      var me = DB.currentUser();
      var mine = me && l.seller_id === me.id;

      view.innerHTML =
        '<div class="crumbs"><a href="#/browse">All tools</a><span>›</span>' +
          '<a href="#/browse?cat=' + esc(l.category) + '">' +
            esc(CATEGORY_LABELS[l.category] || l.category) + '</a><span>›</span>' +
          esc(l.title) + '</div>' +

        '<div class="page-head"><div>' +
          '<div style="display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap">' +
            demoBadge(l) +
            '<span class="badge">' + esc(CATEGORY_LABELS[l.category] || l.category) + '</span>' +
            (l.status !== 'live' ? statusPill(l.status) : '') +
          '</div>' +
          '<h1>' + esc(l.title) + '</h1>' +
          '<p>' + esc(l.short_description) + '</p>' +
          '<div style="margin-top:10px">' + stars(l.avg_rating, l.review_count) + '</div>' +
        '</div>' +
        (mine ? '<div class="spacer"></div><a class="btn btn-secondary btn-sm" href="#/dashboard/seller/edit/' +
                esc(l.id) + '">Edit listing</a>' : '') +
        '</div>' +

        '<div class="detail"><div>' +
          '<div class="demo-box">' +
            demoBox(l.demo_url) +
          '</div>' +

          (l.long_description ? '<div class="prose"><h2>What it is</h2>' +
            '<div class="body">' + esc(l.long_description) + '</div></div>' : '') +

          (l.setup_instructions ? '<div class="prose"><h2>Setup &amp; deploy</h2>' +
            '<div class="body">' + esc(l.setup_instructions) + '</div></div>' : '') +

          '<div class="prose" id="changelog-section">' +
            '<h2>Changelog</h2>' +
            '<p class="hint">Templates that keep getting fixed are worth more than ones that ' +
              'shipped once. This is the seller\'s record of both.</p>' +
            '<div id="changelog"><p class="hint">Loading…</p></div>' +
          '</div>' +

          '<div class="prose" id="reviews-section">' +
            '<h2>Reviews</h2><div id="reviews"><p class="hint">Loading…</p></div>' +
          '</div>' +

          '<div class="prose" id="related-section"></div>' +
        '</div>' +

        '<div class="side">' +
          '<div class="buybox">' +
            (l.extended_price_cents
              ? '<div class="licenses" id="licenses">' +
                  '<button type="button" class="lic on" data-lic="single">' +
                    '<span class="lic-name">Single client</span>' +
                    '<span class="lic-price">' + money(l.price_cents) + '</span>' +
                    '<span class="lic-note">Deploy once, for one client project.</span>' +
                  '</button>' +
                  '<button type="button" class="lic" data-lic="extended">' +
                    '<span class="lic-name">Unlimited clients</span>' +
                    '<span class="lic-price">' + money(l.extended_price_cents) + '</span>' +
                    '<span class="lic-note">Deploy for as many clients as you like.</span>' +
                  '</button>' +
                '</div>'
              : '<div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:13px">' +
                  '<span class="price" style="font-size:26px">' + money(l.price_cents) + '</span>' +
                  '<span style="font-size:12px;color:var(--ink-3)">one-time</span>' +
                '</div>') +
            '<button class="btn btn-primary btn-block btn-lg" id="buy">Buy this tool</button>' +
            '<div class="msg" id="buy-msg"></div>' +
            '<div class="kv" style="margin-top:10px"><span>Category</span><span>' +
              esc(CATEGORY_LABELS[l.category] || l.category) + '</span></div>' +
            '<div class="kv"><span>Repo access</span><span>' +
              (l.repo_url ? 'Unlocked' : 'After purchase') + '</span></div>' +
            (l.latest_version
              ? '<div class="kv"><span>Latest version</span><span>' + esc(l.latest_version) + '</span></div>' : '') +
            (l.demo_last_checked_at
              ? '<div class="kv"><span>Demo checked</span><span>' +
                (l.demo_status === 'error' ? '<span style="color:var(--danger)">Failing</span>'
                                           : new Date(l.demo_last_checked_at).toLocaleDateString()) +
                '</span></div>'
              : '') +
          '</div>' +

          '<div class="guarantee"><b>Outcome guarantee</b>' +
            'If your deployment doesn\'t do what this demo just did, refund yourself within 14 days. ' +
            'The seller isn\'t paid until that window closes.</div>' +

          '<a class="seller-card" href="#/seller/' + esc(l.seller_id) + '">' +
            avatarFor(l.seller_name) +
            '<div><div class="name">' + esc(l.seller_name || '—') + '</div>' +
            '<div class="meta">View their other tools →</div></div>' +
          '</a>' +

          (l.tech_stack_tags && l.tech_stack_tags.length
            ? '<div><label>Stack</label><div class="tags">' + tagLinks(l.tech_stack_tags) + '</div>' +
              '<div class="hint">Click a tag to find other tools on the same stack.</div></div>' : '') +
          (l.repo_url ? '<div><label>Repository</label>' + repoLink(l.repo_url) + '</div>' : '') +
        '</div></div>';

      // Changelog: seller sees an editor; a buyer sees which entries landed after
      // they bought, which is the whole reason they'd read it.
      if (me && !mine) {
        DB.myPurchases().then(function (ps) {
          var mineForThis = ps.filter(function (p) {
            return p.listing_id === l.id && p.status === 'complete';
          }).sort(function (a, b) { return a.created_at.localeCompare(b.created_at); })[0];
          renderChangelog(l, false, mineForThis ? mineForThis.created_at : null);
        }).catch(function () { renderChangelog(l, false); });
      } else {
        renderChangelog(l, mine);
      }

      // Related tools, by shared stack first and category second.
      DB.relatedListings(l, 3).then(function (rel) {
        var box = el('related-section');
        if (!box || !rel || !rel.length) return;
        box.innerHTML = '<h2>Similar tools</h2>' +
          '<div class="grid" style="margin-top:14px">' + rel.map(listingCard).join('') + '</div>';
      }).catch(function () { /* related is a nicety, never a blocker */ });

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
              avatarFor(r.reviewer_name) +
              '<span style="font-weight:550;font-size:14px">' + esc(r.reviewer_name || 'A buyer') + '</span>' +
              '<span class="badge badge-live">✓ Verified purchase</span>' +
              '<span class="spacer"></span>' +
              '<span class="by">' + new Date(r.created_at).toLocaleDateString() + '</span>' +
            '</div>' +
            '<div style="margin-bottom:6px">' + stars(r.rating, 1) + '</div>' +
            (r.body ? '<p>' + esc(r.body) + '</p>' : '') +
          '</div>';
        }).join('');
      }).catch(function () {
        var box = el('reviews');
        if (box) box.innerHTML = '<p class="hint">Reviews are unavailable right now.</p>';
      });

      var chosenLicense = 'single';
      var licBox = el('licenses');
      if (licBox) {
        licBox.onclick = function (e) {
          var b = e.target.closest('.lic');
          if (!b) return;
          chosenLicense = b.dataset.lic;
          Array.prototype.forEach.call(this.children, function (x) {
            x.classList.toggle('on', x === b);
          });
        };
      }

      el('buy').onclick = function () {
        var m = el('buy-msg'), btn = el('buy');

        if (!DB.currentUser()) {
          setMsg(m, 'Sign in first — your purchase needs somewhere to live.', 'err');
          setTimeout(function () { go('#/auth'); }, 900);
          return;
        }

        btn.disabled = true;
        setMsg(m, 'Starting checkout…');

        DB.startCheckout(l.id, chosenLicense).then(function (r) {
          if (r && r.url) { location.href = r.url; return; }   // Stripe Checkout
          // Local mode books it immediately; there is no hosted page to visit.
          setMsg(m, 'Simulated purchase (local mode). Opening your purchases…', 'ok');
          setTimeout(function () { go('#/dashboard/buyer'); }, 700);
        }).catch(function (err) {
          btn.disabled = false;
          setMsg(m, err.message, 'err');
        });
      };
    }).catch(function (e) { view.innerHTML = fail(e); });
  }

  /* ------------------------------------------------------------- changelog */
  function renderChangelog(listing, isOwner, sinceISO) {
    var box = el('changelog');
    if (!box) return;

    DB.listUpdates(listing.id).then(function (ups) {
      var html = '';

      if (isOwner) {
        html +=
          '<form class="update-form" id="update-form">' +
            '<div class="row">' +
              '<input id="up-version" placeholder="v1.2.0 (optional)" style="max-width:180px">' +
              '<input id="up-body" placeholder="What changed? e.g. Fixed the webhook retry loop.">' +
              '<button class="btn btn-secondary" id="up-save">Post</button>' +
            '</div>' +
            '<div class="msg" id="up-msg"></div>' +
          '</form>';
      }

      if (!ups.length) {
        html += '<p class="hint">' + (isOwner
          ? 'No updates posted yet. Buyers use this to judge whether a template is maintained.'
          : 'No updates posted yet.') + '</p>';
      } else {
        html += '<ol class="changelog">' + ups.map(function (u) {
          var isNew = sinceISO && u.created_at > sinceISO;
          return '<li' + (isNew ? ' class="new"' : '') + '>' +
            '<div class="cl-head">' +
              (u.version ? '<span class="badge">' + esc(u.version) + '</span>' : '') +
              '<span class="hint">' + new Date(u.created_at).toLocaleDateString() + '</span>' +
              (isNew ? '<span class="badge badge-live">since you bought</span>' : '') +
              (isOwner ? '<span class="spacer"></span>' +
                '<button class="btn btn-quiet btn-sm up-del" data-id="' + esc(u.id) + '">Delete</button>' : '') +
            '</div>' +
            '<p>' + esc(u.body) + '</p>' +
          '</li>';
        }).join('') + '</ol>';
      }

      box.innerHTML = html;

      if (isOwner) {
        el('update-form').onsubmit = function (e) {
          e.preventDefault();
          var msg = el('up-msg'), btn = el('up-save');
          var body = el('up-body').value.trim();
          if (!body) { setMsg(msg, 'Say what changed.', 'err'); return; }

          btn.disabled = true;
          setMsg(msg, 'Posting…');

          DB.createUpdate(listing.id, el('up-version').value, body)
            .then(function () { renderChangelog(listing, isOwner, sinceISO); })
            .catch(function (err) { btn.disabled = false; setMsg(msg, err.message, 'err'); });
        };

        box.addEventListener('click', function (e) {
          var del = e.target.closest('.up-del');
          if (!del) return;
          if (!confirm('Delete this update?')) return;
          DB.deleteUpdate(del.dataset.id)
            .then(function () { renderChangelog(listing, isOwner, sinceISO); })
            .catch(function (err) { setMsg(el('up-msg'), err.message, 'err'); });
        });
      }
    }).catch(function () {
      box.innerHTML = '<p class="hint">Changelog unavailable.</p>';
    });
  }

  /* ------------------------------------------------------------- request board
   * A marketplace with no catalogue has nothing for a buyer to do. The board
   * gives demand somewhere to go before supply exists — and tells the operator
   * what to build next, which is worth more than the feature itself early on. */
  function viewRequests(query) {
    var filter = { status: query.status || 'open', category: query.cat || '' };

    view.innerHTML =
      '<div class="page-head"><div>' +
        '<h1>Requests</h1>' +
        '<p>What builders are looking for and can\'t find. Post what you need, ' +
          'or claim one you\'ve already built.</p>' +
      '</div><div class="spacer"></div>' +
      '<a class="btn btn-primary" href="#/requests/new">+ Post a request</a></div>' +

      '<div class="results-bar">' +
        '<div class="filter-list" id="req-status" style="flex-direction:row;gap:6px">' +
          ['open', 'fulfilled', ''].map(function (s) {
            return '<button data-s="' + s + '" aria-pressed="' + (filter.status === s) + '">' +
              (s === '' ? 'All' : s === 'open' ? 'Open' : 'Fulfilled') + '</button>';
          }).join('') +
        '</div>' +
        '<span class="count spacer" id="req-count"></span>' +
      '</div>' +
      '<div id="req-list"><div class="empty"><p>Loading…</p></div></div>';

    el('req-status').onclick = function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      filter.status = b.dataset.s;
      Array.prototype.forEach.call(this.children, function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
      load();
    };

    function load() {
      DB.listRequests({ status: filter.status || undefined }).then(function (rows) {
        var box = el('req-list');
        if (!box) return;
        el('req-count').textContent = rows.length + ' request' + (rows.length === 1 ? '' : 's');

        if (!rows.length) {
          box.innerHTML = '<div class="empty"><h3>Nothing posted yet</h3>' +
            '<p>Be the first — say what you need and what you\'d pay for it.</p>' +
            '<a class="btn btn-primary" href="#/requests/new">Post a request</a></div>';
          return;
        }

        box.innerHTML = rows.map(function (r) {
          return '<a class="request-row" href="#/request/' + esc(r.id) + '">' +
            '<div class="req-main">' +
              '<div class="row-badges">' +
                '<span class="badge">' + esc(CATEGORY_LABELS[r.category] || r.category) + '</span>' +
                (r.status === 'fulfilled'
                  ? '<span class="badge badge-live">Fulfilled</span>'
                  : '<span class="badge badge-accent">Open</span>') +
              '</div>' +
              '<h3>' + esc(r.title) + '</h3>' +
              (r.body ? '<p>' + esc(r.body.slice(0, 160)) +
                (r.body.length > 160 ? '…' : '') + '</p>' : '') +
              '<div class="req-meta">' + avatarFor(r.author_name) + esc(r.author_name) +
                '<span>·</span>' + new Date(r.created_at).toLocaleDateString() +
                '<span>·</span>' + (r.response_count || 0) + ' repl' +
                (Number(r.response_count) === 1 ? 'y' : 'ies') +
              '</div>' +
            '</div>' +
            '<div class="req-budget">' +
              (r.budget_cents
                ? '<span class="price">' + money(r.budget_cents) + '</span><small>budget</small>'
                : '<small>open budget</small>') +
            '</div>' +
          '</a>';
        }).join('');
      }).catch(function (e) { el('req-list').innerHTML = fail(e); });
    }

    load();
  }

  function viewRequestForm() {
    if (needAuth()) return;

    view.innerHTML =
      '<div class="page-head"><div><h1>Post a request</h1>' +
        '<p>Describe the tool you need. Sellers reply publicly — and if someone ' +
          'has already built it, you\'ll find out today.</p></div>' +
        '<div class="spacer"></div>' +
        '<a class="btn btn-quiet btn-sm" href="#/requests">Back</a></div>' +

      '<form id="f" class="card-form" style="max-width:680px">' +
        '<div class="field"><label for="r-title">What do you need?</label>' +
          '<input id="r-title" placeholder="Shift scheduler for a gym chain with 200 staff"></div>' +

        '<div class="two">' +
          '<div class="field"><label for="r-cat">Category</label><select id="r-cat">' +
            DB.categories.map(function (c) {
              return '<option value="' + c + '">' + CATEGORY_LABELS[c] + '</option>';
            }).join('') + '</select></div>' +
          '<div class="field"><label for="r-budget">Budget (USD, optional)</label>' +
            '<input id="r-budget" type="number" min="0" step="10" placeholder="200">' +
            '<div class="hint">A number makes replies far more likely.</div></div>' +
        '</div>' +

        '<div class="field"><label for="r-body">Details</label>' +
          '<textarea id="r-body" placeholder="What it has to do, what you\'ve already tried, ' +
            'what stack you\'d want it in, and roughly when you need it."></textarea></div>' +

        '<div class="form-actions">' +
          '<button class="btn btn-primary" id="r-save">Post request</button>' +
          '<span class="msg" id="r-msg"></span>' +
        '</div>' +
      '</form>';

    el('f').onsubmit = function (e) {
      e.preventDefault();
      var msg = el('r-msg'), btn = el('r-save');
      var title = el('r-title').value.trim();
      if (!title) { setMsg(msg, 'Say what you need.', 'err'); return; }

      btn.disabled = true;
      setMsg(msg, 'Posting…');

      DB.createRequest({
        title: title,
        body: el('r-body').value.trim(),
        category: el('r-cat').value,
        budget_cents: Math.round(Number(el('r-budget').value || 0) * 100) || null
      }).then(function (r) { go('#/request/' + r.id); })
        .catch(function (err) { btn.disabled = false; setMsg(msg, err.message, 'err'); });
    };
  }

  function viewRequest(id) {
    view.innerHTML = '<div class="empty"><p>Loading…</p></div>';

    Promise.all([DB.getRequest(id), DB.listResponses(id)]).then(function (res) {
      var r = res[0], replies = res[1] || [];
      if (!r) {
        view.innerHTML = '<div class="empty"><h3>No such request</h3>' +
          '<a class="btn btn-secondary" href="#/requests">Back to requests</a></div>';
        return;
      }

      var me = DB.currentUser();
      var mine = me && r.author_id === me.id;

      view.innerHTML =
        '<div class="crumbs"><a href="#/requests">Requests</a><span>›</span>' + esc(r.title) + '</div>' +

        '<div class="page-head"><div>' +
          '<div class="row-badges" style="margin-bottom:10px">' +
            '<span class="badge">' + esc(CATEGORY_LABELS[r.category] || r.category) + '</span>' +
            (r.status === 'fulfilled'
              ? '<span class="badge badge-live">Fulfilled</span>'
              : '<span class="badge badge-accent">Open</span>') +
            (r.budget_cents ? '<span class="badge">Budget ' + money(r.budget_cents) + '</span>' : '') +
          '</div>' +
          '<h1>' + esc(r.title) + '</h1>' +
          '<div class="req-meta" style="margin-top:9px">' + avatarFor(r.author_name) +
            esc(r.author_name) + '<span>·</span>' +
            new Date(r.created_at).toLocaleDateString() + '</div>' +
        '</div>' +
        (mine && r.status === 'open'
          ? '<div class="spacer"></div><button class="btn btn-secondary btn-sm" id="mark-done">' +
            'Mark fulfilled</button>' : '') +
        '</div>' +

        (r.body ? '<div class="panel panel-pad" style="max-width:760px">' +
          '<div class="prose"><div class="body">' + esc(r.body) + '</div></div></div>' : '') +

        '<div class="prose" style="max-width:760px">' +
          '<h2>' + replies.length + ' repl' + (replies.length === 1 ? 'y' : 'ies') + '</h2>' +
          '<div id="replies">' + (replies.length
            ? replies.map(function (x) {
                return '<div class="review">' +
                  '<div class="review-head">' + avatarFor(x.seller_name) +
                    '<a href="#/seller/' + esc(x.seller_id) + '" style="font-weight:550;font-size:14px">' +
                      esc(x.seller_name) + '</a>' +
                    '<span class="spacer"></span>' +
                    '<span class="by">' + new Date(x.created_at).toLocaleDateString() + '</span>' +
                  '</div>' +
                  '<p>' + esc(x.body) + '</p>' +
                  (x.listing_id && x.listing_title
                    ? '<a class="btn btn-secondary btn-sm" href="#/listing/' + esc(x.listing_id) + '">' +
                      'See ' + esc(x.listing_title) + ' →</a>' : '') +
                '</div>';
              }).join('')
            : '<p class="hint">No replies yet.</p>') + '</div>' +
        '</div>' +

        (mine ? '' :
          '<div class="panel panel-pad" style="max-width:760px;margin-top:22px">' +
            '<label for="reply-body">Your reply</label>' +
            '<textarea id="reply-body" placeholder="I\'ve built this — here\'s what it does. ' +
              'Or: I could build it for X by Y."></textarea>' +
            '<div class="field" style="margin-top:12px"><label for="reply-listing">' +
              'Link one of your listings (optional)</label>' +
              '<select id="reply-listing"><option value="">None</option></select></div>' +
            '<button class="btn btn-primary" id="reply-send">Post reply</button>' +
            '<span class="msg" id="reply-msg"></span>' +
          '</div>');

      if (mine && r.status === 'open') {
        el('mark-done').onclick = function () {
          DB.updateRequest(id, { status: 'fulfilled' }).then(function () { viewRequest(id); })
            .catch(function (err) { alert(err.message); });
        };
      }

      if (!mine) {
        // Offer the seller's own live listings to attach.
        DB.myListings().then(function (mine2) {
          var sel = el('reply-listing');
          if (!sel) return;
          mine2.filter(function (l) { return l.status === 'live'; }).forEach(function (l) {
            var o = document.createElement('option');
            o.value = l.id;
            o.textContent = l.title;
            sel.appendChild(o);
          });
        }).catch(function () { /* optional */ });

        el('reply-send').onclick = function () {
          var msg = el('reply-msg'), btn = el('reply-send');
          var body = el('reply-body').value.trim();
          if (!body) { setMsg(msg, 'Write something first.', 'err'); return; }
          if (!DB.currentUser()) {
            setMsg(msg, 'Sign in to reply.', 'err');
            setTimeout(function () { go('#/auth'); }, 800);
            return;
          }

          btn.disabled = true;
          setMsg(msg, 'Posting…');
          DB.respondToRequest(id, body, el('reply-listing').value || null)
            .then(function () { viewRequest(id); })
            .catch(function (err) { btn.disabled = false; setMsg(msg, err.message, 'err'); });
        };
      }
    }).catch(function (e) { view.innerHTML = fail(e); });
  }

  /* ------------------------------------------------------------- seller profile */
  function viewSellerProfile(id) {
    view.innerHTML = '<div class="empty"><p>Loading…</p></div>';

    Promise.all([DB.getSeller(id), DB.listingsBySeller(id)]).then(function (res) {
      var s = res[0], listings = (res[1] || []).filter(function (l) { return l.status === 'live'; });
      if (!s) {
        view.innerHTML = '<div class="empty"><h3>No such seller</h3>' +
          '<a class="btn btn-secondary" href="#/browse">Back to browse</a></div>';
        return;
      }
      var me = DB.currentUser();

      view.innerHTML =
        '<div class="seller-hero">' +
          avatarFor(s.display_name, 'avatar-lg') +
          '<div>' +
            '<h1>' + esc(s.display_name || 'Unnamed builder') + '</h1>' +
            '<div class="seller-meta">' +
              '<span class="badge">' + (s.live_listing_count || 0) + ' live tool' +
                (Number(s.live_listing_count) === 1 ? '' : 's') + '</span>' +
              '<span class="badge">Building here since ' +
                new Date(s.created_at).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }) +
              '</span>' +
              stars(s.avg_rating, s.review_count) +
            '</div>' +
            (s.bio ? '<p class="bio">' + esc(s.bio) + '</p>' : '') +
          '</div>' +
          (me && me.id === id
            ? '<div class="spacer"></div><a class="btn btn-quiet btn-sm" href="#/dashboard/profile">Edit profile</a>'
            : '') +
        '</div>' +

        (listings.length
          ? '<div class="grid">' + listings.map(listingCard).join('') + '</div>'
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
                '<td><span class="badge">' + esc(CATEGORY_LABELS[l.category] || l.category) + '</span></td>' +
                '<td style="font-family:var(--mono)">' + money(l.price_cents) + '</td>' +
                '<td>' + (l.demo_url
                  ? '<span class="badge badge-live"><span class="dot"></span>Set</span>'
                  : '<span class="badge badge-danger">Missing</span>') + '</td>' +
                '<td>' + statusPill(l.status) + '</td>' +
                '<td><div class="actions">' +
                  '<a class="btn btn-quiet btn-sm" href="#/listing/' + esc(l.id) + '">View</a>' +
                  '<a class="btn btn-secondary btn-sm" href="#/dashboard/seller/edit/' + esc(l.id) + '">Edit</a>' +
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

        (editing ? '' :
          '<div class="import-box">' +
            '<b>Start from a GitHub repo</b>' +
            '<p>Paste a public repo URL and Claude drafts the listing from its README. ' +
              'You edit everything before it saves.</p>' +
            '<div class="row">' +
              '<input id="repo-url" placeholder="https://github.com/you/your-tool">' +
              '<button type="button" class="btn btn-secondary" id="import-btn">Draft it</button>' +
            '</div>' +
            '<div class="msg" id="import-msg"></div>' +
          '</div>') +

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
            '<div class="field"><label for="price">Price — single client (USD)</label>' +
              '<input id="price" type="number" min="0" step="1" value="' +
                (Number(l.price_cents || 0) / 100) + '">' +
              '<div class="hint">Most tools here land between $50 and $500.</div></div>' +
          '</div>' +

          '<div class="field"><label for="ext-price">Price — unlimited clients (USD, optional)</label>' +
            '<input id="ext-price" type="number" min="0" step="1" value="' +
              (l.extended_price_cents ? Number(l.extended_price_cents) / 100 : '') + '">' +
            '<div class="hint">Your buyers are agencies deploying for several clients. ' +
              'An unlimited-client tier is the same work for you and usually 3–4× the price. ' +
              'Leave blank to offer single-client only.</div></div>' +

          '<div class="field"><label for="demo">Demo URL</label>' +
            '<div class="row"><input id="demo" value="' + esc(l.demo_url) + '" placeholder="https://your-demo.pages.dev">' +
              '<button type="button" class="btn btn-secondary" id="test-demo">Test it</button></div>' +
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

          '<div class="quality" id="quality"></div>' +

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
          extended_price_cents: el('ext-price').value
            ? Math.round(Number(el('ext-price').value) * 100) : null,
          demo_url: el('demo').value.trim() || null,
          repo_url: el('repo').value.trim() || null,
          setup_instructions: el('setup').value.trim() || null,
          tech_stack_tags: el('tags').value.split(',').map(function (t) { return t.trim(); })
            .filter(Boolean),
          status: el('status').value
        };
      }

      /* A completeness meter beats a human reviewer for the boring 90%. Two items
       * are hard requirements because they're the marketplace's actual promises:
       * a working demo, and docs good enough to deploy from. The rest is coaching. */
      function qualityChecks() {
        var d = collect();
        return [
          { ok: d.title.length >= 8, label: 'Title that says what it is', required: false },
          { ok: d.short_description.length >= 40, label: 'Short description (40+ chars)', required: false },
          { ok: d.long_description.length >= 120, label: 'Long description (120+ chars)', required: false },
          { ok: !!d.demo_url && !!FKUrl.safeUrl(d.demo_url), label: 'Working demo URL', required: true,
            why: 'This is the entire differentiator. No demo, no listing. It must be an http or https address.' },
          { ok: (d.setup_instructions || '').length >= 80, label: 'Setup instructions (80+ chars)', required: true,
            why: 'We promise buyers deploy in under an hour. That needs real docs.' },
          // Not required to *have* a repo link, but a link that isn't http(s) never
          // goes live — the render side refuses to draw it anyway.
          { ok: !d.repo_url || !!FKUrl.safeUrl(d.repo_url), label: 'Repo URL is a web address', required: true,
            why: 'Only http and https links are allowed.' },
          { ok: !!d.repo_url, label: 'Repo URL', required: false },
          { ok: d.tech_stack_tags.length >= 2, label: 'At least 2 stack tags', required: false },
          { ok: d.price_cents > 0, label: 'A price', required: false }
        ];
      }

      function paintQuality() {
        var checks = qualityChecks();
        var done = checks.filter(function (c) { return c.ok; }).length;
        var pct = Math.round((done / checks.length) * 100);
        var tone = pct >= 85 ? 'ok' : pct >= 50 ? 'mid' : 'low';

        el('quality').innerHTML =
          '<div class="q-head"><b>Listing completeness</b>' +
            '<span class="q-pct ' + tone + '">' + pct + '%</span></div>' +
          '<div class="q-bar"><i class="' + tone + '" style="width:' + pct + '%"></i></div>' +
          '<ul class="q-list">' + checks.map(function (c) {
            return '<li class="' + (c.ok ? 'on' : '') + '">' +
              '<span class="q-mark">' + (c.ok ? '✔' : '○') + '</span>' + esc(c.label) +
              (c.required && !c.ok ? '<em> — required to go live</em>' : '') +
            '</li>';
          }).join('') + '</ul>';
      }

      ['title', 'short', 'long', 'demo', 'repo', 'tags', 'setup', 'price'].forEach(function (id) {
        el(id).addEventListener('input', paintQuality);
      });
      paintQuality();

      var importBtn = el('import-btn');
      if (importBtn) {
        importBtn.onclick = function () {
          var msg = el('import-msg');
          var url = el('repo-url').value.trim();
          if (!url) { setMsg(msg, 'Paste a GitHub repo URL first.', 'err'); return; }

          importBtn.disabled = true;
          setMsg(msg, 'Reading the repo and drafting…');

          DB.importRepo(url).then(function (r) {
            importBtn.disabled = false;
            var d = r.draft || {};
            // Fill, don't overwrite: anything the seller already typed wins.
            if (!el('title').value) el('title').value = d.title || '';
            if (!el('short').value) el('short').value = d.short_description || '';
            if (!el('long').value) el('long').value = d.long_description || '';
            if (!el('setup').value) el('setup').value = d.setup_instructions || '';
            if (!el('repo').value) el('repo').value = d.repo_url || url;
            if (!el('tags').value) el('tags').value = (d.tech_stack_tags || []).join(', ');
            if (d.category) el('cat').value = d.category;
            paintQuality();

            var note = 'Draft filled in — read it before saving.' +
              (r.confidence === 'low'
                ? ' Claude flagged this one as low confidence, so check it closely.' : '') +
              (r.notes ? ' Note: ' + r.notes : '');
            setMsg(msg, note, r.confidence === 'low' ? 'err' : 'ok');
          }).catch(function (err) {
            importBtn.disabled = false;
            setMsg(msg, err.message, 'err');
          });
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
          setMsg(m, 'A short description is what buyers skim.', 'err'); return;
        }
        if (data.extended_price_cents !== null &&
            data.extended_price_cents <= data.price_cents) {
          setMsg(m, 'The unlimited-client price has to be higher than the single-client price.', 'err');
          return;
        }
        // Enforce only what the marketplace actually promises buyers. Everything
        // else in the meter is advice, not a gate.
        if (data.status === 'live' || data.status === 'pending_review') {
          var missing = qualityChecks().filter(function (c) { return c.required && !c.ok; });
          if (missing.length) {
            setMsg(m, missing[0].label + ' — ' + missing[0].why, 'err');
            el('quality').scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
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
            '<a class="btn btn-secondary" href="#/dashboard/seller">Back</a></div>';
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
                '<div class="badge-row" style="margin-top:8px">' +
                  '<span class="badge">' + money(p.amount_cents) + '</span>' +
                  '<span class="badge ' + (p.status === 'refunded' ? 'badge-danger' : 'badge-live') + '">' +
                    esc(p.status) + '</span>' +
                  '<span class="badge">' + (p.license === 'extended'
                    ? 'Unlimited clients' : 'Single client') + '</span>' +
                  (p.simulated ? '<span class="badge">simulated</span>' : '') +
                '</div>' +
              '</div>' +
              '<div class="spacer"></div>' +
              (l ? '<a class="btn btn-quiet btn-sm" href="#/listing/' + esc(l.id) + '">View listing</a>' : '') +
            '</div>' +

            '<div class="purchase-body">' +
              '<div>' +
                '<label>Repository</label>' +
                (l && l.repo_url
                  ? repoLink(l.repo_url)
                  : '<div class="hint">' + (p.status === 'refunded'
                      ? 'Access ended with the refund.'
                      : 'Unlocking — reload in a moment.') + '</div>') +

                '<div class="updates-slot"></div>' +

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
                    '<button class="btn btn-secondary btn-sm review-submit">Post review</button>' +
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

      // "Updated since you bought" — the reason the changelog exists.
      rows.forEach(function (p) {
        if (!p.listing) return;
        DB.listUpdates(p.listing.id).then(function (ups) {
          var since = ups.filter(function (u) { return u.created_at > p.created_at; });
          if (!since.length) return;
          var slot = document.querySelector('.purchase[data-id="' + p.id + '"] .updates-slot');
          if (!slot) return;
          slot.innerHTML =
            '<div class="update-alert">' +
              '<b>' + since.length + ' update' + (since.length === 1 ? '' : 's') + ' since you bought</b>' +
              '<p>' + esc(since[0].body.slice(0, 120)) + (since[0].body.length > 120 ? '…' : '') + '</p>' +
              '<a class="btn btn-secondary btn-sm" href="#/listing/' + esc(p.listing.id) + '">See changelog</a>' +
            '</div>';
        }).catch(function () { /* non-critical */ });
      });

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


  /* ------------------------------------------------------------- moderation
   *
   * The screen that did not exist. Before this, taking down a listing meant
   * editing the database by hand, which is not a thing you can do at 2am from a
   * phone when someone lists malware.
   *
   * Deliberately plain: a table, a reason box, two buttons. Moderation tools get
   * used under time pressure and the worst thing they can be is clever.
   */
  function viewAdmin() {
    if (!DB.currentUser()) {
      view.innerHTML = '<div class="empty"><h2>Sign in first</h2>' +
        '<a class="btn btn-primary" href="#/auth">Sign in</a></div>';
      return;
    }

    view.innerHTML = '<div class="loading">Checking…</div>';

    DB.isAdmin().then(function (admin) {
      if (!admin) {
        // Same message a non-existent page would give. No hint that the screen exists.
        view.innerHTML = '<div class="empty"><h2>Not found</h2>' +
          '<p>That page isn\'t here.</p>' +
          '<a class="btn btn-secondary" href="#/browse">Back to browse</a></div>';
        return;
      }
      return DB.moderationQueue().then(render);
    }).catch(function (e) {
      view.innerHTML = '<div class="empty"><h2>Could not load</h2><p>' + esc(e.message) + '</p></div>';
    });

    function render(rows) {
      rows = rows || [];
      var pending = rows.filter(function (r) { return r.status === 'pending_review'; });
      var live    = rows.filter(function (r) { return r.status === 'live'; });
      var other   = rows.filter(function (r) {
        return r.status !== 'pending_review' && r.status !== 'live';
      });

      view.innerHTML =
        '<div class="head-row"><h1>Moderate</h1>' +
          '<span class="hint">' + rows.length + ' listing' + (rows.length === 1 ? '' : 's') + '</span>' +
        '</div>' +
        section('Awaiting review', pending, 'Nothing waiting.') +
        section('Live', live, 'No live listings yet.') +
        section('Draft, delisted and archived', other, 'Nothing here.');

      wire();
    }

    function section(title, rows, emptyText) {
      if (!rows.length) {
        return '<h2 class="mod-h">' + esc(title) + '</h2>' +
               '<p class="hint" style="margin:0 0 20px">' + esc(emptyText) + '</p>';
      }
      return '<h2 class="mod-h">' + esc(title) + ' <span class="hint">(' + rows.length + ')</span></h2>' +
        '<div class="mod-list">' + rows.map(row).join('') + '</div>';
    }

    function row(r) {
      var demoWarn = r.demo_failures > 0
        ? '<span class="badge badge-danger">demo failing ×' + r.demo_failures + '</span>' : '';
      var refundWarn = r.refund_count > 0 && r.refund_count >= r.sales_count && r.sales_count > 0
        ? '<span class="badge badge-danger">all sales refunded</span>' : '';

      return '<div class="mod-row" data-id="' + esc(r.id) + '">' +
        '<div class="mod-main">' +
          '<div class="mod-title">' +
            '<a href="#/listing/' + esc(r.id) + '">' + esc(r.title) + '</a> ' +
            statusBadge(r.status) + demoWarn + refundWarn +
          '</div>' +
          '<div class="hint">' +
            'by <a href="#/seller/' + esc(r.seller_id) + '">' + esc(r.seller_name) + '</a>' +
            ' · ' + money(r.price_cents) +
            ' · ' + (r.sales_count || 0) + ' sold' +
            (r.refund_count ? ' · ' + r.refund_count + ' refunded' : '') +
          '</div>' +
          (r.demo_url ? '<div class="hint mono-sm">' + esc(r.demo_url) + '</div>' : '') +
        '</div>' +
        '<div class="mod-actions">' +
          '<input type="text" class="mod-reason" placeholder="Reason (kept on record)" ' +
            'aria-label="Reason for this change">' +
          (r.status === 'delisted'
            ? '<button class="btn btn-secondary btn-sm act" data-to="live">Restore</button>'
            : '<button class="btn btn-danger btn-sm act" data-to="delisted">Delist</button>') +
          (r.status === 'pending_review'
            ? '<button class="btn btn-primary btn-sm act" data-to="live">Approve</button>' : '') +
        '</div>' +
      '</div>';
    }

    function wire() {
      Array.prototype.forEach.call(view.querySelectorAll('.act'), function (btn) {
        btn.onclick = function () {
          var rowEl = btn.closest('.mod-row');
          var id = rowEl.getAttribute('data-id');
          var to = btn.getAttribute('data-to');
          var reason = (rowEl.querySelector('.mod-reason') || {}).value || '';

          if (to === 'delisted' && !confirm('Delist this listing? The seller keeps their data; it stops being public.')) return;

          btn.disabled = true;
          btn.textContent = '…';
          DB.setListingStatus(id, to, reason)
            .then(function () { return DB.moderationQueue().then(render); })
            .catch(function (e) {
              btn.disabled = false;
              alert(e.message || 'That did not work.');
            });
        };
      });
    }
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
      case 'requests':  return parts[1] === 'new' ? viewRequestForm() : viewRequests(query);
      case 'request':   return viewRequest(parts[1]);
      case 'auth':      return viewAuth();
      case 'admin':     return viewAdmin();
      case 'dashboard':
        if (parts[1] === 'buyer')   return viewBuyer();
        if (parts[1] === 'profile') return viewProfile();
        if (parts[2] === 'new')  return viewListingForm(null);
        if (parts[2] === 'edit') return viewListingForm(parts[3]);
        return viewSeller();
      default:
        view.innerHTML = '<div class="empty"><h3>No such page</h3>' +
          '<a class="btn btn-secondary" href="#/browse">Back to browse</a></div>';
    }
  }

  /* ------------------------------------------------------------- command palette
   * The audience is people who live on a keyboard. ⌘K jumps anywhere and searches
   * the catalog without a round trip through the browse page. */
  var palette = {
    open: false, items: [], active: 0, node: null,

    build: function () {
      if (this.node) return;
      var n = document.createElement('div');
      n.className = 'palette';
      n.innerHTML =
        '<div class="palette-sheet" role="dialog" aria-modal="true" aria-label="Command palette">' +
          '<input id="pal-input" placeholder="Jump to, or search tools…" autocomplete="off" ' +
            'aria-controls="pal-list" aria-expanded="true">' +
          '<ul id="pal-list" role="listbox"></ul>' +
          '<div class="palette-foot">' +
            '<span><kbd>↑</kbd><kbd>↓</kbd> move</span>' +
            '<span><kbd>↵</kbd> open</span>' +
            '<span><kbd>esc</kbd> close</span>' +
          '</div>' +
        '</div>';
      document.body.appendChild(n);
      this.node = n;

      n.addEventListener('click', function (e) {
        if (e.target === n) palette.close();
        var li = e.target.closest('li[data-i]');
        if (li) palette.run(Number(li.dataset.i));
      });

      n.querySelector('#pal-input').addEventListener('input', function (e) {
        palette.search(e.target.value);
      });

      n.querySelector('#pal-input').addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); palette.move(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); palette.move(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); palette.run(palette.active); }
      });
    },

    commands: function () {
      var u = DB.currentUser();
      var base = [
        { label: 'Browse tools', hint: 'catalog', go: '#/browse' },
        { label: 'Best rated', hint: 'sort', go: '#/browse?sort=rating' },
        { label: 'Cheapest first', hint: 'sort', go: '#/browse?sort=price_asc' }
      ];
      if (u) {
        base.push(
          { label: 'Your listings', hint: 'selling', go: '#/dashboard/seller' },
          { label: 'New listing', hint: 'selling', go: '#/dashboard/seller/new' },
          { label: 'Your purchases', hint: 'buying', go: '#/dashboard/buyer' },
          { label: 'Edit your profile', hint: 'account', go: '#/dashboard/profile' },
          { label: 'Sign out', hint: 'account', act: function () {
              DB.signOut().then(function () { paintNav(); go('#/browse'); render(); });
            } }
        );
      } else {
        base.push({ label: 'Sign in or sign up', hint: 'account', go: '#/auth' });
      }
      return base;
    },

    show: function () {
      this.build();
      this.open = true;
      this.node.classList.add('on');
      var input = this.node.querySelector('#pal-input');
      input.value = '';
      input.focus();
      this.search('');
    },

    close: function () {
      if (!this.node) return;
      this.open = false;
      this.node.classList.remove('on');
    },

    search: function (q) {
      var self = this;
      var term = q.trim().toLowerCase();

      var cmds = this.commands().filter(function (c) {
        return !term || c.label.toLowerCase().indexOf(term) !== -1;
      });

      if (!term) { self.items = cmds; self.active = 0; self.paint(); return; }

      // Catalog search runs alongside the static commands.
      DB.listListings({ q: term }).then(function (rows) {
        var listings = rows.filter(function (l) { return l.status === 'live'; })
          .slice(0, 6).map(function (l) {
            return { label: l.title, hint: money(l.price_cents), go: '#/listing/' + l.id };
          });
        self.items = cmds.concat(listings);
        self.active = 0;
        self.paint();
      }).catch(function () { self.items = cmds; self.active = 0; self.paint(); });
    },

    paint: function () {
      var list = this.node.querySelector('#pal-list');
      if (!this.items.length) {
        list.innerHTML = '<li class="pal-empty">Nothing matches.</li>';
        return;
      }
      var self = this;
      list.innerHTML = this.items.map(function (it, i) {
        return '<li data-i="' + i + '" role="option" aria-selected="' + (i === self.active) + '"' +
          (i === self.active ? ' class="active"' : '') + '>' +
          '<span>' + esc(it.label) + '</span>' +
          '<span class="pal-hint">' + esc(it.hint || '') + '</span></li>';
      }).join('');
    },

    move: function (delta) {
      if (!this.items.length) return;
      this.active = (this.active + delta + this.items.length) % this.items.length;
      this.paint();
      var el2 = this.node.querySelector('li.active');
      if (el2) el2.scrollIntoView({ block: 'nearest' });
    },

    run: function (i) {
      var it = this.items[i];
      if (!it) return;
      this.close();
      if (it.act) it.act();
      else if (it.go) go(it.go);
    }
  };

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      palette.open ? palette.close() : palette.show();
      return;
    }
    if (e.key === 'Escape' && palette.open) palette.close();
  });

  /* The header search is the marketplace-standard entry point; it drives browse
     rather than being a second, competing search. */
  var headerSearch = el('hsearch');
  if (headerSearch) {
    headerSearch.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var q = e.target.value.trim();
      go('#/browse' + (q ? '?q=' + encodeURIComponent(q) : ''));
      e.target.blur();
    });
    // Clicking it with ⌘K muscle memory should still work.
    headerSearch.addEventListener('focus', function () {
      if (window.innerWidth > 860) return;
      palette.show();
      this.blur();
    });
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
