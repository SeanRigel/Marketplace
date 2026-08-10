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
      purchases: 'forkable_local_purchases'
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
          demo_url: '../' + l.demo,
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

    function decorate(l) {
      var out = Object.assign({}, l);
      out.seller_name = (profileOf(l.seller_id) || {}).display_name || 'Unknown';
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
        if (opts.q) {
          var q = opts.q.toLowerCase();
          rows = rows.filter(function (l) {
            return (l.title + ' ' + l.short_description + ' ' + (l.tech_stack_tags || []).join(' '))
              .toLowerCase().indexOf(q) !== -1;
          });
        }
        rows.sort(function (a, b) { return b.created_at.localeCompare(a.created_at); });
        return Promise.resolve(rows.map(decorate));
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

      createListing: function (data) {
        var me = uid();
        if (!me) return Promise.reject(new Error('Sign in first.'));
        var rows = read(K.listings);
        var row = Object.assign({
          id: uuid(), seller_id: me, created_at: nowISO(), updated_at: nowISO()
        }, data);
        rows.push(row);
        write(K.listings, rows);
        return Promise.resolve(decorate(row));
      },

      updateListing: function (id, patch) {
        var me = uid(), rows = read(K.listings), found = null;
        rows.forEach(function (l) {
          if (l.id !== id || l.seller_id !== me) return;   // matches the update policy
          Object.assign(l, patch, { updated_at: nowISO() });
          found = l;
        });
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
        var q = '/listings_with_seller?select=*&status=eq.live&order=created_at.desc';
        if (opts.category) q += '&category=eq.' + encodeURIComponent(opts.category);
        if (opts.q) {
          // Match title OR short_description; PostgREST `or` takes a comma-joined filter list.
          var safe = opts.q.replace(/[(),*]/g, ' ');
          q += '&or=(title.ilike.*' + encodeURIComponent(safe) + '*,short_description.ilike.*' +
               encodeURIComponent(safe) + '*)';
        }
        return rest(q);
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
        return rest('/purchases?select=*,listing:listings_with_seller(*)&buyer_id=eq.' + u.id);
      }
    };
  }

  window.DB = LIVE ? SupabaseBackend() : LocalBackend();
})();
