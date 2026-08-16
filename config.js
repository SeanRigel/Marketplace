/* Forkable — configuration for the validation landing page (build order step 0).
 *
 * WAITLIST STORAGE
 * Leave these blank and the page runs in local mode: signups are kept in
 * localStorage and the form says so plainly. Fill them in (anon key only —
 * never the service_role key) and signups go to the Supabase `waitlist`
 * table created by supabase/waitlist.sql.
 */
/* DEMO ORIGIN — set this before you accept a seller-submitted demo.
 *
 * Demos under demos/ are served from this same origin today. That is only safe
 * because every one of those files is our own code: an iframe with
 * allow-same-origin that is *also* same-origin with this page can reach into
 * it. Point this at a separate origin (e.g. https://demos.yourdomain.com,
 * another Pages project serving the same demos/ directory) and first-party
 * demos move there, becoming cross-origin like every seller's — at which point
 * the browser enforces the boundary instead of us.
 *
 * Leave blank for local development. See ROADMAP.md, Stage 3.
 */
window.FORKABLE_CONFIG = {
  brand: 'Forkable',
  supabaseUrl: '',
  supabaseAnonKey: '',
  demoOrigin: '',
};

/* Featured listings.
 *
 * All three are real, working tools with real, clickable demos served from
 * this same site (demos/). That is the point of the page: nobody else in this
 * market lets you use the thing before you pay.
 *
 * `demo` is a URL. `repoUrl` is deliberately absent — repo access is a
 * post-purchase artifact and does not belong in client-side config.
 */
window.FORKABLE_LISTINGS = [
  {
    id: 'guard-scheduler',
    title: 'Shift Scheduler w/ AI Constraint Parser',
    category: 'scheduling',
    priceCents: 14900,
    seller: { name: 'Rigel', handle: '@rigel', tools: 3 },
    shortDescription:
      'Manager pastes the staff group chat. Claude turns it into availability constraints. A deterministic solver builds the weekly grid. CSV out.',
    longDescription:
      'Built for a real lifeguard pool rotation and generalizes to any shift-based team — restaurants, retail, clinics, camps.\n\nThe part worth buying is the split: the AI only ever *parses* messy human text into structured constraints (days off, max shifts, "these two can\'t close together"). The schedule itself is built by a deterministic solver, so it is reproducible and never hallucinates a shift. Every constraint stays hand-editable on the calendar before you solve.\n\nDegrades safely: if the AI endpoint is unreachable it falls back to a built-in text reader, so the tool never hard-fails in front of your client.',
    demo: 'demos/guard-scheduler/index.html',
    demoNote: 'Full app. Try "Read the texts" with the seeded sample chat, then tap cells to edit and solve.',
    stack: ['Vanilla JS', 'Claude Haiku', 'Python/Vercel fn', 'CSV export'],
    deployMinutes: 25,
    services: ['Anthropic API key (optional)', 'Vercel or any static host'],
  },
  {
    id: 'lead-scout',
    title: 'Local Lead Scout — Businesses With No Website',
    category: 'other',
    priceCents: 9900,
    seller: { name: 'Rigel', handle: '@rigel', tools: 3 },
    shortDescription:
      'Draw a radius on any town and get every business OpenStreetMap knows about that has no website. Zero API keys, zero per-lookup cost.',
    longDescription:
      'A prospecting tool for anyone who sells websites, booking systems, or dashboards to local businesses.\n\nQueries the Overpass API across several mirrors with automatic failover, filters for businesses missing a `website` tag, and gives you a working call list with phone numbers and map links. Because it runs on OpenStreetMap rather than a paid places API, there is no key to rotate, no per-query billing, and no quota to blow through on a bad afternoon.\n\nShips as an installable PWA, so it works from a phone while you are actually driving the territory.',
    demo: 'demos/lead-scout/index.html',
    demoNote: 'Live against the real Overpass API. Search any town you like — the results are genuine.',
    stack: ['Vanilla JS', 'Overpass/OSM', 'Nominatim', 'PWA'],
    deployMinutes: 10,
    services: ['None — static host only'],
  },
  {
    id: 'reconsole',
    title: 'RECONSOLE — Client-Side OSINT Console',
    category: 'other',
    priceCents: 12900,
    seller: { name: 'Rigel', handle: '@rigel', tools: 3 },
    shortDescription:
      'Terminal-styled recon console: DNS, RDAP/WHOIS, IP geolocation, image EXIF, cipher work. Everything runs in the browser.',
    longDescription:
      'A single-file investigation console for the legal end of OSINT — domain recon, DNS-over-HTTPS lookups, RDAP registration records, IP geolocation, EXIF metadata extraction from an image, and a cipher workbench.\n\nEvery module executes client-side against public endpoints, which means there is no backend to run, no logs to store, and nothing to leak. Drop it on a static host and it is done.\n\nThe reason to buy it rather than build it: the interface. It reads like a real console, which is disproportionately what sells this category of tool to a client.',
    demo: 'demos/reconsole/index.html',
    demoNote: 'Every live module works against real public endpoints. Try a domain lookup.',
    stack: ['Vanilla JS', 'DNS-over-HTTPS', 'RDAP', 'exifr'],
    deployMinutes: 5,
    services: ['None — static host only'],
  },
];
