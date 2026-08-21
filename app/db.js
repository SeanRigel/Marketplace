/* Forkable data layer.
 *
 * One interface, two backends. When config.js has Supabase credentials we talk to
 * the real project over PostgREST + GoTrue with plain fetch (no SDK, no build step).
 * When it doesn't, an equivalent localStorage backend takes over so the whole app
 * is clickable before the project exists.
 *
 * The local backend deliberately mirrors the RLS rules in supabase/schema.sql —
 * drafts are owner-only, repo_url is withheld unless you own or bought the listing.
 * If you change a policy there, change the matching guard here or the two modes
 * will disagree about what a user can see.
 */
(function () {
  'use strict';

  var CFG = window.FORKABLE_CONFIG || {};
  var LIVE = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  var SESSION_KEY = 'forkable_session';

  var CATEGORIES = ['scheduling', 'dashboard', 'intake_form', 'payroll', 'ai_integration', 'other'];
  var STATUSES = ['draft', 'pending_review', 'live', 'delisted'];

  function nowISO() { return new Date().toISOString(); }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  /* ============================================================ local backend */

  function LocalBackend() {
    var K = {
      users: 'forkable_local_users',
      listings: 'forkable_local_listings',
      purchases: 'forkable_local_purchases',
      reviews: 'forkable_local_reviews',
      health: 'forkable_local_health',
      updates: 'forkable_local_updates',
      requests: 'forkable_local_requests',
      responses: 'forkable_local_responses'
    };

    function read(k) {
      try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch (e) { return []; }
    }
    function write(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

    /* Not a security boundary — this backend is a stand-in for a real auth server
     * and never leaves the browser. It exists so we don't keep plaintext passwords
     * lying around in localStorage during development. */
    function hash(email, password) {
      var data = new TextEncoder().encode('forkable:' + email.toLowerCase() + ':' + password);
      return crypto.subtle.digest('SHA-256', data).then(function (buf) {
        return Array.from(new Uint8Array(buf)).map(function (b) {
          return b.toString(16).padStart(2, '0');
        }).join('');
      });
    }

    function session() {
      try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
    }
    function setSession(s) {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    }
    function uid() { var s = session(); return s ? s.user.id : null; }

    /* Seed the three real tools so /browse isn't empty on a fresh machine. */
    function seed() {
      if (localStorage.getItem('forkable_local_seeded')) return;
      var seedListings = window.FORKABLE_LISTINGS || [];
      var users = read(K.users);
      var sellerId = uuid();
      users.push({
        id: sellerId, email: 'rigel@forkable.dev', pw: null,
        display_name: 'Rigel', role: 'both', bio: 'Builds operational tools for local businesses.',
        created_at: nowISO(), seeded: true
      });
      write(K.users, users);
      write(K.listings, seedListings.map(function (l) {
        return {
          id: uuid(), seller_id: sellerId, title: l.title,
          short_description: l.shortDescription, long_description: l.longDescription,
          category: l.category, price_cents: l.priceCents,
          repo_url: 'https://github.com/rigel/' + l.id,
          // Root-relative: index.html and app.html both live at the repo root.
          // '../' happened to work only because browsers clamp it there.
          demo_url: l.demo,
          setup_instructions: '## Setup\n\n1. Clone the template repo.\n2. Copy `.env.example` to `.env`.\n3. Deploy to any static host.\n\nEstimated time: ~' + l.deployMinutes + ' minutes.',
          tech_stack_tags: l.stack, status: 'live',
          created_at: nowISO(), updated_at: nowISO()
        };
      }));
      localStorage.setItem('forkable_local_seeded', '1');
    }
    seed();

    function profileOf(id) {
      var u = read(K.users).filter(function (x) { return x.id === id; })[0];
      if (!u) return null;
      return { id: u.id, display_name: u.display_name, role: u.role, bio: u.bio, created_at: u.created_at };
    }

    /* Mirrors listing_repo_url(): seller or completed buyer only. */
    function canSeeRepo(listing) {
      var me = uid();
      if (!me) return false;
      if (listing.seller_id === me) return true;
      return read(K.purchases).some(function (p) {
        return p.listing_id === listing.id && p.buyer_id === me && p.status === 'complete';
      });
    }

    /* Mirrors listing_ratings: every review hangs off a purchase, so a rating
     * can only exist where a real purchase did. */
    function ratingFor(listingId) {
      var purchaseIds = read(K.purchases).filter(function (p) {
        return p.listing_id === listingId;
      }).map(function (p) { return p.id; });

      var rs = read(K.reviews).filter(function (r) {
        return purchaseIds.indexOf(r.purchase_id) !== -1;
      });
      if (!rs.length) return { review_count: 0, avg_rating: null };
      var sum = rs.reduce(function (s, r) { return s + r.rating; }, 0);
      return { review_count: rs.length, avg_rating: Math.round((sum / rs.length) * 100) / 100 };
    }

    function decorate(l) {
      var out = Object.assign({}, l);
      var seller = profileOf(l.seller_id) || {};
      out.seller_name = seller.display_name || 'Unknown';
      out.seller_bio = seller.bio || null;

      var r = ratingFor(l.id);
      out.review_count = r.review_count;
      out.avg_rating = r.avg_rating;

      var h = read(K.health).filter(function (x) { return x.listing_id === l.id; })[0];
      out.demo_status = h ? h.status : null;
      out.demo_last_checked_at = h ? h.last_checked_at : null;
      out.demo_consecutive_failures = h ? h.consecutive_failures : 0;

      var ups = read(K.updates).filter(function (u) { return u.listing_id === l.id; })
        .sort(function (a, b) { return b.created_at.localeCompare(a.created_at); });
      out.update_count = ups.length;
      out.last_update_at = ups.length ? ups[0].created_at : null;
      out.latest_version = (ups.filter(function (u) { return u.version; })[0] || {}).version || null;

      if (!canSeeRepo(l)) delete out.repo_url;
      return out;
    }

    return {
      mode: 'local',
      categories: CATEGORIES,
      statuses: STATUSES,

      signUp: function (email, password, displayName, role) {
        var users = read(K.users);
        if (users.some(function (u) { return u.email.toLowerCase() === email.toLowerCase(); })) {
          return Promise.reject(new Error('An account with that email already exists.'));
        }
        return hash(email, password).then(function (pw) {
          var u = {
            id: uuid(), email: email, pw: pw,
            display_name: displayName || email.split('@')[0],
            role: role || 'both', bio: null, created_at: nowISO()
          };
          users.push(u);
          write(K.users, users);
          setSession({ user: { id: u.id, email: u.email } });
          return profileOf(u.id);
        });
      },

      signIn: function (email, password) {
        var u = read(K.users).filter(function (x) {
          return x.email.toLowerCase() === email.toLowerCase();
        })[0];
        if (!u) return Promise.reject(new Error('No account with that email.'));
        if (!u.pw) return Promise.reject(new Error('That is the seeded demo seller — sign up with your own email.'));
        return hash(email, password).then(function (pw) {
          if (pw !== u.pw) throw new Error('Wrong password.');
          setSession({ user: { id: u.id, email: u.email } });
          return profileOf(u.id);
        });
      },

      signOut: function () { setSession(null); return Promise.resolve(); },

      currentUser: function () { var s = session(); return s ? s.user : null; },

      myProfile: function () {
        var id = uid();
        return Promise.resolve(id ? profileOf(id) : null);
      },

      updateProfile: function (patch) {
        var id = uid(), users = read(K.users);
        users.forEach(function (u) {
          if (u.id !== id) return;
          if (patch.display_name !== undefined) u.display_name = patch.display_name;
          if (patch.bio !== undefined) u.bio = patch.bio;
          if (patch.role !== undefined) u.role = patch.role;
        });
        write(K.users, users);
        return Promise.resolve(profileOf(id));
      },

      listListings: function (opts) {
        opts = opts || {};
        var me = uid();
        var rows = read(K.listings).filter(function (l) {
          return l.status === 'live' || l.seller_id === me;   // matches the select policy
        });
        if (opts.category) rows = rows.filter(function (l) { return l.category === opts.category; });
        if (opts.tag) {
          rows = rows.filter(function (l) {
            return (l.tech_stack_tags || []).some(function (t) {
              return t.toLowerCase() === opts.tag.toLowerCase();
            });
          });
        }
        if (opts.q) {
          var q = opts.q.toLowerCase();
          rows = rows.filter(function (l) {
            return (l.title + ' ' + l.short_description + ' ' + (l.tech_stack_tags || []).join(' '))
              .toLowerCase().indexOf(q) !== -1;
          });
        }

        var out = rows.map(decorate);
        var sorts = {
          newest: function (a, b) { return b.created_at.localeCompare(a.created_at); },
          price_asc: function (a, b) { return a.price_cents - b.price_cents; },
          price_desc: function (a, b) { return b.price_cents - a.price_cents; },
          // Unrated listings sort last rather than sorting as zero.
          rating: function (a, b) {
            return (b.avg_rating === null ? -1 : b.avg_rating) - (a.avg_rating === null ? -1 : a.avg_rating);
          }
        };
        out.sort(sorts[opts.sort] || sorts.newest);
        return Promise.resolve(out);
      },

      myListings: function () {
        var me = uid();
        if (!me) return Promise.resolve([]);
        var rows = read(K.listings).filter(function (l) { return l.seller_id === me; });
        rows.sort(function (a, b) { return b.updated_at.localeCompare(a.updated_at); });
        return Promise.resolve(rows.map(decorate));
      },

      getListing: function (id) {
        var me = uid();
        var l = read(K.listings).filter(function (x) { return x.id === id; })[0];
        if (!l) return Promise.resolve(null);
        if (l.status !== 'live' && l.seller_id !== me) return Promise.resolve(null);
        return Promise.resolve(decorate(l));
      },

      /* The CHECK constraints from schema.sql and licenses_and_requests.sql,
       * enforced here too.
       *
       * Postgres refuses these rows outright, so without the same check local
       * mode can reach states production cannot: a negative price, or an
       * "unlimited clients" tier that costs less than the single-client one.
       * The listing form already blocks both, but the form is not a boundary
       * (a seller can call DB directly, and does — that is how the test listing
       * for scar #3 was created). Keeping the mock exactly as strict as the
       * database is the whole reason local mode is trustworthy. */
      _checkListing: function (row) {
        if (Number(row.price_cents) < 0) {
          return 'Price cannot be negative.';                      // price_cents >= 0
        }
        if (row.extended_price_cents !== null && row.extended_price_cents !== undefined &&
            Number(row.extended_price_cents) <= Number(row.price_cents)) {
          return 'The extended licence has to cost more than the single licence.';
        }
        return null;                                               // listings_extended_price_check
      },

      createListing: function (data) {
        var me = uid();
        if (!me) return Promise.reject(new Error('Sign in first.'));
        var rows = read(K.listings);
        var row = Object.assign({
          id: uuid(), seller_id: me, created_at: nowISO(), updated_at: nowISO()
        }, data);
        var bad = this._checkListing(row);
        if (bad) return Promise.reject(new Error(bad));
        rows.push(row);
        write(K.listings, rows);
        return Promise.resolve(decorate(row));
      },

      updateListing: function (id, patch) {
        var me = uid(), rows = read(K.listings), found = null, bad = null;
        var self = this;
        rows.forEach(function (l) {
          if (l.id !== id || l.seller_id !== me) return;   // matches the update policy
          // Validate the row as it WOULD be, before committing anything.
          var candidate = Object.assign({}, l, patch);
          bad = self._checkListing(candidate);
          if (bad) return;
          Object.assign(l, patch, { updated_at: nowISO() });
          found = l;
        });
        if (bad) return Promise.reject(new Error(bad));
        if (!found) return Promise.reject(new Error('Listing not found, or not yours.'));
        write(K.listings, rows);
        return Promise.resolve(decorate(found));
      },

      deleteListing: function (id) {
        var me = uid(), rows = read(K.listings);
        var kept = rows.filter(function (l) { return !(l.id === id && l.seller_id === me); });
        if (kept.length === rows.length) return Promise.reject(new Error('Listing not found, or not yours.'));
        write(K.listings, kept);
        return Promise.resolve();
      },

      myPurchases: function () {
        var me = uid();
        if (!me) return Promise.resolve([]);
        var listings = read(K.listings);
        return Promise.resolve(read(K.purchases).filter(function (p) {
          return p.buyer_id === me;
        }).map(function (p) {
          var l = listings.filter(function (x) { return x.id === p.listing_id; })[0];
          return Object.assign({}, p, { listing: l ? decorate(l) : null });
        }));
      },

      settings: function () {
        return Promise.resolve({ platform_fee_bps: 1500, refund_window_days: 14 });
      },

      /* Local mode has no Stripe, so checkout completes instantly and books the
       * purchase itself. This is the only place the two backends genuinely differ
       * in behaviour rather than just in transport — it exists so the guarantee
       * mechanic (repo unlock, countdown, self-serve refund) can be exercised
       * before a Stripe account exists. Live mode never calls this. */
      startCheckout: function (listingId, license) {
        var me = uid();
        if (!me) return Promise.reject(new Error('Sign in first.'));

        var l = read(K.listings).filter(function (x) { return x.id === listingId; })[0];
        if (!l) return Promise.reject(new Error('Listing not found.'));
        if (l.seller_id === me) return Promise.reject(new Error('You cannot buy your own listing.'));

        var purchases = read(K.purchases);
        if (purchases.some(function (p) {
          return p.listing_id === listingId && p.buyer_id === me &&
                 (p.status === 'complete' || p.status === 'pending');
        })) return Promise.reject(new Error('You already own this tool.'));

        var tier = license === 'extended' ? 'extended' : 'single';
        if (tier === 'extended' && !l.extended_price_cents) {
          return Promise.reject(new Error('This seller does not offer an extended licence.'));
        }
        // Same rule as the server: the tier picks which stored price applies.
        var amount = tier === 'extended' ? l.extended_price_cents : l.price_cents;
        var fee = Math.round(amount * 0.15);

        purchases.push({
          id: uuid(), listing_id: listingId, buyer_id: me, seller_id: l.seller_id,
          stripe_payment_intent_id: null, amount_cents: amount,
          platform_fee_cents: fee, status: 'complete', license: tier,
          refund_window_expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
          payout_transfer_id: null, payout_released_at: null,
          created_at: nowISO(), simulated: true
        });
        write(K.purchases, purchases);
        return Promise.resolve({ simulated: true });
      },

      requestRefund: function (purchaseId) {
        var me = uid(), purchases = read(K.purchases), found = null;
        purchases.forEach(function (p) {
          if (p.id !== purchaseId || p.buyer_id !== me) return;
          found = p;
        });
        if (!found) return Promise.reject(new Error('That is not your purchase.'));
        if (found.status === 'refunded') return Promise.resolve({ refunded: true, already: true });
        if (new Date(found.refund_window_expires_at).getTime() < Date.now()) {
          return Promise.reject(new Error('The refund window for this purchase has closed.'));
        }
        found.status = 'refunded';
        found.refunded_at = nowISO();
        write(K.purchases, purchases);
        return Promise.resolve({ refunded: true });
      },

      connectStatus: function () {
        return Promise.resolve({ connected: false, charges_enabled: false, payouts_enabled: false, local: true });
      },

      startConnect: function () {
        return Promise.reject(new Error('Stripe onboarding needs the live backend — add Supabase and Stripe keys first.'));
      },

      /* ---- reviews ---- */

      listReviews: function (listingId) {
        var purchases = read(K.purchases);
        var byId = {};
        purchases.forEach(function (p) { byId[p.id] = p; });

        return Promise.resolve(read(K.reviews).filter(function (r) {
          var p = byId[r.purchase_id];
          return p && p.listing_id === listingId;
        }).map(function (r) {
          var p = byId[r.purchase_id];
          return Object.assign({}, r, {
            listing_id: p.listing_id,
            reviewer_name: (profileOf(p.buyer_id) || {}).display_name || 'A buyer'
          });
        }).sort(function (a, b) { return b.created_at.localeCompare(a.created_at); }));
      },

      /* Mirrors the insert policy: only the buyer of a complete purchase, one
       * review per purchase (the unique constraint, enforced here by hand). */
      createReview: function (purchaseId, rating, body) {
        var me = uid();
        if (!me) return Promise.reject(new Error('Sign in first.'));
        if (!(rating >= 1 && rating <= 5)) return Promise.reject(new Error('Pick a rating from 1 to 5.'));

        var p = read(K.purchases).filter(function (x) { return x.id === purchaseId; })[0];
        if (!p || p.buyer_id !== me) return Promise.reject(new Error('That is not your purchase.'));
        if (p.status !== 'complete') return Promise.reject(new Error('You can only review a completed purchase.'));

        var reviews = read(K.reviews);
        if (reviews.some(function (r) { return r.purchase_id === purchaseId; })) {
          return Promise.reject(new Error('You already reviewed this purchase.'));
        }

        var row = {
          id: uuid(), purchase_id: purchaseId, rating: rating,
          body: (body || '').slice(0, 2000) || null, created_at: nowISO()
        };
        reviews.push(row);
        write(K.reviews, reviews);
        return Promise.resolve(row);
      },

      myReviewFor: function (purchaseId) {
        return Promise.resolve(read(K.reviews).filter(function (r) {
          return r.purchase_id === purchaseId;
        })[0] || null);
      },

      /* ---- request board ---- */

      listRequests: function (opts) {
        opts = opts || {};
        var users = read(K.users);
        var responses = read(K.responses);

        var rows = read(K.requests).filter(function (r) {
          if (opts.status && r.status !== opts.status) return false;
          if (opts.category && r.category !== opts.category) return false;
          if (opts.mine) return r.author_id === uid();
          return true;
        });

        rows.sort(function (a, b) { return b.created_at.localeCompare(a.created_at); });

        return Promise.resolve(rows.map(function (r) {
          var author = users.filter(function (u) { return u.id === r.author_id; })[0];
          return Object.assign({}, r, {
            author_name: (author || {}).display_name || 'Someone',
            response_count: responses.filter(function (x) { return x.request_id === r.id; }).length
          });
        }));
      },

      getRequest: function (id) {
        var r = read(K.requests).filter(function (x) { return x.id === id; })[0];
        if (!r) return Promise.resolve(null);
        var author = read(K.users).filter(function (u) { return u.id === r.author_id; })[0];
        return Promise.resolve(Object.assign({}, r, {
          author_name: (author || {}).display_name || 'Someone',
          response_count: read(K.responses).filter(function (x) { return x.request_id === id; }).length
        }));
      },

      createRequest: function (data) {
        var me = uid();
        if (!me) return Promise.reject(new Error('Sign in first.'));
        if (!data.title || !data.title.trim()) return Promise.reject(new Error('Give it a title.'));

        var rows = read(K.requests);
        var row = {
          id: uuid(), author_id: me,
          title: data.title.trim(),
          body: (data.body || '').trim(),
          category: data.category || 'other',
          budget_cents: data.budget_cents || null,
          status: 'open',
          created_at: nowISO(), updated_at: nowISO()
        };
        rows.push(row);
        write(K.requests, rows);
        return Promise.resolve(row);
      },

      updateRequest: function (id, patch) {
        var me = uid(), rows = read(K.requests), found = null;
        rows.forEach(function (r) {
          if (r.id !== id || r.author_id !== me) return;
          Object.assign(r, patch, { updated_at: nowISO() });
          found = r;
        });
        if (!found) return Promise.reject(new Error('Not your request.'));
        write(K.requests, rows);
        return Promise.resolve(found);
      },

      listResponses: function (requestId) {
        var users = read(K.users);
        var listings = read(K.listings);
        return Promise.resolve(read(K.responses).filter(function (x) {
          return x.request_id === requestId;
        }).map(function (x) {
          var seller = users.filter(function (u) { return u.id === x.seller_id; })[0];
          var l = listings.filter(function (y) { return y.id === x.listing_id; })[0];
          return Object.assign({}, x, {
            seller_name: (seller || {}).display_name || 'A builder',
            listing_title: l && l.status === 'live' ? l.title : null
          });
        }).sort(function (a, b) { return a.created_at.localeCompare(b.created_at); }));
      },

      /* Mirrors the unique index: one reply per seller per request. */
      respondToRequest: function (requestId, body, listingId) {
        var me = uid();
        if (!me) return Promise.reject(new Error('Sign in first.'));
        if (!body || !body.trim()) return Promise.reject(new Error('Say something.'));

        var rows = read(K.responses);
        var existing = rows.filter(function (x) {
          return x.request_id === requestId && x.seller_id === me;
        })[0];

        if (existing) {
          existing.body = body.trim();
          existing.listing_id = listingId || null;
          write(K.responses, rows);
          return Promise.resolve(existing);
        }

        var row = {
          id: uuid(), request_id: requestId, seller_id: me,
          body: body.trim(), listing_id: listingId || null, created_at: nowISO()
        };
        rows.push(row);
        write(K.responses, rows);
        return Promise.resolve(row);
      },

      /* ---- GitHub import ---- */

      importRepo: function () {
        return Promise.reject(new Error(
          'Repo import runs server-side through Claude — it needs the live backend ' +
          'and an ANTHROPIC_API_KEY. Fill the listing in by hand for now.'
        ));
      },

      /* ---- changelog ---- */

      listUpdates: function (listingId) {
        return Promise.resolve(read(K.updates).filter(function (u) {
          return u.listing_id === listingId;
        }).sort(function (a, b) { return b.created_at.localeCompare(a.created_at); }));
      },

      createUpdate: function (listingId, version, body) {
        var me = uid();
        if (!me) return Promise.reject(new Error('Sign in first.'));
        var l = read(K.listings).filter(function (x) { return x.id === listingId; })[0];
        if (!l || l.seller_id !== me) return Promise.reject(new Error('That is not your listing.'));
        if (!body || !body.trim()) return Promise.reject(new Error('Say what changed.'));

        var rows = read(K.updates);
        var row = {
          id: uuid(), listing_id: listingId,
          version: (version || '').trim() || null,
          body: body.trim().slice(0, 4000),
          created_at: nowISO()
        };
        rows.push(row);
        write(K.updates, rows);
        return Promise.resolve(row);
      },

      deleteUpdate: function (id) {
        var me = uid();
        var listingsById = {};
        read(K.listings).forEach(function (l) { listingsById[l.id] = l; });

        var rows = read(K.updates);
        var kept = rows.filter(function (u) {
          var l = listingsById[u.listing_id];
          return !(u.id === id && l && l.seller_id === me);
        });
        if (kept.length === rows.length) return Promise.reject(new Error('Not found, or not yours.'));
        write(K.updates, kept);
        return Promise.resolve();
      },

      /* ---- related listings ---- */

      relatedListings: function (listing, limit) {
        var me = uid();
        var tags = (listing.tech_stack_tags || []).map(function (t) { return t.toLowerCase(); });
        var rows = read(K.listings).filter(function (l) {
          return l.id !== listing.id && (l.status === 'live' || l.seller_id === me);
        }).filter(function (l) { return l.status === 'live'; });

        var scored = rows.map(function (l) {
          var shared = (l.tech_stack_tags || []).filter(function (t) {
            return tags.indexOf(t.toLowerCase()) !== -1;
          }).length;
          // Same category is a weaker signal than a shared stack, but still a signal.
          return { l: l, score: shared * 2 + (l.category === listing.category ? 1 : 0) };
        }).filter(function (x) { return x.score > 0; });

        scored.sort(function (a, b) { return b.score - a.score; });
        return Promise.resolve(scored.slice(0, limit || 3).map(function (x) { return decorate(x.l); }));
      },

      /* ---- public seller profile ---- */

      getSeller: function (id) {
        var u = profileOf(id);
        if (!u) return Promise.resolve(null);
        var listings = read(K.listings).filter(function (l) {
          return l.seller_id === id && l.status === 'live';
        });
        var counts = listings.reduce(function (acc, l) {
          var r = ratingFor(l.id);
          acc.n += r.review_count;
          acc.sum += (r.avg_rating || 0) * r.review_count;
          return acc;
        }, { n: 0, sum: 0 });

        return Promise.resolve({
          id: u.id, display_name: u.display_name, bio: u.bio, created_at: u.created_at,
          live_listing_count: listings.length,
          review_count: counts.n,
          avg_rating: counts.n ? Math.round((counts.sum / counts.n) * 100) / 100 : null
        });
      },

      listingsBySeller: function (id) {
        var me = uid();
        var rows = read(K.listings).filter(function (l) {
          return l.seller_id === id && (l.status === 'live' || l.seller_id === me);
        });
        rows.sort(function (a, b) { return b.created_at.localeCompare(a.created_at); });
        return Promise.resolve(rows.map(decorate));
      },

      /* ---- demo health ---- */

      checkDemo: function (url) {
        // No server here, so this is the honest answer rather than a fake pass.
        return Promise.resolve({
          ok: null,
          error: 'Demo testing needs the live backend (it runs server-side). ' +
                 'Open the URL yourself to confirm it works.'
        });
      },

      sellerEarnings: function () {
        var me = uid();
        if (!me) return Promise.resolve(null);
        var mineIds = read(K.listings).filter(function (l) { return l.seller_id === me; })
          .map(function (l) { return l.id; });
        var rows = read(K.purchases).filter(function (p) { return mineIds.indexOf(p.listing_id) !== -1; });
        var net = function (p) { return p.amount_cents - p.platform_fee_cents; };
        return Promise.resolve({
          sales_count: rows.filter(function (p) { return p.status === 'complete'; }).length,
          held_cents: rows.filter(function (p) { return p.status === 'complete' && !p.payout_released_at; })
            .reduce(function (s, p) { return s + net(p); }, 0),
          paid_out_cents: rows.filter(function (p) { return p.payout_released_at; })
            .reduce(function (s, p) { return s + net(p); }, 0),
          refund_count: rows.filter(function (p) { return p.status === 'refunded'; }).length
        });
      }
    };
  }

  /* ========================================================= supabase backend */

  function SupabaseBackend() {
    var base = CFG.supabaseUrl.replace(/\/$/, '');
    var anon = CFG.supabaseAnonKey;

    function session() {
      try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
    }
    function setSession(s) {
      if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else localStorage.removeItem(SESSION_KEY);
    }
    function token() { var s = session(); return (s && s.access_token) || anon; }

    function headers(extra) {
      return Object.assign({
        'apikey': anon,
        'Authorization': 'Bearer ' + token(),
        'Content-Type': 'application/json'
      }, extra || {});
    }

    function req(path, opts) {
      opts = opts || {};
      return fetch(base + path, {
        method: opts.method || 'GET',
        headers: headers(opts.headers),
        body: opts.body ? JSON.stringify(opts.body) : undefined
      }).then(function (res) {
        if (res.status === 204) return null;
        return res.json().catch(function () { return null; }).then(function (json) {
          if (!res.ok) {
            var m = (json && (json.msg || json.message || json.error_description || json.error)) ||
                    ('Request failed (' + res.status + ')');
            throw new Error(m);
          }
          return json;
        });
      });
    }

    function rest(path, opts) { return req('/rest/v1' + path, opts); }

    return {
      mode: 'supabase',
      categories: CATEGORIES,
      statuses: STATUSES,

      signUp: function (email, password, displayName, role) {
        return req('/auth/v1/signup', {
          method: 'POST',
          body: { email: email, password: password, data: { display_name: displayName, role: role } }
        }).then(function (r) {
          // With email confirmation on, there's no session yet — that's not an error.
          if (r && r.access_token) setSession(r);
          return r;
        });
      },

      signIn: function (email, password) {
        return req('/auth/v1/token?grant_type=password', {
          method: 'POST', body: { email: email, password: password }
        }).then(function (r) { setSession(r); return r; });
      },

      signOut: function () {
        var s = session();
        setSession(null);
        if (!s) return Promise.resolve();
        return req('/auth/v1/logout', { method: 'POST' }).catch(function () { /* token already dead */ });
      },

      currentUser: function () { var s = session(); return s ? s.user : null; },

      myProfile: function () {
        var u = this.currentUser();
        if (!u) return Promise.resolve(null);
        return rest('/profiles?select=*&id=eq.' + u.id).then(function (r) { return r && r[0]; });
      },

      updateProfile: function (patch) {
        var u = this.currentUser();
        return rest('/profiles?id=eq.' + u.id, {
          method: 'PATCH', body: patch, headers: { 'Prefer': 'return=representation' }
        }).then(function (r) { return r && r[0]; });
      },

      listListings: function (opts) {
        opts = opts || {};
        var ORDER = {
          newest: 'created_at.desc',
          price_asc: 'price_cents.asc',
          price_desc: 'price_cents.desc',
          // nullslast keeps unrated listings from topping a rating sort.
          rating: 'avg_rating.desc.nullslast'
        };
        var q = '/listings_with_seller?select=*&status=eq.live' +
                '&order=' + (ORDER[opts.sort] || ORDER.newest);

        if (opts.category) q += '&category=eq.' + encodeURIComponent(opts.category);
        if (opts.tag) q += '&tech_stack_tags=cs.{' + encodeURIComponent(opts.tag) + '}';
        if (opts.q) {
          // Match title OR short_description; PostgREST `or` takes a comma-joined filter list.
          var safe = opts.q.replace(/[(),*]/g, ' ');
          q += '&or=(title.ilike.*' + encodeURIComponent(safe) + '*,short_description.ilike.*' +
               encodeURIComponent(safe) + '*)';
        }
        return rest(q);
      },

      listReviews: function (listingId) {
        return rest('/reviews_public?select=*&listing_id=eq.' + listingId + '&order=created_at.desc');
      },

      createReview: function (purchaseId, rating, body) {
        return rest('/reviews', {
          method: 'POST',
          body: { purchase_id: purchaseId, rating: rating, body: (body || '').slice(0, 2000) || null },
          headers: { 'Prefer': 'return=representation' }
        }).then(function (r) { return r && r[0]; });
      },

      myReviewFor: function (purchaseId) {
        return rest('/reviews?select=*&purchase_id=eq.' + purchaseId)
          .then(function (r) { return (r && r[0]) || null; });
      },

      getSeller: function (id) {
        return rest('/seller_public?select=*&id=eq.' + id)
          .then(function (r) { return (r && r[0]) || null; });
      },

      listUpdates: function (listingId) {
        return rest('/listing_updates?select=*&listing_id=eq.' + listingId + '&order=created_at.desc');
      },

      createUpdate: function (listingId, version, body) {
        return rest('/listing_updates', {
          method: 'POST',
          body: {
            listing_id: listingId,
            version: (version || '').trim() || null,
            body: (body || '').trim().slice(0, 4000)
          },
          headers: { 'Prefer': 'return=representation' }
        }).then(function (r) { return r && r[0]; });
      },

      deleteUpdate: function (id) {
        return rest('/listing_updates?id=eq.' + id, { method: 'DELETE' });
      },

      relatedListings: function (listing, limit) {
        var tags = listing.tech_stack_tags || [];
        // Overlaps on any shared tag, else falls back to the same category.
        var filter = tags.length
          ? '&or=(tech_stack_tags.ov.{' + tags.map(encodeURIComponent).join(',') + '},category.eq.' +
            encodeURIComponent(listing.category) + ')'
          : '&category=eq.' + encodeURIComponent(listing.category);

        return rest('/listings_with_seller?select=*&status=eq.live&id=neq.' + listing.id +
                    filter + '&limit=' + (limit || 3));
      },

      listingsBySeller: function (id) {
        return rest('/listings_with_seller?select=*&seller_id=eq.' + id + '&order=created_at.desc');
      },

      checkDemo: function (url) {
        return this.api('/api/check-demo', { method: 'POST', body: { url: url } });
      },

      myListings: function () {
        var u = this.currentUser();
        if (!u) return Promise.resolve([]);
        return rest('/listings_with_seller?select=*&seller_id=eq.' + u.id + '&order=updated_at.desc');
      },

      getListing: function (id) {
        return rest('/listings_with_seller?select=*&id=eq.' + id)
          .then(function (r) { return (r && r[0]) || null; });
      },

      /* repo_url is column-revoked, so it comes back through the security-definer
         function rather than the table. Null means the caller has no claim to it. */
      repoUrl: function (id) {
        return req('/rest/v1/rpc/listing_repo_url', {
          method: 'POST', body: { p_listing: id }
        }).catch(function () { return null; });
      },

      createListing: function (data) {
        var u = this.currentUser();
        return rest('/listings', {
          method: 'POST',
          body: Object.assign({ seller_id: u.id }, data),
          headers: { 'Prefer': 'return=representation' }
        }).then(function (r) { return r && r[0]; });
      },

      updateListing: function (id, patch) {
        return rest('/listings?id=eq.' + id, {
          method: 'PATCH', body: patch, headers: { 'Prefer': 'return=representation' }
        }).then(function (r) {
          if (!r || !r.length) throw new Error('Listing not found, or not yours.');
          return r[0];
        });
      },

      deleteListing: function (id) {
        return rest('/listings?id=eq.' + id, { method: 'DELETE' });
      },

      myPurchases: function () {
        var u = this.currentUser();
        if (!u) return Promise.resolve([]);
        return rest('/purchases?select=*,listing:listings_with_seller(*)&buyer_id=eq.' + u.id +
                    '&order=created_at.desc');
      },

      settings: function () {
        return rest('/platform_settings?select=*&limit=1').then(function (r) {
          return (r && r[0]) || { platform_fee_bps: 1500, refund_window_days: 14 };
        });
      },

      /* All of the following go through Pages Functions rather than PostgREST:
         they need the Stripe secret key, which must never reach the browser. */
      api: function (path, opts) {
        opts = opts || {};
        var s = session();
        return fetch(path, {
          method: opts.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + ((s && s.access_token) || '')
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined
        }).then(function (res) {
          return res.json().catch(function () { return null; }).then(function (j) {
            if (!res.ok) throw new Error((j && j.error) || ('Request failed (' + res.status + ')'));
            return j;
          });
        });
      },

      startCheckout: function (listingId, license) {
        return this.api('/api/checkout', {
          method: 'POST',
          body: { listing_id: listingId, license: license === 'extended' ? 'extended' : 'single' }
        });
      },

      importRepo: function (repoUrl) {
        return this.api('/api/import-repo', { method: 'POST', body: { repo_url: repoUrl } });
      },

      /* ---- request board ---- */

      listRequests: function (opts) {
        opts = opts || {};
        var q = '/requests_public?select=*&order=created_at.desc';
        if (opts.status) q += '&status=eq.' + encodeURIComponent(opts.status);
        if (opts.category) q += '&category=eq.' + encodeURIComponent(opts.category);
        if (opts.mine) {
          var u = this.currentUser();
          if (!u) return Promise.resolve([]);
          q += '&author_id=eq.' + u.id;
        }
        return rest(q);
      },

      getRequest: function (id) {
        return rest('/requests_public?select=*&id=eq.' + id)
          .then(function (r) { return (r && r[0]) || null; });
      },

      createRequest: function (data) {
        var u = this.currentUser();
        return rest('/requests', {
          method: 'POST',
          body: Object.assign({ author_id: u.id }, data),
          headers: { 'Prefer': 'return=representation' }
        }).then(function (r) { return r && r[0]; });
      },

      updateRequest: function (id, patch) {
        return rest('/requests?id=eq.' + id, {
          method: 'PATCH', body: patch, headers: { 'Prefer': 'return=representation' }
        }).then(function (r) {
          if (!r || !r.length) throw new Error('Not your request.');
          return r[0];
        });
      },

      listResponses: function (requestId) {
        return rest('/request_responses_public?select=*&request_id=eq.' + requestId +
                    '&order=created_at.asc');
      },

      respondToRequest: function (requestId, body, listingId) {
        var u = this.currentUser();
        return rest('/request_responses', {
          method: 'POST',
          body: {
            request_id: requestId, seller_id: u.id,
            body: body, listing_id: listingId || null
          },
          // The unique index makes a second reply from the same seller an
          // update rather than an error.
          headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' }
        }).then(function (r) { return r && r[0]; });
      },

      requestRefund: function (purchaseId, reason) {
        return this.api('/api/refund', {
          method: 'POST', body: { purchase_id: purchaseId, reason: reason || '' }
        });
      },

      connectStatus: function () { return this.api('/api/connect'); },

      startConnect: function () { return this.api('/api/connect', { method: 'POST' }); },

      sellerEarnings: function () {
        var u = this.currentUser();
        if (!u) return Promise.resolve(null);
        return rest('/seller_earnings?select=*&seller_id=eq.' + u.id)
          .then(function (r) { return (r && r[0]) || null; });
      }
    };
  }

  /* ------------------------------------------------------------- URL safety
   *
   * Seller-supplied URLs are hostile input. Two separate problems here, and
   * conflating them is how one of them survives.
   *
   * 1. SCHEME. `esc()` makes a string safe to sit *inside* HTML. It does not
   *    make it safe to *be* an href or a src — `javascript:...` passes through
   *    escaping completely intact. A buyer clicking "Open in a new tab" on a
   *    hostile listing would run the seller's code in this page, next to the
   *    session token in localStorage. Only http and https ever get through.
   *
   * 2. ORIGIN. An iframe holding `allow-same-origin` whose src is on *our*
   *    origin can reach into the parent page. Cross-origin demos are fine —
   *    the browser enforces the boundary for us, which is why a seller hosting
   *    on their own domain needs no special handling. Same-origin demos are
   *    fine only while every file under demos/ is our own code.
   *
   *    Set `demoOrigin` in config.js (e.g. https://demos.yourdomain.com) and
   *    first-party demos are served from there instead — at which point they
   *    are cross-origin like everyone else's and the exception below stops
   *    applying to anything. That is the switch to flip before you accept a
   *    seller-submitted demo.
   */

  var DEMO_PATH = '/demos/';
  var SANDBOX_BASE = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';

  /* Returns a URL object only for http(s). Anything else — javascript:, data:,
   * blob:, file: — comes back null and the caller must render no link at all. */
  function safeUrl(raw) {
    if (!raw) return null;
    var u;
    try { u = new URL(String(raw).trim(), location.href); } catch (e) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  }

  /* href-ready string, or '' if the URL is not safe to link. */
  function safeHref(raw) {
    var u = safeUrl(raw);
    return u ? u.href : '';
  }

  /* Ours, not a seller's. Tested against the *resolved* pathname so that
   * "demos/../app.html" normalises to "/app.html" and fails, as it should. */
  function isFirstPartyDemo(u) {
    return !!u && u.origin === location.origin && u.pathname.indexOf(DEMO_PATH) === 0;
  }

  /* What the listing page needs to decide how (and whether) to embed a demo. */
  function demoFrame(raw) {
    var u = safeUrl(raw);
    if (!u) return { ok: false, src: '', sandbox: SANDBOX_BASE, reason: 'scheme' };

    // Move our own demos off this origin once demoOrigin is configured.
    if (CFG.demoOrigin && isFirstPartyDemo(u)) {
      var moved = safeUrl(String(CFG.demoOrigin).replace(/\/$/, '') + u.pathname + u.search);
      if (moved) u = moved;
    }

    var sameOrigin = u.origin === location.origin;

    // Cross-origin: the browser keeps the boundary, so allow-same-origin only
    // lets the demo keep its *own* origin. This is the normal, safe case.
    if (!sameOrigin) {
      return { ok: true, src: u.href, sandbox: SANDBOX_BASE + ' allow-same-origin', reason: 'cross-origin' };
    }

    // Same-origin and ours: allowed, because we wrote the files. Without
    // allow-same-origin these demos get an opaque origin, their localStorage
    // throws, and they render blank.
    if (isFirstPartyDemo(u)) {
      return { ok: true, src: u.href, sandbox: SANDBOX_BASE + ' allow-same-origin', reason: 'first-party' };
    }

    // Same-origin and not ours. Never embed this with same-origin access.
    return { ok: false, src: u.href, sandbox: SANDBOX_BASE, reason: 'same-origin' };
  }

  window.FKUrl = {
    safeUrl: safeUrl,
    safeHref: safeHref,
    demoFrame: demoFrame,
    isFirstPartyDemo: isFirstPartyDemo,
    SANDBOX_BASE: SANDBOX_BASE
  };

  window.DB = LIVE ? SupabaseBackend() : LocalBackend();
})();
