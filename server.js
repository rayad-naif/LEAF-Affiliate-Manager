const express  = require('express');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const cron     = require('node-cron');
const crypto   = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// ─── Static marketing pages ───────────────────────────────────────────────────
// A single index.html lives at the project root (same directory as
// server.js) — separate from public/index.html, which is the admin
// dashboard app served by express.static above. It needs to load at
// /home, /privacy, /terms, and /support.
//
// Registered as individual explicit-path routes rather than a static mount
// or a catch-all, specifically so this can never shadow /oauth/callback/lc
// (or any other API route): Express matches these on the exact path only,
// so there's zero overlap with /oauth/*, /api/*, or /webhook/* regardless
// of where this block sits relative to those route registrations.
// To add another marketing path later, just add it to this list.
const ROOT_INDEX_FILE   = path.join(__dirname, 'index.html');
const ROOT_INDEX_ROUTES = ['/home', '/privacy', '/terms', '/support'];
ROOT_INDEX_ROUTES.forEach(route => {
    app.get(route, (req, res) => {
        if (!fs.existsSync(ROOT_INDEX_FILE)) {
            console.error(`[static] ${route} requested but index.html not found at ${ROOT_INDEX_FILE}`);
            return res.status(404).send('index.html not found in project root.');
        }
        res.sendFile(ROOT_INDEX_FILE);
    });
});

// ─── CRM API constants ────────────────────────────────────────────────────────
const GHL_API_BASE         = 'https://services.leadconnectorhq.com';
const GHL_API_VER          = '2021-04-15';  // installedLocations
const GHL_API_VER_V3       = 'v3';          // affiliate-manager, payments, contacts
const GHL_API_VER_PRODUCTS = '2021-07-28';  // products
const GHL_TOKEN_URL        = `${GHL_API_BASE}/oauth/token`;
const GHL_LOC_TOKEN_URL    = `${GHL_API_BASE}/oauth/location-token`;
const GHL_INSTALLED_LOCS   = `${GHL_API_BASE}/oauth/installedLocations`;

// Shared Secret from the Marketplace app's Advanced Settings → Auth section.
// Used only to decrypt the SSO payload GHL posts into Custom Page iframes
// (see /sso/decrypt below) — never sent to the frontend.
const GHL_SHARED_SECRET = process.env.GHL_SHARED_SECRET;

function ghlHeaders(accessToken, version = GHL_API_VER) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Version':       version,
        'Content-Type':  'application/json'
    };
}

// ─── Persistent store (Upstash Redis) ────────────────────────────────────────
// WHERE THIS DATA LIVES MATTERS A LOT ON RENDER (or any host with an
// ephemeral filesystem): every OAuth token — company AND location, access
// AND refresh — lives in this one JSON blob. Render's free-tier web services
// have NO persistent disk option at all, so writing to the local filesystem
// gets wiped on every restart — including the spin-up after a free-tier
// spin-down from inactivity, and every redeploy. That would silently delete
// every stored refresh token, forcing a "reinstall from the GHL Marketplace"
// to get working tokens again.
//
// Fix: store the JSON blob in Upstash Redis (upstash.com — free tier, no
// disk needed, works on Render's free plan) instead of on local disk.
//   1. Create a free Redis database at upstash.com
//   2. Copy its REST URL + REST token
//   3. Set env vars: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
//   4. Redeploy
// The database is kept in memory (dbCache) for the lifetime of the process —
// every existing loadDB()/saveDB() call site below is untouched and stays
// synchronous. saveDB() updates the in-memory copy immediately and pushes
// the new blob to Redis in the background. On boot, initDB() pulls the
// latest blob down from Redis before the server starts accepting traffic.
// If the env vars aren't set (e.g. local dev), everything falls back to the
// old local-file behavior automatically.
const REDIS_URL     = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN   = process.env.UPSTASH_REDIS_REST_TOKEN;
const DB_PERSISTENT = !!(REDIS_URL && REDIS_TOKEN);
const DB_KEY        = 'leaf_database';

// Local-file fallback, used only when Upstash env vars aren't set (local dev)
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
if (process.env.DATA_DIR && !fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
const DB_FILE = path.join(DATA_DIR, 'leaf_database.json');

function defaultDB() {
    return {
        campaigns: {}, settings: {}, products: {}, affiliates: {}, transactions: {},
        installs: {}, customFields: {},
        // New: per-subscription tracking
        trackedSubscriptions: {},   // ghlSubId → tracked record
        contactAffiliateMap:  {},   // contactId → { affiliateId, affiliateName, locationId }
        subscriptionCheckLog: [],   // last N check run summaries
        autoRefreshLog:       []    // last N hourly full-sync (campaigns/products/affiliates/subs) summaries
    };
}

let dbCache = null; // populated by initDB() before the server starts listening

// Synchronous — every existing call site keeps working unchanged.
function loadDB() {
    if (dbCache) return dbCache;
    // Shouldn't happen (initDB runs before app.listen), but guard anyway.
    if (fs.existsSync(DB_FILE)) {
        try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
    }
    return defaultDB();
}

// Synchronous from the caller's point of view — updates the in-memory copy
// immediately, then persists in the background (Redis, or local file if
// Redis isn't configured).
//
// MAX_TRANSACTIONS keeps the transactions log from growing forever. Every
// other collection in the DB (installs, campaigns, products, affiliates) is
// naturally bounded by real-world counts — how many accounts install the
// app, how many products/campaigns/affiliates they set up. Transactions are
// different: it's an append-only log of every purchase event, ever, with no
// natural ceiling. Left untrimmed, that log is what eventually pushes the
// single JSON blob toward Upstash's 256MB free-tier storage cap (and toward
// response sizes large enough to get truncated mid-transfer, which shows up
// client-side as exactly the "Unexpected end of JSON input" error). This
// keeps only the most recent MAX_TRANSACTIONS records, system-wide, on
// every save — cheap to check, and only sorts/trims when actually over cap.
const MAX_TRANSACTIONS = parseInt(process.env.MAX_TRANSACTIONS || '5000', 10);

function pruneTransactions(db) {
    if (!db.transactions) return;
    const ids = Object.keys(db.transactions);
    if (ids.length <= MAX_TRANSACTIONS) return;
    const sorted = ids
        .map(id => ({ id, createdAt: db.transactions[id]?.createdAt || '' }))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const toRemove = sorted.slice(MAX_TRANSACTIONS);
    toRemove.forEach(({ id }) => { delete db.transactions[id]; });
    console.log(`[db] Pruned ${toRemove.length} old transaction(s), keeping the ${MAX_TRANSACTIONS} most recent`);
}

function saveDB(db) {
    pruneTransactions(db);
    dbCache = db;
    if (DB_PERSISTENT) {
        axios.post(`${REDIS_URL}/set/${DB_KEY}`, JSON.stringify(db), {
            headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'text/plain' }
        }).catch(err => {
            console.error('[db] Failed to persist to Upstash Redis:', err.message);
        });
    } else {
        try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); } catch (err) {
            console.error('[db] Failed to persist to local file:', err.message);
        }
    }
}

// Pulls the latest blob down from Redis (or local file) into dbCache. Must
// complete before app.listen() so the very first request sees real data.
async function initDB() {
    if (DB_PERSISTENT) {
        try {
            const res = await axios.get(`${REDIS_URL}/get/${DB_KEY}`, {
                headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
            });
            const raw = res.data && res.data.result;
            dbCache = raw ? JSON.parse(raw) : defaultDB();
        } catch (err) {
            console.error('[db] Failed to load from Upstash Redis, starting from an empty DB:', err.message);
            dbCache = defaultDB();
        }
    } else {
        if (fs.existsSync(DB_FILE)) {
            try { dbCache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { dbCache = defaultDB(); }
        } else {
            dbCache = defaultDB();
        }
    }
}

// Migrate old DB on load — add missing top-level keys without losing existing data
function migrateDB() {
    const db = loadDB();
    let dirty = false;
    if (!db.trackedSubscriptions) { db.trackedSubscriptions = {}; dirty = true; }
    if (!db.contactAffiliateMap)  { db.contactAffiliateMap  = {}; dirty = true; }
    if (!db.subscriptionCheckLog) { db.subscriptionCheckLog = []; dirty = true; }
    if (!db.autoRefreshLog)       { db.autoRefreshLog       = []; dirty = true; }
    if (dirty) saveDB(db);
}

// Seed demo data on first run
function seedDB() {
    const db  = loadDB();
    const loc = 'HjiMUOsCCHCjtxEf8PR';
    if (db.campaigns['camp_1']) return;

    Object.assign(db.campaigns, {
        camp_1: { id: 'camp_1', locationId: loc, name: 'Summer Promo 2026',    status: 'active' },
        camp_2: { id: 'camp_2', locationId: loc, name: 'Referral Rewards Q3',  status: 'active' },
        camp_3: { id: 'camp_3', locationId: loc, name: 'Partner Launch Program', status: 'active' }
    });
    Object.assign(db.products, {
        prod_1: { id: 'prod_1', campaignId: 'camp_1', name: 'Starter Plan',        payoutType: 'CASH', payoutValue: 50  },
        prod_2: { id: 'prod_2', campaignId: 'camp_1', name: 'Pro Plan',             payoutType: 'CASH', payoutValue: 100 },
        prod_3: { id: 'prod_3', campaignId: 'camp_2', name: 'Annual Subscription',  payoutType: 'CASH', payoutValue: 200 }
    });
    Object.assign(db.affiliates, {
        aff_1: { id: 'aff_1', campaignId: 'camp_1', name: 'John Doe',    email: 'john@example.com', refId: 'REF-JOHN', leadsThisWeek: 3, cashThisWeek: 150, totalLeads: 10, totalCash: 500 },
        aff_2: { id: 'aff_2', campaignId: 'camp_1', name: 'Jane Smith',  email: 'jane@example.com', refId: 'REF-JANE', leadsThisWeek: 2, cashThisWeek: 100, totalLeads: 5,  totalCash: 250 },
        aff_3: { id: 'aff_3', campaignId: 'camp_2', name: 'Alex Rivera', email: 'alex@example.com', refId: 'REF-ALEX', leadsThisWeek: 1, cashThisWeek: 200, totalLeads: 4,  totalCash: 800 }
    });
    const daysAgo = d => new Date(Date.now() - d * 86400000).toISOString();
    Object.assign(db.transactions, {
        trans_1: { id: 'trans_1', campaignId: 'camp_1', contactId: 'Contact_001', affiliateName: 'John Doe',    productId: 'prod_1', type: 'CASH', amount: 50,  createdAt: daysAgo(1) },
        trans_2: { id: 'trans_2', campaignId: 'camp_1', contactId: 'Contact_002', affiliateName: 'Jane Smith',  productId: 'prod_2', type: 'CASH', amount: 100, createdAt: daysAgo(2) },
        trans_3: { id: 'trans_3', campaignId: 'camp_1', contactId: 'Contact_003', affiliateName: 'John Doe',    productId: 'prod_1', type: 'CASH', amount: 50,  createdAt: daysAgo(3) },
        trans_4: { id: 'trans_4', campaignId: 'camp_2', contactId: 'Contact_004', affiliateName: 'Alex Rivera', productId: 'prod_3', type: 'CASH', amount: 200, createdAt: daysAgo(1) }
    });
    saveDB(db);
}

// ─── Token helpers ────────────────────────────────────────────────────────────
function isTokenExpired(install) {
    const ts = install.updatedAt || install.installedAt;
    if (!ts) return true;
    const expiresIn = install.expiresIn || 86400;
    return Date.now() > (new Date(ts).getTime() + (expiresIn - 300) * 1000);
}

async function refreshCompanyToken(companyId) {
    const db  = loadDB();
    const key = `company_${companyId}`;
    const install = db.installs[key];
    if (!install?.refreshToken) throw new Error(`No refresh token for company ${companyId}`);

    const params = new URLSearchParams({
        client_id:     process.env.GHL_CLIENT_ID,
        client_secret: process.env.GHL_CLIENT_SECRET,
        grant_type:    'refresh_token',
        refresh_token: install.refreshToken,
        redirect_uri:  process.env.GHL_REDIRECT_URI
    });
    const res = await axios.post(GHL_TOKEN_URL, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    const { access_token, refresh_token, expires_in } = res.data;
    db.installs[key] = {
        ...install,
        accessToken:  access_token,
        refreshToken: refresh_token || install.refreshToken,
        expiresIn:    expires_in || install.expiresIn,
        updatedAt:    new Date().toISOString()
    };
    saveDB(db);
    console.log(`[token] company ${companyId} refreshed OK`);
    return access_token;
}

async function exchangeLocationToken(companyToken, companyId, locationId) {
    const db      = loadDB();
    const install = db.installs[locationId] || {};
    const locData = await getLocationToken(companyToken, companyId, locationId);
    db.installs[locationId] = {
        locationId,
        accessToken:  locData.accessToken,
        refreshToken: locData.refreshToken || install.refreshToken,
        tokenType:    locData.tokenType    || 'Bearer',
        expiresIn:    locData.expiresIn    || 86400,
        scope:        locData.scope        || install.scope,
        userId:       locData.userId       || install.userId,
        companyId,
        userType:     'Location',
        installedAt:  install.installedAt || new Date().toISOString(),
        updatedAt:    new Date().toISOString()
    };
    saveDB(db);
    console.log(`[token] location ${locationId} token exchanged OK`);
    return locData.accessToken;
}

async function getOrCreateLocationToken(locationId) {
    let db      = loadDB();
    const install = db.installs[locationId];

    const companyId = install?.companyId || Object.values(db.installs).find(i => i.userType === 'Company')?.companyId;
    const companyKey = companyId ? `company_${companyId}` : null;
    let companyInstall = companyKey ? db.installs[companyKey] : null;

    if (install?.accessToken && !isTokenExpired(install)) {
        return install.accessToken;
    }

    if (!companyInstall?.accessToken) {
        throw new Error(`No company token available to exchange for location ${locationId}`);
    }

    let companyToken = companyInstall.accessToken;
    if (isTokenExpired(companyInstall)) {
        console.log(`[token] company token expired — refreshing for company ${companyId}`);
        companyToken = await refreshCompanyToken(companyId);
    }

    try {
        return await exchangeLocationToken(companyToken, companyId, locationId);
    } catch (err) {
        if (err.response?.status === 401) {
            console.log(`[token] company token rejected during exchange — refreshing once more`);
            companyToken = await refreshCompanyToken(companyId);
            return await exchangeLocationToken(companyToken, companyId, locationId);
        }
        throw err;
    }
}

async function getLocationToken(companyToken, companyId, locationId) {
    const params = new URLSearchParams({ companyId, locationId });
    const res = await axios.post(GHL_LOC_TOKEN_URL, params.toString(), {
        headers: {
            'Authorization': `Bearer ${companyToken}`,
            'Version':       GHL_API_VER_V3,
            'Content-Type':  'application/x-www-form-urlencoded'
        }
    });
    return res.data;
}

// ─── Resilient GHL API request wrapper ────────────────────────────────────────
// `buildConfig(token)` receives the current access token and returns the full
// axios config (method, url, params/data, headers). This lets the wrapper
// transparently rebuild the Authorization header after a token refresh —
// callers never touch tokens directly.
//
// Handles:
//   - 401: force-refresh the company token, re-exchange a fresh location
//     token, and retry the request exactly once.
//   - 429: wait RATE_LIMIT_DELAY_MS (honoring a Retry-After header if GHL
//     sends one) and retry, up to MAX_429_RETRIES times.
const MAX_429_RETRIES     = 3;
const RATE_LIMIT_DELAY_MS = 2000;

// A failed subscription renewal check (network error, GHL 5xx, timeout, etc.)
// must not silently cost an affiliate their reward. Instead of giving up (or
// retrying every single hourly cron tick forever), a failed check gets
// rescheduled exactly 1 day later, for up to MAX_CHECK_RETRIES retries —
// see the catch block in runSubscriptionChecks.
const MAX_CHECK_RETRIES     = 2;
const CHECK_RETRY_DELAY_MS  = 24 * 60 * 60 * 1000; // 1 day

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function ghlApiRequest(locationId, buildConfig, { retries429 = 0 } = {}) {
    const token  = await getOrCreateLocationToken(locationId);
    const config = buildConfig(token);

    try {
        return await axios(config);
    } catch (err) {
        const status = err.response?.status;

        // ── 401: force a full token refresh, then retry once ───────────────
        if (status === 401) {
            console.warn(`[ghl-api] 401 on ${config.method?.toUpperCase()} ${config.url} — refreshing token`);

            const db = loadDB();
            const install = db.installs[locationId];
            const companyId = install?.companyId
                || Object.values(db.installs).find(i => i.userType === 'Company')?.companyId;

            if (!companyId) throw err; // nothing to refresh from — surface the original error

            const companyToken = await refreshCompanyToken(companyId);
            const freshToken   = await exchangeLocationToken(companyToken, companyId, locationId);
            const retryConfig  = buildConfig(freshToken);

            return await axios(retryConfig); // one retry only — a second 401 propagates
        }

        // ── 429: back off and retry, up to MAX_429_RETRIES times ───────────
        if (status === 429 && retries429 < MAX_429_RETRIES) {
            const retryAfter = Number(err.response?.headers?.['retry-after']);
            const delayMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? retryAfter * 1000
                : RATE_LIMIT_DELAY_MS;

            console.warn(`[ghl-api] 429 on ${config.method?.toUpperCase()} ${config.url} — retrying in ${delayMs}ms (${retries429 + 1}/${MAX_429_RETRIES})`);
            await sleep(delayMs);
            return ghlApiRequest(locationId, buildConfig, { retries429: retries429 + 1 });
        }

        // Log exactly what we sent whenever a call fails and isn't retried —
        // this is what tells us the real cause (e.g. an unsupported param)
        // from the server log in one look, instead of guessing blind.
        console.error(`[ghl-api] ${status || 'ERR'} on ${config.method?.toUpperCase()} ${config.url} — params: ${JSON.stringify(config.params)} — ${err.response?.data?.message || err.message}`);

        throw err;
    }
}

// ─── GHL: Affiliate Manager — Campaigns (fully paginated, cursor-based) ──────
async function fetchGHLCampaigns(locationId) {
    const allCampaigns = await fetchAllPagesCursor(
        (cursor, limit) => ghlApiRequest(locationId, (token) => ({
            method:  'get',
            url:     `${GHL_API_BASE}/affiliate-manager/${locationId}/campaigns`,
            params:  { limit, ...(cursor || {}) },
            headers: ghlHeaders(token, GHL_API_VER_V3),
            timeout: 10000
        })),
        (res) => res.data.campaigns
    );

    console.log(`[campaigns] fetched ${allCampaigns.length} campaign(s) for ${locationId}`);
    return allCampaigns.map(c => ({
        id:           c._id || c.id,
        name:         c.name || '(Unnamed Campaign)',
        status:       c.deleted ? 'deleted' : (c.liveMode ? 'active' : 'draft'),
        locationId,
        commission:   c.commission   || 0,
        currency:     c.currency     || '',
        description:  c.description  || '',
        affiliateIds: c.affiliates   || [],
        domain:       c.domain       || null,
        payoutFrequency: c.payoutFrequency || null,
        cookieLife:   c.cookieLife   || null
    }));
}

// ─── Cursor-based pagination for GHL v3 endpoints ────────────────────────────
// IMPORTANT: the v3 endpoints (affiliate-manager, payments/subscriptions,
// payments/transactions) validate query params strictly and REJECT an
// `offset` param outright with a 422 ("property offset should not exist") —
// unlike the older v1-style endpoints (e.g. Products, 2021-07-28) which do
// accept classic offset/limit. v3 instead paginates with a cursor: each
// response carries `meta.startAfter` / `meta.startAfterId` pointing at the
// next page. If a given payload doesn't include that meta block, we derive
// the same cursor from the last item of the page we just received (its own
// id + createdAt/dateAdded timestamp) — GHL accepts either.
//
// `requestPage(cursor, limit)` must return the raw axios response for one
// page, given the current cursor (`null` for the first page) and the page
// size. `getItems(res)` extracts that page's array of items from the
// response.
// Safety caps for paginated GHL fetches (subscriptions, transactions,
// affiliates, products, campaigns). Without these, an account with a large
// history pages through EVERY record, sequentially, on every single sync —
// which is exactly what was turning "Sync Subscriptions" into a multi-minute
// request. Render's free tier has a limited request/memory budget, so a long
// enough sync would get its connection cut mid-response — which shows up in
// the browser as a truncated body ("Unexpected end of JSON input"), not as a
// clean error. FETCH_MAX_PAGES bounds how much a single sync will ever try
// to pull in one go; FETCH_PAGE_DELAY_MS spaces requests out a little so
// GHL's API isn't hit back-to-back (on top of the existing 429 retry/backoff
// below). Both are overridable via env vars if a location genuinely needs
// more.
const FETCH_MAX_PAGES     = parseInt(process.env.FETCH_MAX_PAGES     || '50', 10);  // 50 pages × 100/page = 5,000 records
const FETCH_PAGE_DELAY_MS = parseInt(process.env.FETCH_PAGE_DELAY_MS || '150', 10);

async function fetchAllPagesCursor(requestPage, getItems, limit = 100) {
    const all = [];
    let cursor = null;
    let pageCount = 0;

    while (true) {
        const res  = await requestPage(cursor, limit);
        const page = getItems(res) || [];
        all.push(...page);
        pageCount++;

        if (page.length < limit) break; // last page

        if (pageCount >= FETCH_MAX_PAGES) {
            console.warn(`[pagination] Hit the ${FETCH_MAX_PAGES}-page safety cap (${all.length} records fetched) — stopping early this sync. Raise FETCH_MAX_PAGES if this location genuinely has more records than that.`);
            break;
        }

        const meta = res.data?.meta || {};
        const last = page[page.length - 1] || {};
        const startAfterId = meta.startAfterId || last._id || last.id;
        const startAfter    = meta.startAfter   || last.createdAt || last.dateAdded;

        if (!startAfterId) break; // no cursor to advance with — stop rather than loop forever
        cursor = { startAfter, startAfterId };

        if (FETCH_PAGE_DELAY_MS > 0) await sleep(FETCH_PAGE_DELAY_MS);
    }

    return all;
}

// ─── GHL: Products (fully paginated — fetches every page, not just the first) ─
async function fetchGHLProducts(locationId) {
    const db = loadDB();
    const allProducts = [];
    let offset = 0;
    const limit = 100;

    while (true) {
        const res = await ghlApiRequest(locationId, (token) => ({
            method:  'get',
            url:     `${GHL_API_BASE}/products/`,
            params:  { locationId, limit, offset },
            headers: ghlHeaders(token, GHL_API_VER_PRODUCTS),
            timeout: 10000
        }));
        const page = res.data.products || [];
        allProducts.push(...page);
        if (page.length < limit) break;
        offset += limit;
    }

    console.log(`[products] fetched ${allProducts.length} product(s) for ${locationId}`);
    return allProducts.map(p => {
        const id = p.id || p._id;
        const local = db.products[id] || {};
        return {
            id, name: p.name,
            payoutType:  local.payoutType || 'CASH',
            payoutValue: local.payoutValue || 0,
            campaignId:  p.campaignId || local.campaignId || null,
            locationId
        };
    });
}

// ─── GHL: Affiliate Manager — Affiliates (fully paginated, cursor-based) ─────
async function fetchGHLAffiliates(locationId) {
    const allAffiliates = await fetchAllPagesCursor(
        (cursor, limit) => ghlApiRequest(locationId, (token) => ({
            method:  'get',
            url:     `${GHL_API_BASE}/affiliate-manager/${locationId}/affiliates`,
            params:  { limit, ...(cursor || {}) },
            headers: ghlHeaders(token, GHL_API_VER_V3),
            timeout: 10000
        })),
        (res) => res.data.affiliates
    );

    console.log(`[affiliates] fetched ${allAffiliates.length} affiliate(s) for ${locationId}`);
    return allAffiliates.map(a => ({
        id:          a._id || a.id,
        contactId:   a.contactId || a.contact_id || a.contact?._id || a.contact?.id || null,
        name:        `${a.firstName || ''} ${a.lastName || ''}`.trim() || a.email || a._id,
        email:       a.email || '',
        refId:       a.referralCode || a._id,
        campaignIds: [...(a.campaignIds || [])],   // fresh mutable copy — associateAffiliatesWithCampaigns() appends to this
        campaignId:  (a.campaignIds || [])[0] || null,
        totalCash:     a.revenue    || 0,
        totalLeads:    a.lead       || 0,
        customer:      a.customer   || 0,
        clickCount:    a.clickCount || 0,
        paid:          a.paid       || 0,
        droppedCustomer: a.droppedCustomer || 0,
        currency:      a.currency   || '',
        active:        a.active     !== false,
        locationId
    }));
}

// ─── Cross-reference: attach affiliates to the campaigns that list them ──────
// Each campaign response includes `affiliates` (a list of affiliate IDs
// belonging to that campaign — mapped to `affiliateIds` in fetchGHLCampaigns).
// Some affiliate records come back from the affiliates endpoint without a
// reliable campaignIds field of their own, so this rebuilds the association
// from the campaign side and merges it onto each affiliate in place.
function associateAffiliatesWithCampaigns(affiliates, campaigns) {
    const byId = new Map(affiliates.map(a => [a.id, a]));
    (campaigns || []).forEach(c => {
        (c.affiliateIds || []).forEach(affId => {
            const a = byId.get(affId);
            if (!a) return;
            if (!a.campaignIds.includes(c.id)) a.campaignIds.push(c.id);
            if (!a.campaignId) a.campaignId = c.id;
        });
    });
    return affiliates;
}

// ─── GHL: Payments — List Subscriptions ──────────────────────────────────────
// GET /payments/subscriptions?altId=locationId&altType=location  Version: v3
async function fetchGHLSubscriptions(locationId) {
    const allSubs = await fetchAllPagesCursor(
        (cursor, limit) => ghlApiRequest(locationId, (token) => ({
            method:  'get',
            url:     `${GHL_API_BASE}/payments/subscriptions`,
            params:  { altId: locationId, altType: 'location', limit, ...(cursor || {}) },
            headers: ghlHeaders(token, GHL_API_VER_V3),
            timeout: 15000
        })),
        (res) => res.data?.data
    );

    console.log(`[subscriptions] fetched ${allSubs.length} subscription(s) for ${locationId}`);
    return allSubs;
}

// ─── GHL: Payments — Get Single Subscription ─────────────────────────────────
async function fetchGHLSubscriptionById(locationId, ghlSubId) {
    const res = await ghlApiRequest(locationId, (token) => ({
        method:  'get',
        url:     `${GHL_API_BASE}/payments/subscriptions/${ghlSubId}`,
        params:  { altId: locationId, altType: 'location' },
        headers: ghlHeaders(token, GHL_API_VER_V3),
        timeout: 10000
    }));
    return res.data?.data || res.data;
}

// ─── GHL: Payments — List Transactions ───────────────────────────────────────
// GET /payments/transactions?altId=locationId&altType=location  Version: v3
async function fetchGHLTransactions(locationId) {
    const allTxns = await fetchAllPagesCursor(
        (cursor, limit) => ghlApiRequest(locationId, (token) => ({
            method:  'get',
            url:     `${GHL_API_BASE}/payments/transactions`,
            params:  { altId: locationId, altType: 'location', limit, ...(cursor || {}) },
            headers: ghlHeaders(token, GHL_API_VER_V3),
            timeout: 15000
        })),
        (res) => res.data?.data
    );

    console.log(`[transactions] fetched ${allTxns.length} transaction(s) for ${locationId}`);
    return allTxns;
}

// ─── Billing interval helpers ─────────────────────────────────────────────────
// Detect interval from a GHL subscription object.
// GHL embeds Stripe charge/subscription snapshots as JSON strings — we inspect those.
function detectBillingInterval(sub) {
    // 1. Direct interval field
    const direct = (sub.interval || sub.billingInterval || '').toLowerCase();
    if (direct.includes('year'))  return 'yearly';
    if (direct.includes('week'))  return 'weekly';
    if (direct.includes('month')) return 'monthly';

    // 2. Inspect chargeSnapshot / subscriptionSnapshot (Stripe JSON strings)
    const snapshots = [sub.chargeSnapshot, sub.subscriptionSnapshot, sub.entitySourceMeta]
        .map(s => (typeof s === 'string' ? s : JSON.stringify(s || '')))
        .join(' ')
        .toLowerCase();

    if (snapshots.includes('"interval":"year')  || snapshots.includes('"interval": "year'))  return 'yearly';
    if (snapshots.includes('"interval":"week')  || snapshots.includes('"interval": "week'))  return 'weekly';
    if (snapshots.includes('"interval":"month') || snapshots.includes('"interval": "month')) return 'monthly';

    // 3. Infer from subscription amount (rough heuristic, overridable)
    // Not reliable — default to monthly
    return 'monthly';
}

// Convert interval label → milliseconds for one billing period
function intervalToMs(interval) {
    switch (interval) {
        case 'yearly':  return 365 * 24 * 60 * 60 * 1000;
        case 'weekly':  return   7 * 24 * 60 * 60 * 1000;
        default:        return  30 * 24 * 60 * 60 * 1000;  // monthly
    }
}

// Calculate the "next check" date: renewal date + 2 days buffer
function calcNextCheckDate(renewalDate) {
    return new Date(new Date(renewalDate).getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Normalization helper for fuzzy matching ──────────────────────────────────
// Strips everything except letters and lowercases, so "John Doe", "john-doe",
// "JOHN DOE!" all normalize to "johndoe" for loose comparison.
function normalize(str) {
    return (str || '').replace(/[^a-zA-Z]/g, '').toLowerCase();
}

// ─── Match a subscription to a known affiliate ────────────────────────────────
// IMPORTANT: `affiliates` passed in MUST already be scoped to the current
// locationId. Demo/seed affiliates (aff_1/aff_2/aff_3 from seedDB) have no
// locationId set at all, so a proper scoped list excludes them automatically
// — this is what stops a real subscription from ever matching leftover fake
// "Alex Rivera"-style seed data from an unrelated location.
//
// Tries, in priority order:
//   1. Exact ID match via entitySourceMeta.affiliateManager.id (or refId)
//   2. Known contactId/contactEmail → affiliate mapping — but only if that
//      cached affiliateId still exists within THIS location's scoped roster.
//      A cached mapping pointing at an affiliate outside this location is
//      treated as stale and discarded rather than trusted.
//   3. Fuzzy match: normalize everything we know about the subscription
//      (contact name/email + related transaction metadata) into one haystack,
//      then check whether any affiliate's normalized name, full email, or
//      referral code shows up in it. Only the email LOCAL PART is used if
//      it's long enough (>=5 normalized chars) to avoid short-string false
//      positives like "alex" matching unrelated text.
// Returns { affiliate, source } where source is 'direct-id' | 'known-mapping' | 'fuzzy' | null,
// so callers/debug tooling can see exactly why (or why not) a match happened.
function matchAffiliate({ sub, affiliates, contactMap, relatedTxns }) {
    // 1. Direct ID match — GHL told us exactly which affiliate this is.
    //    NOTE: entitySourceMeta.affiliateManager.id is NOT the affiliate's
    //    Mongo _id / refId — it's a name-derived slug GHL generates, shaped
    //    like "firstnamelastname1234" (lowercased first+last name glued
    //    together, followed by a few random digits — e.g. "johndoe4821").
    //    So try the literal id/refId match first, then fall back to a
    //    name-based comparison using that same payload id.
    const payloadAffId = sub.entitySourceMeta?.affiliateManager?.id;
    if (payloadAffId) {
        const direct = affiliates.find(a => a.id === payloadAffId || a.refId === payloadAffId);
        if (direct) return { affiliate: direct, source: 'direct-id' };

        // Strip the trailing digits GHL appends, normalize what's left (letters
        // only, lowercased), and compare against each affiliate's normalized
        // full name. "johndoe4821" → "johndoe" → matches affiliate "John Doe".
        const idNameBase = normalize(payloadAffId.replace(/[0-9]+$/, ''));
        if (idNameBase && idNameBase.length >= 4) {
            const byName = affiliates.find(a => normalize(a.name) === idNameBase);
            if (byName) return { affiliate: byName, source: 'direct-id-name' };

            // Tolerant fallback: the slug can be truncated, or the affiliate's
            // stored name can have an extra/missing middle name — allow a
            // startsWith match either direction, still gated by a minimum
            // length so short names can't false-positive.
            const byPartialName = affiliates.find(a => {
                const aName = normalize(a.name);
                return aName.length >= 6 && (aName.startsWith(idNameBase) || idNameBase.startsWith(aName));
            });
            if (byPartialName) return { affiliate: byPartialName, source: 'direct-id-name-partial' };
        }
    }

    // 2. Known contact → affiliate mapping — only trusted if it resolves
    //    within THIS location's scoped affiliate list
    const contactId    = sub.contactId    || '';
    const contactEmail = sub.contactEmail || '';
    const mapped = contactMap[contactId] || (contactEmail && contactMap[contactEmail]);
    if (mapped?.affiliateId) {
        const byId = affiliates.find(a => a.id === mapped.affiliateId);
        if (byId) return { affiliate: byId, source: 'known-mapping' };
        // mapping points at an affiliate not in this location's roster — stale, ignore it
    }

    // 3. Fuzzy match against name / email / referral code / the raw payload id
    //    (kept here too as a safety net in case the name-slug doesn't exactly
    //    equal the affiliate's normalized name — e.g. extra middle name, or
    //    the affiliate's own name changed since the slug was generated).
    const haystack = normalize(
        (sub.contactName  || '') + ' ' +
        (sub.contactEmail || '') + ' ' +
        (payloadAffId      || '') + ' ' +
        JSON.stringify(relatedTxns || '')
    );

    if (haystack) {
        const fuzzy = affiliates.find(a => {
            const aName     = normalize(a.name);
            const aEmailFull = normalize(a.email || '');
            const aEmailLocal = normalize((a.email || '').split('@')[0]);
            const aRef      = normalize(a.refId);
            // Require a minimum token length before allowing a substring match —
            // short tokens like "alex" (4 chars) cause false positives.
            const emailToken = aEmailLocal.length >= 5 ? aEmailLocal : null;
            return (aName      && aName.length >= 5 && haystack.includes(aName)) ||
                   (aEmailFull && haystack.includes(aEmailFull)) ||
                   (emailToken && haystack.includes(emailToken)) ||
                   (aRef       && aRef.length >= 5 && haystack.includes(aRef));
        });
        if (fuzzy) return { affiliate: fuzzy, source: 'fuzzy' };
    }

    return { affiliate: null, source: null };
}

// ─── Sum an affiliate's earnings ──────────────────────────────────────────────
// windowDays: number of trailing days to include (e.g. 7 for "this week"),
// or null/undefined for all-time (a running total — this naturally
// accumulates week over week as new transactions are recorded, so
// "Total Earned" grows on its own without needing a separate += counter).
//
// IMPORTANT: this sums BOTH payout types (CASH and LEAD), not just CASH.
// A product's payoutType only describes *how* the affiliate earns a reward
// (per cash sale vs. per lead) — in both cases `amount` is real money owed
// to the affiliate. Filtering to CASH-only here made every affiliate whose
// products are configured as "Lead Generation" show $0 earned forever, even
// though they had plenty of recorded LEAD-type payouts.
function computeAffiliateCash(db, affiliateId, windowDays) {
    if (!affiliateId) return 0;
    const cutoff = windowDays ? Date.now() - windowDays * 24 * 60 * 60 * 1000 : null;
    return Object.values(db.transactions || {})
        .filter(t => t.affiliateId === affiliateId)
        .filter(t => !cutoff || new Date(t.createdAt).getTime() >= cutoff)
        .reduce((sum, t) => sum + Number(t.amount || 0), 0);
}

// ─── Sync subscriptions from GHL and match to affiliates ─────────────────────
// This is the core of the system.
// Steps:
//   1. Fetch all GHL subscriptions, transactions, and affiliates for the location
//   2. Scope the affiliate candidate list to THIS location only (never match
//      against seed/demo data or affiliates belonging to other locations)
//   3. For each subscription: match an affiliate (ID → known mapping → fuzzy),
//      force-generate the initial purchase transaction if missing, compute
//      billing interval + renewal/check dates, and upsert into trackedSubscriptions
//   4. Persist everything in one save, with per-subscription error isolation so
//      one bad record can never abort the whole sync
async function syncSubscriptionsFromGHL(locationId) {
    const db = loadDB();
    if (!db.trackedSubscriptions) db.trackedSubscriptions = {};
    if (!db.contactAffiliateMap)  db.contactAffiliateMap  = {};
    if (!db.affiliates)           db.affiliates           = {};
    if (!db.products)             db.products             = {};
    if (!db.campaigns)            db.campaigns            = {};
    if (!db.transactions)         db.transactions          = {};

    // Fetch everything we need in parallel — subscriptions, transactions,
    // ALL affiliates (paginated), ALL products (paginated), and campaigns
    // (so affiliates/products can be associated to the right campaign below).
    //
    // Promise.allSettled, not Promise.all: if e.g. the subscriptions call
    // fails, we still want whatever affiliates/products/campaigns DID come
    // back to be used and persisted, rather than the whole sync throwing
    // away every source just because one of them errored.
    const settled = await Promise.allSettled([
        fetchGHLSubscriptions(locationId),
        fetchGHLTransactions(locationId),
        fetchGHLAffiliates(locationId),
        fetchGHLProducts(locationId),
        fetchGHLCampaigns(locationId)
    ]);
    const fetchLabels = ['subscriptions', 'transactions', 'affiliates', 'products', 'campaigns'];
    const fetchErrors = [];
    settled.forEach((r, i) => {
        if (r.status === 'rejected') {
            const err = r.reason;
            const msg = err.response?.data?.message || err.message;
            console.error(`[sync-subs] ${fetchLabels[i]} fetch failed for ${locationId}:`, msg);
            fetchErrors.push(`${fetchLabels[i]}: ${msg}`);
        }
    });
    const [ghlSubs, ghlTxns, ghlAffiliates, ghlProducts, ghlCampaigns] =
        settled.map(r => (r.status === 'fulfilled' ? r.value : []));

    // Associate affiliates with the campaigns that list them, THEN merge into
    // the local store so IDs/refIds/campaignIds are current.
    associateAffiliatesWithCampaigns(ghlAffiliates, ghlCampaigns);
    ghlAffiliates.forEach(a => { db.affiliates[a.id] = { ...db.affiliates[a.id], ...a, locationId }; });
    ghlProducts.forEach(p  => { db.products[p.id]    = p; });
    ghlCampaigns.forEach(c => { db.campaigns[c.id]   = c; });

    // ── Scope candidates to THIS location only ──────────────────────────────
    // Seed/demo affiliates (aff_1/aff_2/aff_3) have no locationId field at
    // all, so this filter excludes them by construction — they can never be
    // matched against a real subscription again.
    const affiliates = Object.values(db.affiliates).filter(a => a.locationId === locationId);

    // Group transactions by subscriptionId so fuzzy matching can inspect related metadata
    const txnsBySubId = {};
    ghlTxns.forEach(t => {
        const sid = t.subscriptionId;
        if (!sid) return;
        if (!txnsBySubId[sid]) txnsBySubId[sid] = [];
        txnsBySubId[sid].push(t);
    });

    const contactMap = { ...db.contactAffiliateMap };
    const results = { locationId, added: [], updated: [], skipped: [], errors: [], fetchErrors, rawCount: ghlSubs.length };
    const affiliatesToPush = new Set();

    // ── Single clean loop — no duplicated/orphaned code ─────────────────────
    for (const sub of ghlSubs) {
        try {
            const ghlSubId = sub._id || sub.id;
            if (!ghlSubId) {
                results.skipped.push({ reason: 'missing subscription id' });
                continue;
            }

            const subStripeId  = sub.subscriptionId || '';
            const contactId    = sub.contactId    || '';
            const contactEmail = sub.contactEmail || '';
            const status       = (typeof sub.status === 'object' ? sub.status?.status : sub.status) || 'unknown';
            const productId    = sub.recurringProduct?.product?._id || sub.productId || null;

            const relatedTxns = txnsBySubId[subStripeId] || txnsBySubId[ghlSubId] || [];
            const { affiliate: affiliateRec, source: matchSource } = matchAffiliate({ sub, affiliates, contactMap, relatedTxns });


            // Remember this mapping so future syncs/checks resolve instantly
            // (only cache real, scoped matches — never cache a "no match")
            if (affiliateRec && contactId) {
                contactMap[contactId] = { affiliateId: affiliateRec.id, affiliateName: affiliateRec.name, locationId };
                affiliatesToPush.add(affiliateRec.id);
            }

            // Force-generate the initial purchase transaction if it doesn't exist yet
            const txId = `tx_sync_${ghlSubId}`;
            if (!db.transactions[txId] && affiliateRec && productId) {
                const rule = db.products[productId];
                if (rule && rule.payoutValue > 0) {
                    db.transactions[txId] = {
                        id: txId,
                        campaignId:     rule.campaignId || affiliateRec.campaignId || 'unknown',
                        contactId,
                        affiliateId:    affiliateRec.id,     // strict ID reference for dashboard aggregation
                        affiliateName:  affiliateRec.name,
                        productId,
                        subscriptionId: ghlSubId,
                        type:   rule.payoutType  || 'CASH',
                        amount: rule.payoutValue,
                        createdAt: sub.createdAt || new Date().toISOString()
                    };
                }
            }

            // Billing interval + renewal/next-check dates
            const billingInterval = detectBillingInterval(sub);
            const intervalMs      = intervalToMs(billingInterval);
            const createdAt       = sub.createdAt || new Date().toISOString();
            const rawPeriodEnd    = sub.currentPeriodEnd || sub.nextBillingDate || null;
            const periodEndMs     = rawPeriodEnd
                ? new Date(rawPeriodEnd).getTime()
                : new Date(createdAt).getTime() + intervalMs;
            const renewalDate     = new Date(periodEndMs).toISOString();
            const nextCheckDate   = calcNextCheckDate(renewalDate);

            const existing = db.trackedSubscriptions[ghlSubId];

            const record = {
                ghlSubId, stripeSubId: subStripeId, contactId, contactEmail,
                contactName: sub.contactName || '',
                locationId,
                productId,
                affiliateId:   affiliateRec?.id   || null,
                affiliateName: affiliateRec?.name || null,
                isAffiliated:  !!affiliateRec,
                matchSource,   // 'direct-id' | 'known-mapping' | 'fuzzy' | null — for debugging
                billingInterval,
                amount:   sub.amount   || 0,
                currency: sub.currency || 'USD',
                status,
                isActive: status === 'active',
                startDate: existing?.startDate || createdAt,
                renewalDate,
                // Don't clobber a nextCheckDate that's already scheduled ahead
                nextCheckDate: (existing?.nextCheckDate && !existing?.stopped) ? existing.nextCheckDate : nextCheckDate,
                lastChecked: existing?.lastChecked || null,
                checkCount:  existing?.checkCount  || 0,
                stopped:     existing?.stopped     || false,
                _raw: {
                    entityType: sub.entityType, entitySourceType: sub.entitySourceType,
                    entitySourceName: sub.entitySourceName, liveMode: sub.liveMode
                }
            };

            db.trackedSubscriptions[ghlSubId] = record;

            if (!existing) {
                results.added.push({ ghlSubId, contact: contactEmail || contactId, affiliated: record.isAffiliated, interval: billingInterval });
            } else {
                results.updated.push(ghlSubId);
            }

        } catch (subErr) {
            // Data integrity: one bad subscription must never abort the whole sync
            console.error('[sync-subs] failed to process subscription:', subErr.message);
            results.errors.push({ ghlSubId: sub?._id || sub?.id || 'unknown', error: subErr.message });
        }
    }

    db.contactAffiliateMap = contactMap;

    try {
        saveDB(db);
    } catch (saveErr) {
        console.error('[sync-subs] saveDB failed:', saveErr.message);
        results.errors.push({ ghlSubId: null, error: `Failed to persist database: ${saveErr.message}` });
    }

    // Push fresh leads/cash-this-week/total-earned stats to CRM for every
    // affiliate touched by this sync — once each, not once per subscription.
    // This now runs in the BACKGROUND (fire-and-forget), after saveDB()
    // above: each push is its own network round-trip to GHL, and awaiting
    // them one-by-one here was exactly what turned "Sync Subscriptions"
    // into a multi-minute request for accounts with many affiliates —
    // long enough that Render's free tier would sometimes cut the
    // connection mid-response, which shows up client-side as "Unexpected
    // end of JSON input" rather than a clean error. The subscription data
    // itself is already saved by the time this kicks off, so the
    // dashboard is accurate immediately; the CRM custom fields catch up
    // moments later. See server logs (prefix "[sync-subs] background")
    // for push results.
    results.crmPushed = []; // kept for response-shape compatibility; pushes happen after this returns
    if (affiliatesToPush.size > 0) {
        pushAffiliateStatsInBackground(locationId, [...affiliatesToPush]);
    }

    console.log(`[sync-subs] ${locationId}: ${results.added.length} added, ${results.updated.length} updated, ${results.errors.length} errors, ${fetchErrors.length} fetch failures, ${ghlSubs.length} total, ${affiliatesToPush.size} CRM push(es) queued in background`);
    return results;
}

// Runs the per-affiliate CRM stats push without blocking the caller. Errors
// are logged, not thrown — by the time this runs, the HTTP response for
// whatever sync triggered it has likely already been sent to the browser.
async function pushAffiliateStatsInBackground(locationId, affiliateIds) {
    const db = loadDB();
    let pushed = 0, failed = 0;
    for (const affId of affiliateIds) {
        try {
            const push = await pushAffiliateStatsToCRM(db, locationId, affId);
            if (push.success) pushed++; else failed++;
        } catch (err) {
            failed++;
            console.error(`[sync-subs] background CRM push failed for affiliate ${affId}:`, err.message);
        }
    }
    console.log(`[sync-subs] background CRM push complete for ${locationId}: ${pushed} succeeded, ${failed} failed`);
}

// ─── Per-subscription renewal check ──────────────────────────────────────────
// Called by the hourly cron and the manual admin trigger.
// For each AFFILIATED, non-stopped subscription whose nextCheckDate has arrived:
//   1. Fetch fresh status from GHL
//   2. If still active → log renewal, advance nextCheckDate by one billing period + 2 days
//   3. If cancelled/inactive → mark stopped (no more automatic checks)
// CRM contact custom fields are updated for the affiliate after each check.
async function runSubscriptionChecks(locationIdFilter) {
    const db  = loadDB();
    const now = Date.now();
    const runAt = new Date().toISOString();

    // Collect due subscriptions
    const due = Object.values(db.trackedSubscriptions || {}).filter(s => {
        if (s.stopped)       return false;
        if (!s.isAffiliated) return false;  // only track affiliated subs
        if (locationIdFilter && s.locationId !== locationIdFilter) return false;
        return s.nextCheckDate && new Date(s.nextCheckDate).getTime() <= now;
    });

    if (due.length === 0) {
        console.log(`[sub-check] No subscriptions due at ${runAt}`);
        return { runAt, summary: [], dueCount: 0 };
    }

    console.log(`[sub-check] ${due.length} subscription(s) due at ${runAt}`);
    const summary = [];

    for (const tracked of due) {
        const result = {
            ghlSubId:      tracked.ghlSubId,
            contactEmail:  tracked.contactEmail,
            affiliateName: tracked.affiliateName,
            locationId:    tracked.locationId,
            interval:      tracked.billingInterval,
            action: null, error: null
        };

        try {
            // Fetch live subscription status from GHL
            const live = await fetchGHLSubscriptionById(tracked.locationId, tracked.ghlSubId);
            const liveStatus = (typeof live?.status === 'object' ? live.status?.status : live?.status) || 'unknown';
            const isActive   = liveStatus === 'active';

            const rec = db.trackedSubscriptions[tracked.ghlSubId];

            if (!isActive) {
                // ── CANCELLED / LAPSED ──────────────────────────────────────
                // Stop checking — the subscriber did not renew.
                rec.isActive   = false;
                rec.status     = liveStatus;
                rec.stopped    = true;
                rec.lastChecked = runAt;
                rec.checkCount  = (rec.checkCount || 0) + 1;
                rec.checkRetryCount = 0;
                rec.lastCheckError  = null;
                result.action   = `stopped — status: ${liveStatus}`;
                console.log(`[sub-check] ${tracked.contactEmail} (${tracked.billingInterval}) → STOPPED (${liveStatus})`);

            } else {
                // ── RENEWED / ACTIVE ────────────────────────────────────────
                // Advance nextCheckDate by one billing period + 2-day buffer
                const intervalMs     = intervalToMs(tracked.billingInterval);
                const newRenewal     = new Date(new Date(tracked.renewalDate).getTime() + intervalMs).toISOString();
                const newNextCheck   = calcNextCheckDate(newRenewal);

                rec.isActive       = true;
                rec.status         = liveStatus;
                rec.renewalDate    = newRenewal;
                rec.nextCheckDate  = newNextCheck;
                rec.lastChecked    = runAt;
                rec.checkCount     = (rec.checkCount || 0) + 1;
                rec.checkRetryCount = 0;
                rec.lastCheckError  = null;
                result.action      = `renewed — next check: ${newNextCheck}`;
                console.log(`[sub-check] ${tracked.contactEmail} (${tracked.billingInterval}) → RENEWED, next check: ${newNextCheck}`);

                // ── Reward the affiliate again for this renewal, per the rules ──
                // Only for subscriptions that are actually affiliated. checkCount
                // was just incremented above, so it's a stable, unique cycle
                // number for THIS renewal — using it in the tx id makes this
                // idempotent (a re-run before the next due date can never
                // double-pay the same renewal, since `due` requires
                // nextCheckDate <= now, and nextCheckDate has already moved
                // past "now" by the time this runs again).
                if (rec.isAffiliated && rec.affiliateId) {
                    const rule = rec.productId ? db.products[rec.productId] : null;
                    if (rule && rule.payoutValue > 0) {
                        const rewardTxId = `tx_renew_${tracked.ghlSubId}_${rec.checkCount}`;
                        if (!db.transactions[rewardTxId]) {
                            db.transactions[rewardTxId] = {
                                id: rewardTxId,
                                campaignId: rule.campaignId || db.affiliates[rec.affiliateId]?.campaignId || 'unknown',
                                contactId: rec.contactId,
                                affiliateId: rec.affiliateId,
                                affiliateName: rec.affiliateName,
                                productId: rec.productId,
                                subscriptionId: tracked.ghlSubId,
                                type: rule.payoutType || 'CASH',
                                amount: rule.payoutValue,
                                renewalCycle: rec.checkCount,
                                createdAt: runAt
                            };
                            result.rewardCreated = { txId: rewardTxId, amount: rule.payoutValue, type: rule.payoutType || 'CASH' };
                            console.log(`[sub-check] reward created for ${rec.affiliateName}: ${rule.payoutValue} (${rule.payoutType || 'CASH'}) — cycle ${rec.checkCount}`);
                        }
                    } else {
                        result.rewardSkipped = rule
                            ? 'product payout rule has no value configured'
                            : 'no payout rule configured for this subscription\'s product — set one under Settings';
                    }
                }

                // ── Push updated stats to CRM contact custom fields ─────────
                const locationId   = tracked.locationId;
                const affiliateRec = Object.values(db.affiliates || {}).find(a => a.id === tracked.affiliateId);

                if (affiliateRec) {
                    const push = await pushAffiliateStatsToCRM(db, locationId, tracked.affiliateId);
                    if (push.success) {
                        result.crmUpdated   = true;
                        result.crmContactId = push.contactId;
                        result.cashThisWeek = push.cashThisWeek;
                        result.cashTotal    = push.cashTotal;
                    } else {
                        result.crmError = push.error;
                    }
                }
            }

        } catch (err) {
            result.error = err.response?.data?.message || err.message;
            console.error(`[sub-check] Error checking ${tracked.ghlSubId}:`, result.error);

            // The GHL call itself failed (network error, 5xx, timeout, etc.) —
            // this tells us nothing about whether the subscription actually
            // renewed, so we must NOT mark it stopped or skip the reward.
            // Reschedule the check 1 day out and try again, up to
            // MAX_CHECK_RETRIES times, before falling back to the normal
            // billing-cycle cadence — this way a transient API failure can
            // never quietly cost the affiliate a renewal reward.
            const rec = db.trackedSubscriptions[tracked.ghlSubId];
            if (rec) {
                const retryCount = (rec.checkRetryCount || 0) + 1;
                rec.lastChecked     = runAt;
                rec.lastCheckError  = result.error;

                if (retryCount <= MAX_CHECK_RETRIES) {
                    rec.checkRetryCount = retryCount;
                    rec.nextCheckDate   = new Date(now + CHECK_RETRY_DELAY_MS).toISOString();
                    result.action = `check failed — retry ${retryCount}/${MAX_CHECK_RETRIES} scheduled for ${rec.nextCheckDate}`;
                    console.warn(`[sub-check] ${tracked.contactEmail || tracked.ghlSubId} — ${result.action}`);
                } else {
                    // Retries exhausted — resume the normal billing-period
                    // cadence rather than retrying forever, but keep tracking
                    // the subscription (don't mark it stopped) so the next
                    // real due date still checks it and can still reward it.
                    const intervalMs   = intervalToMs(tracked.billingInterval);
                    const fallbackRenewal = new Date(new Date(tracked.renewalDate).getTime() + intervalMs).toISOString();
                    rec.checkRetryCount = 0;
                    rec.nextCheckDate   = calcNextCheckDate(fallbackRenewal);
                    result.action = `check failed after ${MAX_CHECK_RETRIES} retries — resuming normal schedule at ${rec.nextCheckDate}`;
                    console.error(`[sub-check] ${tracked.contactEmail || tracked.ghlSubId} — ${result.action}`);
                }
            }
        }

        summary.push(result);
    }

    saveDB(db);

    // Persist last 20 run logs
    if (!db.subscriptionCheckLog) db.subscriptionCheckLog = [];
    db.subscriptionCheckLog.unshift({ runAt, summary });
    if (db.subscriptionCheckLog.length > 20) db.subscriptionCheckLog.length = 20;
    saveDB(db);

    console.log(`[sub-check] Run complete — ${summary.length} subscription(s) checked`);
    return { runAt, summary, dueCount: due.length };
}

// ─── API: Campaigns for a location ───────────────────────────────────────────
app.get('/api/campaigns/:locationId', async (req, res) => {
    const { locationId } = req.params;
    const db = loadDB();

    const hasCompanyToken = Object.values(db.installs).some(i => i.userType === 'Company' && i.refreshToken);
    if (!db.installs[locationId] && !hasCompanyToken) {
        const campaigns = Object.values(db.campaigns).filter(c => c.locationId === locationId);
        return res.json({ success: true, campaigns, source: 'local' });
    }

    // Promise.allSettled, not Promise.all: previously, one failing fetch (e.g.
    // affiliates hitting a 422) rejected the whole Promise.all and threw away
    // campaigns/products data that fetched just fine — silently dumping the
    // whole dashboard into 'local' fallback. Now each source is handled
    // independently and we only fall back per-source, with the real error
    // surfaced instead of swallowed.
    const settled = await Promise.allSettled([
        fetchGHLCampaigns(locationId),
        fetchGHLAffiliates(locationId),
        fetchGHLProducts(locationId)
    ]);
    const labels = ['campaigns', 'affiliates', 'products'];
    const errors = [];
    settled.forEach((r, i) => {
        if (r.status === 'rejected') {
            const err = r.reason;
            const msg = err.response?.data?.message || err.message;
            console.error(`[campaigns] ${labels[i]} fetch failed for ${locationId}:`, msg);
            errors.push(`${labels[i]}: ${msg}`);
        }
    });

    const localCampaigns = Object.values(db.campaigns).filter(c => c.locationId === locationId);
    const campaigns  = settled[0].status === 'fulfilled' ? settled[0].value : localCampaigns;
    const affiliates = settled[1].status === 'fulfilled' ? settled[1].value : [];
    const products    = settled[2].status === 'fulfilled' ? settled[2].value  : [];

    if (settled[0].status === 'fulfilled' || settled[1].status === 'fulfilled') {
        associateAffiliatesWithCampaigns(affiliates, campaigns);
    }
    campaigns.forEach(c  => { db.campaigns[c.id]  = c; });
    affiliates.forEach(a => { db.affiliates[a.id] = { ...db.affiliates[a.id], ...a }; });
    products.forEach(p   => { db.products[p.id]   = p; });
    saveDB(db);

    const allFailed = errors.length === settled.length;
    const source = allFailed ? 'local' : (errors.length ? 'crm-partial' : 'crm');
    console.log(`[campaigns] synced for ${locationId}: ${campaigns.length} campaigns, ${affiliates.length} affiliates, ${products.length} products` + (errors.length ? ` (${errors.length} source(s) failed)` : ''));
    return res.json({
        success: true,
        campaigns: allFailed ? localCampaigns : campaigns,
        source,
        warning: errors.length ? errors.join('; ') : undefined
    });
});

// ─── API: Dashboard data for a campaign ──────────────────────────────────────
app.get('/api/dashboard/:campaignId', async (req, res) => {
    const { campaignId } = req.params;
    const { locationId } = req.query;
    const db = loadDB();

    // Best-effort live sync — dashboard still renders from local data if this
    // fails. allSettled so a failing affiliates fetch doesn't also block a
    // successful products fetch (and vice versa) from being saved.
    let syncWarning;
    if (locationId) {
        const settled = await Promise.allSettled([
            fetchGHLAffiliates(locationId),
            fetchGHLProducts(locationId)
        ]);
        const dashLabels = ['affiliates', 'products'];
        const dashErrors = [];
        settled.forEach((r, i) => {
            if (r.status === 'rejected') {
                const err = r.reason;
                const msg = err.response?.data?.message || err.message;
                console.warn(`[dashboard] ${dashLabels[i]} sync failed for ${locationId}:`, msg);
                dashErrors.push(`${dashLabels[i]}: ${msg}`);
            }
        });
        if (dashErrors.length) syncWarning = dashErrors.join('; ');

        const liveAffiliates = settled[0].status === 'fulfilled' ? settled[0].value : [];
        const liveProducts   = settled[1].status === 'fulfilled' ? settled[1].value : [];
        if (liveAffiliates.length || liveProducts.length) {
            const knownCampaigns = Object.values(db.campaigns || {}).filter(c => c.locationId === locationId);
            associateAffiliatesWithCampaigns(liveAffiliates, knownCampaigns);
            liveAffiliates.forEach(a => { db.affiliates[a.id] = { ...db.affiliates[a.id], ...a }; });
            liveProducts.forEach(p => { db.products[p.id] = p; });
            saveDB(db);
        }
    }

    const campaign = db.campaigns?.[campaignId] || null;

    // Defensive: always coerce to arrays before filter/reduce, no matter what's in the DB
    const allAffiliates   = Array.isArray(Object.values(db.affiliates   || {})) ? Object.values(db.affiliates   || {}) : [];
    const allProducts     = Array.isArray(Object.values(db.products     || {})) ? Object.values(db.products     || {}) : [];
    const allTransactions = Array.isArray(Object.values(db.transactions || {})) ? Object.values(db.transactions || {}) : [];

    const affiliates = allAffiliates.filter(a =>
        (Array.isArray(a.campaignIds) && a.campaignIds.includes(campaignId)) ||
        a.campaignId === campaignId
    );

    const products = allProducts.filter(p =>
        p.locationId === locationId ||
        p.campaignId === campaignId ||
        (!p.campaignId && p.locationId === (campaign?.locationId || locationId))
    );

    const campaignTransactions = allTransactions.filter(t => t.campaignId === campaignId);

    // Strict affiliateId aggregation — no name matching, no collisions
    const enrichedAffiliates = affiliates.map(aff => {
        const affTxns = campaignTransactions.filter(t => t.affiliateId && aff.id && t.affiliateId === aff.id);

        // totalCash = this affiliate's full running "Total Earned" — every
        // sold product recorded for them, whether it paid out as a CASH
        // commission or a LEAD reward. Both types are real dollars owed to
        // the affiliate; only the trigger event (a lead vs. a full sale)
        // differs. This is a running ledger sum, so it grows on its own as
        // each week's renewal/lead transactions are added — no separate
        // "+=" counter needed, and it starts at 0 for a brand-new affiliate.
        const totalCash  = affTxns.reduce((sum, t) => sum + Number(t.amount || 0), 0);
        // totalLeads stays LEAD-only — this is the distinct "value of leads
        // generated" stat shown next to it, not a duplicate of totalCash.
        const totalLeads = affTxns.filter(t => t.type === 'LEAD').reduce((sum, t) => sum + Number(t.amount || 0), 0);

        return { ...aff, totalCash, totalLeads, customer: affTxns.length };
    });

    const recentTransactions = campaignTransactions
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 50);

    // Always return a valid, fully-shaped JSON object — never undefined fields
    res.json({
        success: true,
        campaign,
        affiliates: enrichedAffiliates,
        transactions: recentTransactions,
        products,
        syncWarning
    });
});

// ─── API: Save settings / product rules ──────────────────────────────────────
app.post('/api/settings', (req, res) => {
    const { locationId, campaignId, campaignName, productId, productName, payoutType, payoutValue, sheetId } = req.body;
    const db = loadDB();

    if (campaignId && campaignName)
        db.campaigns[campaignId] = { ...db.campaigns[campaignId], id: campaignId, locationId, name: campaignName };
    if (locationId && sheetId)
        db.settings[locationId]  = { locationId, sheetId };
    if (productId && campaignId)
        db.products[productId]   = { ...db.products[productId], id: productId, campaignId, name: productName, payoutType, payoutValue };

    saveDB(db);
    res.json({ success: true });
});

// ─── Webhook: Purchase (incoming from GHL automation) ────────────────────────
// Accepts a purchase event. If affiliateName is present, records the
// contactId → affiliate mapping so the subscription sync can link them.
app.post('/webhook/purchase', (req, res) => {
    const { campaignId, contactId, productId, amount, affiliateName, subscriptionId } = req.body;
    if (!campaignId || !contactId)
        return res.status(400).json({ error: 'Missing required fields: campaignId, contactId' });

    const db  = loadDB();
    const txId = `trans_${Date.now()}`;

    // Resolve affiliate by name up front so we can store a stable affiliateId
    // (the dashboard now matches strictly on affiliateId, not name)
    let aff = null;
    if (affiliateName && affiliateName !== 'Unknown') {
        aff = Object.values(db.affiliates || {}).find(
            a => a.name?.toLowerCase() === affiliateName.toLowerCase()
        );
    }

    db.transactions[txId] = {
        id: txId, campaignId, contactId,
        affiliateId:   aff?.id || null,
        affiliateName: affiliateName || 'Unknown',
        productId:     productId     || 'unknown',
        subscriptionId: subscriptionId || null,
        type: 'CASH', amount: amount || 0,
        createdAt: new Date().toISOString()
    };

    // Record contactId → affiliate mapping so subscription sync can use it
    if (aff && contactId) {
        if (!db.contactAffiliateMap) db.contactAffiliateMap = {};
        db.contactAffiliateMap[contactId] = {
            affiliateId:   aff.id,
            affiliateName: aff.name,
            locationId:    aff.locationId || null
        };
    }

    saveDB(db);
    res.json({ success: true, transactionId: txId });

    // Push updated stats to the affiliate's CRM contact — fire-and-forget so
    // the webhook response isn't held up by a CRM round-trip. Any failure is
    // logged inside pushAffiliateStatsToCRM and never surfaces to the caller.
    if (aff && aff.locationId) {
        pushAffiliateStatsToCRM(db, aff.locationId, aff.id);
    }
});

// ─── GHL: Locations where this app is installed (Company/Agency-level) ───────
// Requires BOTH companyId and appId per GHL's API — a missing GHL_APP_ID env
// var is the #1 cause of this silently returning zero locations, since GHL
// rejects the request without a valid appId. Paginated via skip/limit.
async function fetchInstalledLocationsForCompany(companyToken, companyId) {
    if (!process.env.GHL_APP_ID) {
        throw new Error('GHL_APP_ID environment variable is not set — GoHighLevel requires it to look up installed locations for a company/agency install.');
    }

    const allLocs = [];
    let skip = 0;
    const limit = 100;

    while (true) {
        const res = await axios.get(GHL_INSTALLED_LOCS, {
            params: {
                companyId,
                appId: process.env.GHL_APP_ID,
                isInstalled: true,
                limit, skip
            },
            headers: { 'Authorization': `Bearer ${companyToken}`, 'Version': GHL_API_VER, 'Accept': 'application/json' },
            timeout: 10000
        });
        const page = res.data?.locations || res.data?.installedLocations || res.data?.data || [];
        allLocs.push(...page);
        if (page.length < limit) break;
        skip += limit;
    }

    const locIds = allLocs.map(l => l.locationId || l._id || l.id).filter(Boolean);
    console.log(`[oauth] installedLocations returned ${locIds.length} location(s) for company ${companyId}`);
    return locIds;
}

// ─── GHL: All sub-accounts under an agency (Company) ─────────────────────────
// Endpoint: GET /locations/search  Version: v3
// Fallback for when /oauth/installedLocations comes back empty. That
// endpoint only lists locations with an "isInstalled" flag for THIS specific
// app — which only ever gets set when the app is bulk-installed per
// sub-account. An app whose "Who can install" / distribution is Agency-level
// can be authorized once at the Company level with NO per-location install
// records created at all (the Company token can already mint a location
// token for any of the agency's sub-accounts on demand) — so
// installedLocations legitimately, silently returns zero locations even
// though the agency has real, usable sub-accounts. This lists the agency's
// actual sub-accounts directly instead, and — unlike installedLocations —
// doesn't depend on GHL_APP_ID being configured at all.
async function fetchLocationsForCompany(companyToken, companyId) {
    const allLocs = [];
    let skip = 0;
    const limit = 100;

    while (true) {
        const res = await axios.get(`${GHL_API_BASE}/locations/search`, {
            params: { companyId, limit, skip },
            headers: { 'Authorization': `Bearer ${companyToken}`, 'Version': GHL_API_VER_V3, 'Accept': 'application/json' },
            timeout: 10000
        });
        const page = res.data?.locations || res.data?.data || [];
        allLocs.push(...page);
        if (page.length < limit) break;
        skip += limit;
    }

    const locIds = allLocs.map(l => l.locationId || l._id || l.id).filter(Boolean);
    console.log(`[oauth] locations/search returned ${locIds.length} sub-account(s) for company ${companyId}`);
    return locIds;
}

// ─── API: Manually re-resolve + token-exchange locations for a company ───────
// Use this after an install shows "0 locations" (e.g. GHL_APP_ID was missing
// at install time and has since been fixed, or a new sub-account was added to
// the agency afterward) — no need to fully reinstall the app.
app.post('/api/admin/resolve-locations/:companyId', async (req, res) => {
    const { companyId } = req.params;
    const db = loadDB();
    const companyInstall = db.installs[`company_${companyId}`];
    if (!companyInstall?.accessToken) {
        return res.status(400).json({ success: false, error: `No stored company token for ${companyId}. Reinstall the app first.` });
    }

    try {
        let companyToken = companyInstall.accessToken;
        if (isTokenExpired(companyInstall)) companyToken = await refreshCompanyToken(companyId);

        let locIds = [];
        let resolveWarning = null;
        try {
            locIds = await fetchInstalledLocationsForCompany(companyToken, companyId);
        } catch (ilErr) {
            resolveWarning = ilErr.response?.data?.message || ilErr.message;
            console.error('[resolve-locations] installedLocations fetch failed:', ilErr.response?.data || ilErr.message);
        }

        // Same fallback as the OAuth callback: an Agency-level install can
        // have zero per-location "isInstalled" records, so fall back to the
        // agency's actual sub-account list — this also doesn't need
        // GHL_APP_ID, so it can recover even when that's what failed above.
        if (locIds.length === 0) {
            try {
                locIds = await fetchLocationsForCompany(companyToken, companyId);
                if (locIds.length > 0) resolveWarning = null;
            } catch (searchErr) {
                console.error('[resolve-locations] locations/search fallback failed:', searchErr.response?.data || searchErr.message);
                if (!resolveWarning) resolveWarning = searchErr.response?.data?.message || searchErr.message;
            }
        }

        const resolved = [];
        const errors = [];

        for (const locId of locIds) {
            try {
                const locData = await getLocationToken(companyToken, companyId, locId);
                db.installs[locId] = {
                    locationId: locId, accessToken: locData.accessToken,
                    refreshToken: locData.refreshToken || companyInstall.refreshToken,
                    tokenType: locData.tokenType || 'Bearer', expiresIn: locData.expiresIn,
                    scope: locData.scope || companyInstall.scope, userId: locData.userId || companyInstall.userId,
                    companyId, userType: 'Location', installedAt: db.installs[locId]?.installedAt || new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };
                resolved.push(locId);
            } catch (locErr) {
                errors.push({ locationId: locId, error: locErr.response?.data?.message || locErr.message });
            }
        }
        saveDB(db);
        res.json({ success: true, resolvedLocations: resolved, total: locIds.length, errors, warning: locIds.length === 0 ? resolveWarning : undefined });
    } catch (err) {
        console.error('[resolve-locations] error:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.response?.data?.message || err.message });
    }
});

// ─── GHL OAuth — /oauth/callback/lc ──────────────────────────────────────────
app.get('/oauth/callback/lc', async (req, res) => {
    const { code, error, error_description } = req.query;

    if (error) {
        return res.status(400).send(`<h2>OAuth Error</h2><p><strong>${error}</strong>: ${error_description || 'Unknown error from CRM'}</p>`);
    }
    if (!code) {
        return res.status(400).send('<h2>Missing authorization code.</h2>');
    }
    if (!process.env.GHL_CLIENT_ID || !process.env.GHL_CLIENT_SECRET) {
        return res.status(500).send('<h2>CRM client credentials not configured on server.</h2>');
    }

    try {
        const tokenParams = new URLSearchParams({
            client_id:     process.env.GHL_CLIENT_ID,
            client_secret: process.env.GHL_CLIENT_SECRET,
            grant_type:    'authorization_code',
            code,
            redirect_uri:  process.env.GHL_REDIRECT_URI
        });
        const tokenRes = await axios.post(GHL_TOKEN_URL, tokenParams.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        const {
            access_token, refresh_token, token_type, expires_in, scope,
            userType, locationId: directLocationId, companyId, userId,
            // NOTE: GHL's /oauth/token response does NOT reliably include an
            // approved-locations array for Company/bulk installs (confirmed
            // gap in GHL's own API — see highlevel-api-docs#294). Location
            // resolution for a Company install almost always has to go
            // through the separate installedLocations call below.
            approvedLocations = []
        } = tokenRes.data;

        const db = loadDB();
        const installedLocations = [];
        let locationResolveError = null;

        if (userType === 'Location' && directLocationId) {
            db.installs[directLocationId] = {
                locationId: directLocationId, accessToken: access_token,
                refreshToken: refresh_token, tokenType: token_type,
                expiresIn: expires_in, scope, userId, companyId, userType,
                installedAt: new Date().toISOString()
            };
            installedLocations.push(directLocationId);
        } else if (userType === 'Company') {
            db.installs[`company_${companyId}`] = {
                companyId, accessToken: access_token, refreshToken: refresh_token,
                tokenType: token_type, expiresIn: expires_in, scope, userId, userType,
                installedAt: new Date().toISOString()
            };
            saveDB(db);

            let locIds = approvedLocations.length > 0 ? [...approvedLocations] : [];
            if (locIds.length === 0) {
                try {
                    locIds = await fetchInstalledLocationsForCompany(access_token, companyId);
                } catch (ilErr) {
                    locationResolveError = ilErr.response?.data?.message || ilErr.message;
                    console.error('[oauth] installedLocations fetch failed:', ilErr.response?.data || ilErr.message);
                }
            }

            // installedLocations only lists locations with a per-location
            // "isInstalled" flag for this app — an Agency-distributed install
            // can be authorized at the Company level with none of those
            // records ever created, so a 0-result (or a hard failure, e.g.
            // GHL_APP_ID missing) here doesn't mean the agency has no usable
            // locations. Fall back to listing its actual sub-accounts.
            if (locIds.length === 0) {
                try {
                    locIds = await fetchLocationsForCompany(access_token, companyId);
                    if (locIds.length > 0) locationResolveError = null;
                } catch (searchErr) {
                    console.error('[oauth] locations/search fallback failed:', searchErr.response?.data || searchErr.message);
                    if (!locationResolveError) locationResolveError = searchErr.response?.data?.message || searchErr.message;
                }
            }

            for (const locId of locIds) {
                try {
                    const locData = await getLocationToken(access_token, companyId, locId);
                    db.installs[locId] = {
                        locationId: locId, accessToken: locData.accessToken,
                        refreshToken: locData.refreshToken || refresh_token,
                        tokenType: locData.tokenType || 'Bearer', expiresIn: locData.expiresIn,
                        scope: locData.scope || scope, userId: locData.userId || userId,
                        companyId, userType: 'Location', installedAt: new Date().toISOString()
                    };
                    installedLocations.push(locId);
                } catch (locErr) {
                    console.error(`[oauth] location token failed for ${locId}:`, locErr.response?.data || locErr.message);
                }
            }

            // Locations existed but every one of them failed the token exchange —
            // still worth surfacing rather than a silent "0 locations".
            if (!locationResolveError && locIds.length > 0 && installedLocations.length === 0) {
                locationResolveError = `Found ${locIds.length} installed location(s) but the location-token exchange failed for all of them — check server logs for details.`;
            }
        } else {
            console.error('[oauth] unexpected token response:', tokenRes.data);
            return res.status(400).send(`<h2>Unexpected token response from CRM</h2><pre>${JSON.stringify(tokenRes.data, null, 2)}</pre>`);
        }

        let totalCampaigns = 0;
        for (const locId of installedLocations) {
            try {
                const campaigns = await fetchGHLCampaigns(locId);
                campaigns.forEach(c => { db.campaigns[c.id] = c; });
                totalCampaigns += campaigns.length;
            } catch (e) {
                console.warn(`[oauth] campaign pre-fetch failed for ${locId}:`, e.message);
            }
        }
        saveDB(db);

        const primaryLocId = installedLocations[0] || '';
        const noLocationsBlock = locationResolveError
            ? `<div class="bg-red-50 border border-red-200 rounded-xl p-4 text-left text-sm text-red-700 mb-4">
                 <strong>Locations couldn't be resolved:</strong> ${locationResolveError}
                 ${!process.env.GHL_APP_ID ? '<br><br>Set the <code>GHL_APP_ID</code> environment variable (found under your app\'s settings in the GHL Marketplace) and click retry below — no need to reinstall.' : ''}
               </div>
               <button onclick="retryResolve()" class="inline-block bg-gray-900 hover:bg-gray-800 text-white font-semibold px-6 py-3 rounded-xl transition-colors">Retry resolving locations</button>
               <p id="retryStatus" class="text-gray-400 text-xs mt-3"></p>
               <script>
                 async function retryResolve() {
                   const statusEl = document.getElementById('retryStatus');
                   statusEl.textContent = 'Retrying…';
                   try {
                     const res = await fetch('/api/admin/resolve-locations/${companyId}', { method: 'POST' });
                     const data = await res.json();
                     if (data.success && data.resolvedLocations.length > 0) {
                       window.location.href = '/?locationId=' + data.resolvedLocations[0];
                     } else if (data.success) {
                       statusEl.textContent = 'Still 0 locations resolved. ' + (data.errors?.[0]?.error || 'Check server logs.');
                     } else {
                       statusEl.textContent = data.error || 'Retry failed.';
                     }
                   } catch (e) {
                     statusEl.textContent = 'Retry failed: ' + e.message;
                   }
                 }
               </script>`
            : `<p class="text-gray-400 text-sm">No locations resolved.</p>`;

        return res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>LEAF Installed</title><script src="https://cdn.tailwindcss.com"></script></head>
<body class="bg-gray-50 flex items-center justify-center min-h-screen font-sans">
  <div class="bg-white rounded-2xl shadow-lg p-10 max-w-lg w-full text-center">
    <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
      <svg class="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7"/>
      </svg>
    </div>
    <h1 class="text-2xl font-bold text-gray-900 mb-2">LEAF Installed!</h1>
    <p class="text-gray-500 mb-6">Successfully connected to your CRM account.</p>
    <div class="bg-gray-50 rounded-xl p-4 text-left text-sm space-y-2 mb-6">
      <div class="flex justify-between"><span class="text-gray-500">Install Type</span>
        <span class="font-medium px-2 py-0.5 rounded-full text-xs ${userType === 'Company' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}">${userType}</span>
      </div>
      <div class="flex justify-between"><span class="text-gray-500">Company ID</span><span class="font-mono text-xs">${companyId || '—'}</span></div>
      <div class="flex justify-between"><span class="text-gray-500">Locations</span><span class="font-bold text-blue-600">${installedLocations.length}</span></div>
      <div class="flex justify-between"><span class="text-gray-500">Campaigns cached</span><span class="font-bold text-green-600">${totalCampaigns}</span></div>
    </div>
    ${primaryLocId ? `<a href="/?locationId=${primaryLocId}" class="inline-block bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-3 rounded-xl transition-colors">Open Dashboard →</a>` : noLocationsBlock}
  </div>
</body></html>`);

    } catch (err) {
        console.error('[oauth] error:', err.response?.data || err.message);
        return res.status(500).send(`<h2>OAuth Failed</h2><pre>${err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message}</pre>`);
    }
});

// ─── SSO: decrypt the postMessage payload from GHL Custom Page iframes ───────
// GHL Marketplace Custom Pages don't put locationId in the iframe's URL — the
// only way to learn who's actually looking at the page is this SSO flow:
// the frontend asks the GHL parent window (via postMessage) for the current
// user/location context, GHL replies with an AES-256-CBC-encrypted, base64
// payload, and this endpoint decrypts it using the app's Shared Secret
// (Marketplace → App Settings → Advanced Settings → Auth). The encryption is
// CryptoJS's OpenSSL-compatible "Salted__" format with EVP_BytesToKey (MD5)
// key derivation — this replicates that using Node's built-in crypto module.
function evpBytesToKey(password, salt, keyLen = 32, ivLen = 16) {
    let d = Buffer.alloc(0);
    let keyIv = Buffer.alloc(0);
    while (keyIv.length < keyLen + ivLen) {
        d = crypto.createHash('md5').update(Buffer.concat([d, password, salt])).digest();
        keyIv = Buffer.concat([keyIv, d]);
    }
    return { key: keyIv.subarray(0, keyLen), iv: keyIv.subarray(keyLen, keyLen + ivLen) };
}

function decryptSSOPayload(encryptedData, sharedSecret) {
    const raw = Buffer.from(encryptedData, 'base64');
    if (raw.subarray(0, 8).toString('utf8') !== 'Salted__') {
        throw new Error("Invalid SSO payload: missing 'Salted__' header");
    }
    const salt       = raw.subarray(8, 16);
    const ciphertext = raw.subarray(16);
    const { key, iv } = evpBytesToKey(Buffer.from(sharedSecret, 'utf8'), salt);
    const decipher    = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const plaintext   = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf8'));
}

// ─── API: Decrypt the SSO payload sent from index.html ───────────────────────
app.post('/sso/decrypt', (req, res) => {
    const { key } = req.body || {};
    if (!key) {
        return res.status(400).json({ success: false, error: 'Missing SSO key' });
    }
    if (!GHL_SHARED_SECRET) {
        console.error('[sso] GHL_SHARED_SECRET is not set — cannot decrypt SSO payloads');
        return res.status(500).json({ success: false, error: 'SSO is not configured on the server' });
    }
    try {
        const data = decryptSSOPayload(key, GHL_SHARED_SECRET);
        return res.json({ success: true, data });
    } catch (err) {
        console.error('[sso] Decryption failed:', err.message);
        return res.status(400).json({ success: false, error: 'Failed to decrypt SSO payload' });
    }
});

// ─── API: List installed locations ────────────────────────────────────────────
// Requires ?locationId=... in the URL. Previously this returned every
// installed account's locationId/companyId with no filtering at all — any
// customer's frontend calling this endpoint could see every OTHER
// customer's location and company IDs. Now it only ever returns the single
// install matching the locationId passed in, and returns nothing at all if
// the URL doesn't include one.
app.get('/api/locations', (req, res) => {
    const { locationId } = req.query;
    if (!locationId) {
        return res.json({ success: true, locations: [] });
    }
    const db = loadDB();
    const install = db.installs[locationId];
    if (!install || !install.locationId) {
        return res.json({ success: true, locations: [] });
    }
    const locations = [{
        locationId: install.locationId,
        companyId:  install.companyId  || null,
        userId:     install.userId     || null,
        installedAt: install.installedAt || null
    }];
    return res.json({ success: true, locations });
});

// ─── Auto-refresh: full sync (campaigns/products/affiliates/subscriptions) ───
// for every installed location. This is what picks up brand-new subscriptions,
// affiliates, products, and campaigns automatically — the renewal-check cron
// only re-checks subscriptions that are ALREADY in trackedSubscriptions, so
// without this step new signups would never get tracked until someone
// manually clicked "Sync Subscriptions".
function getAllInstalledLocationIds(db) {
    const ids = Object.values(db.installs)
        .filter(i => i.locationId && !i.locationId.startsWith('company_'))
        .map(i => i.locationId);
    return [...new Set(ids)];
}

async function autoRefreshAllLocations() {
    const db = loadDB();
    const locationIds = getAllInstalledLocationIds(db);
    const runAt = new Date().toISOString();
    const perLocation = [];

    for (const locationId of locationIds) {
        try {
            const r = await syncSubscriptionsFromGHL(locationId);
            perLocation.push({
                locationId,
                added: r.added.length,
                updated: r.updated.length,
                errors: r.errors.length,
                rawCount: r.rawCount
            });
        } catch (err) {
            const msg = err.response?.data?.message || err.message;
            console.error(`[auto-refresh] sync failed for ${locationId}:`, msg);
            perLocation.push({ locationId, error: msg });
        }
    }

    const dbAfter = loadDB();
    if (!dbAfter.autoRefreshLog) dbAfter.autoRefreshLog = [];
    dbAfter.autoRefreshLog.unshift({ runAt, locations: perLocation });
    if (dbAfter.autoRefreshLog.length > 20) dbAfter.autoRefreshLog.length = 20;
    saveDB(dbAfter);

    console.log(`[auto-refresh] complete for ${locationIds.length} location(s) at ${runAt}`);
    return { runAt, locations: perLocation };
}

// ─── API: Manual trigger — run the full auto-refresh now (all locations) ─────
app.post('/api/auto-refresh/run', async (req, res) => {
    try {
        const result = await autoRefreshAllLocations();
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[auto-refresh] manual trigger error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── API: Auto-refresh status/log ─────────────────────────────────────────────
app.get('/api/auto-refresh/status', (req, res) => {
    const db = loadDB();
    res.json({ success: true, log: (db.autoRefreshLog || []).slice(0, 10) });
});

// ─── CRM: Search contact by email ────────────────────────────────────────────
// GHL v2's contact search ("Search Contacts") is a POST with a JSON filters
// body — there is no GET /contacts/search. The previous implementation sent
// a GET with query params (locationId/query/limit), which is not a route
// this endpoint supports, so it was silently failing (or matching nothing)
// every time an affiliate's contactId wasn't already cached — i.e. exactly
// the case this function exists to handle.
//
// We filter on an exact email match (`eq`), and then re-verify the result
// client-side too, so a broader server-side match can never hand back the
// wrong contact for an affiliate.
async function searchContactByEmail(locationId, email) {
    const res = await ghlApiRequest(locationId, (token) => ({
        method:  'post',
        url:     `${GHL_API_BASE}/contacts/search`,
        data: {
            locationId,
            pageLimit: 1,
            filters: [
                { field: 'email', operator: 'eq', value: email }
            ]
        },
        headers: ghlHeaders(token, GHL_API_VER_V3),
        timeout: 10000
    }));
    const contacts = res.data?.contacts || res.data?.data || [];
    // Defensive: only ever return a contact whose email actually matches —
    // never trust a fuzzy/contains-style match to be "the" affiliate's contact.
    const exact = contacts.find(c => (c.email || '').toLowerCase() === email.toLowerCase());
    return exact || null;
}

// ─── CRM: Get a contact by ID (used to verify a cached contactId is still valid) ─
async function getContactById(locationId, contactId) {
    try {
        const res = await ghlApiRequest(locationId, (token) => ({
            method:  'get',
            url:     `${GHL_API_BASE}/contacts/${contactId}`,
            headers: ghlHeaders(token, GHL_API_VER_V3),
            timeout: 10000
        }));
        return res.data?.contact || res.data || null;
    } catch (err) {
        if (err.response?.status === 404) return null; // deleted/merged contact — not an error, just stale
        throw err;
    }
}

// ─── CRM: Update a contact's custom fields ────────────────────────────────────
async function updateContactCustomFields(locationId, contactId, fields) {
    // fields: [{ id, key, field_value }]  — Version: v3
    // NOTE: GHL's API expects the snake_case "field_value" key. The value
    // was previously sent as "fieldValue" (camelCase), which GHL's API
    // silently ignores instead of erroring on — so these calls were
    // returning 200 OK while never actually writing the custom field value.
    const res = await ghlApiRequest(locationId, (token) => ({
        method:  'put',
        url:     `${GHL_API_BASE}/contacts/${contactId}`,
        data:    { customFields: fields },
        headers: ghlHeaders(token, GHL_API_VER_V3),
        timeout: 10000
    }));

    // Soft-verify: GHL has a track record of returning 200 OK on writes that
    // didn't actually persist (see note above), so don't just trust the
    // status code — check whether the updated contact object GHL sends back
    // actually echoes each field id we just wrote. This is diagnostic only
    // (a differently-shaped response is NOT treated as a failure, since
    // GHL isn't guaranteed to always return the full contact), but it turns
    // a silent no-op write into a visible warning in the logs instead of a
    // false "success".
    const updatedContact = res.data?.contact || res.data || {};
    const echoedFields    = updatedContact.customFields || updatedContact.customField || null;
    if (Array.isArray(echoedFields)) {
        const echoedIds = new Set(echoedFields.map(f => f.id));
        const missing   = fields.filter(f => !echoedIds.has(f.id));
        if (missing.length) {
            console.warn(`[crm-update] contact ${contactId}: PUT returned 200 but ${missing.length}/${fields.length} field(s) weren't echoed back in the response — id(s): ${missing.map(f => f.id).join(', ')}. The write may not have persisted.`);
        }
    }

    return res.data;
}

// ─── CRM: Push an affiliate's stats onto their GHL contact's custom fields ──
// Writes Leads This Week / Total Earned This Week / Total Earned (whichever
// of the three custom fields exist for this location — see
// setupCustomFieldsForLocation) onto the contact record for the given
// affiliate. Called from three places so the numbers stay fresh instead of
// only updating on the next weekly/monthly renewal check:
//   1. syncSubscriptionsFromGHL  — right after a sync picks up new/changed subs
//   2. runSubscriptionChecks     — after each renewal
//   3. POST /webhook/purchase    — right after a new purchase is recorded
// Best-effort by design: returns { success:false, error } on any failure
// (no contact found, CRM call failed, fields not set up) rather than
// throwing, since a CRM write failing must never abort the sync/check/webhook
// that triggered it.
async function pushAffiliateStatsToCRM(db, locationId, affiliateId) {
    const customFieldIds = db.customFields?.[locationId] || {};
    const affiliateRec   = Object.values(db.affiliates || {}).find(a => a.id === affiliateId);

    if (!affiliateRec) return { success: false, error: 'affiliate not found' };
    if (!customFieldIds.leads_this_week && !customFieldIds.cash_this_week && !customFieldIds.total_earned) {
        return { success: false, error: 'custom fields not set up for this location' };
    }

    try {
        // "Leads This Week" = count of this affiliate's currently active,
        // affiliated subscriptions (i.e. live referrals still paying).
        const leadsCount = Object.values(db.trackedSubscriptions || {}).filter(s =>
            s.affiliateId === affiliateId && s.isActive && !s.stopped
        ).length;

        // Cash earned in the last 7 days vs. all-time — always from LEAF's own
        // local ledger (never GHL's native `revenue` figure); reconciling from
        // locally-generated transaction records is the whole point of this system.
        const cashThisWeek = computeAffiliateCash(db, affiliateId, 7);
        const cashTotal     = computeAffiliateCash(db, affiliateId, null);

        // Prefer the affiliate's own GHL contactId when the affiliate-manager
        // API returned one — an email search can silently miss/mismatch when
        // the affiliate has no email set, or the email differs from their
        // contact record. But a cached contactId can go stale (contact deleted
        // or merged in GHL after we recorded it), so verify it still resolves
        // before trusting it — a 404 falls through to the email search instead
        // of silently writing to a contact that no longer exists.
        let contactId = affiliateRec.contactId || null;
        if (contactId) {
            const verified = await getContactById(locationId, contactId);
            if (!verified) contactId = null;
        }
        if (!contactId && affiliateRec.email) {
            const contact = await searchContactByEmail(locationId, affiliateRec.email);
            contactId = contact?.id || contact?._id || null;
        }

        if (!contactId) {
            const error = `No contact found for affiliate ${affiliateRec.name || affiliateRec.email || affiliateId}`;
            console.warn(`[crm-push] ${error}`);
            return { success: false, error };
        }

        const fields = [];
        if (customFieldIds.leads_this_week)
            fields.push({ id: customFieldIds.leads_this_week, key: 'leads_this_week', field_value: String(leadsCount) });
        if (customFieldIds.cash_this_week)
            fields.push({ id: customFieldIds.cash_this_week, key: 'cash_this_week', field_value: String(cashThisWeek) });
        if (customFieldIds.total_earned)
            fields.push({ id: customFieldIds.total_earned, key: 'total_earned', field_value: String(cashTotal) });

        if (!fields.length) return { success: false, error: 'no custom field ids configured' };

        await updateContactCustomFields(locationId, contactId, fields);
        console.log(`[crm-push] ${affiliateRec.name || affiliateRec.email}: leads=${leadsCount} cashThisWeek=${cashThisWeek} totalEarned=${cashTotal} → contact ${contactId}`);
        return { success: true, contactId, leadsCount, cashThisWeek, cashTotal };
    } catch (err) {
        const error = err.response?.data?.message || err.message;
        console.warn(`[crm-push] failed for affiliate ${affiliateRec?.email || affiliateId}:`, error);
        return { success: false, error };
    }
}

// ─── CRM: Create a custom field for a location ───────────────────────────────
// Endpoint: POST /locations/:locationId/customFields  Version: v3
async function createCustomField(locationId, name, fieldKey, dataType = 'NUMERICAL') {
    const res = await ghlApiRequest(locationId, (token) => ({
        method:  'post',
        url:     `${GHL_API_BASE}/locations/${locationId}/customFields`,
        data:    { name, dataType, placeholder: '0', model: 'contact' },
        headers: ghlHeaders(token, GHL_API_VER_V3),
        timeout: 10000
    }));
    return res.data?.customField || res.data;
}

// ─── CRM: List all custom fields for a location ──────────────────────────────
// Endpoint: GET /locations/:locationId/customFields  Version: v3
// Used to resolve a field's real ID when it already exists in GHL (created
// manually in the UI, or by an earlier setup run) — without this, the
// "already exists" case below could only ever be noted, never resolved to
// an actual field ID, leaving db.customFields empty for that key and every
// future CRM push silently skipping it forever.
async function fetchLocationCustomFields(locationId) {
    const res = await ghlApiRequest(locationId, (token) => ({
        method:  'get',
        url:     `${GHL_API_BASE}/locations/${locationId}/customFields`,
        params:  { model: 'contact' },
        headers: ghlHeaders(token, GHL_API_VER_V3),
        timeout: 10000
    }));
    return res.data?.customFields || res.data?.customField || [];
}

// ─── CRM: Ensure custom fields exist for a location ──────────────────────────
async function setupCustomFieldsForLocation(locationId) {
    const db = loadDB();
    if (!db.customFields) db.customFields = {};
    const existing = db.customFields[locationId] || {};
    const results  = { locationId, created: [], resolved: [], alreadyExists: [] };

    // Fetch what's actually in GHL up front. This lets a field that already
    // exists there (created manually, or by a previous run that failed
    // partway through before saving) get its real ID adopted immediately,
    // instead of only being detected as "exists" via a 422 with no way to
    // learn its ID.
    let remoteFields = [];
    try {
        remoteFields = await fetchLocationCustomFields(locationId);
    } catch (err) {
        console.warn(`[setup-custom-fields] could not list existing fields for ${locationId}:`, err.response?.data?.message || err.message);
    }
    const findRemoteByName = (label) => remoteFields.find(f =>
        (f.name || '').trim().toLowerCase() === label.trim().toLowerCase()
    );

    async function ensureField(label, key) {
        if (existing[key]) {
            results.alreadyExists.push(label);
            return existing[key];
        }

        // Already there in GHL — adopt its real ID rather than creating a
        // duplicate or leaving it unresolved.
        const remoteMatch = findRemoteByName(label);
        if (remoteMatch) {
            const id = remoteMatch.id || remoteMatch._id;
            if (id) {
                db.customFields[locationId] = { ...db.customFields[locationId], [key]: id };
                saveDB(db);
                results.resolved.push(label);
                return id;
            }
        }

        try {
            const field = await createCustomField(locationId, label, key, 'NUMERICAL');
            const id = field?.id || field?._id || field?.fieldId;
            if (id) {
                db.customFields[locationId] = { ...db.customFields[locationId], [key]: id };
                saveDB(db);
                results.created.push(label);
            } else {
                console.warn(`[setup-custom-fields] no id in response for "${label}":`, JSON.stringify(field));
                results.alreadyExists.push(`${label} (no id returned)`);
            }
            return id;
        } catch (err) {
            const errData = err.response?.data;
            const errMsg  = JSON.stringify(errData || err.message);
            if (err.response?.status === 422 && errMsg.toLowerCase().includes('exist')) {
                // GHL says it exists but it wasn't in the list fetched a
                // moment ago (race, or list pagination) — refetch once and
                // resolve the real ID instead of leaving this field unset.
                try {
                    const refreshed = await fetchLocationCustomFields(locationId);
                    const match = refreshed.find(f => (f.name || '').trim().toLowerCase() === label.trim().toLowerCase());
                    const id = match?.id || match?._id;
                    if (id) {
                        db.customFields[locationId] = { ...db.customFields[locationId], [key]: id };
                        saveDB(db);
                        results.resolved.push(label);
                        return id;
                    }
                } catch (refetchErr) {
                    console.warn(`[setup-custom-fields] refetch after "already exists" failed for "${label}":`, refetchErr.message);
                }
                console.warn(`[setup-custom-fields] "${label}" already exists in GHL but its ID could not be resolved — CRM pushes will skip this field until setup is re-run successfully.`);
                results.alreadyExists.push(`${label} (id unresolved)`);
                return null;
            }
            console.error(`[setup-custom-fields] failed to create "${label}":`, errMsg);
            results.errors = results.errors || [];
            results.errors.push(`${label}: ${errData?.message || err.message}`);
            return null;
        }
    }

    await ensureField('Leads This Week',        'leads_this_week');
    await ensureField('Total Earned This Week', 'cash_this_week');
    await ensureField('Total Earned',           'total_earned');
    return results;
}

// ─── API: Setup custom fields ─────────────────────────────────────────────────
app.post('/api/setup-custom-fields/:locationId', async (req, res) => {
    const { locationId } = req.params;
    const db = loadDB();
    if (!db.installs[locationId] && !Object.values(db.installs).some(i => i.userType === 'Company' && i.refreshToken)) {
        return res.status(400).json({ success: false, error: 'No CRM token available. Complete OAuth first.' });
    }
    try {
        const results = await setupCustomFieldsForLocation(locationId);
        res.json({ success: true, ...results });
    } catch (err) {
        console.error('[setup-custom-fields] error:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.response?.data?.message || err.message });
    }
});

// ─── API: Sync subscriptions from GHL ────────────────────────────────────────
// Fetches all subscriptions + transactions for a location, matches affiliates,
// and populates db.trackedSubscriptions. Call this first to seed the tracker.
app.post('/api/sync-subscriptions/:locationId', async (req, res) => {
    const { locationId } = req.params;
    const db = loadDB();
    if (!db.installs[locationId] && !Object.values(db.installs).some(i => i.userType === 'Company' && i.refreshToken)) {
        return res.status(400).json({ success: false, error: 'No CRM token available. Complete OAuth first.' });
    }
    try {
        const results = await syncSubscriptionsFromGHL(locationId);
        res.json({ success: true, ...results });
    } catch (err) {
        console.error('[sync-subs] error:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.response?.data?.message || err.message });
    }
});

// ─── API: Debug a single subscription's affiliate match ──────────────────────
// Fetches the raw live subscription from GHL and re-runs the same matching
// logic used during sync, returning exactly which step matched (or why
// nothing matched) — for tracking down mismatches like a subscription
// resolving to the wrong affiliate, or not resolving at all.
app.get('/api/debug-subscription/:locationId/:ghlSubId', async (req, res) => {
    const { locationId, ghlSubId } = req.params;
    try {
        const db = loadDB();
        const sub = await fetchGHLSubscriptionById(locationId, ghlSubId);
        const [txnsResult, affResult] = await Promise.allSettled([
            fetchGHLTransactions(locationId),
            fetchGHLAffiliates(locationId)
        ]);
        const fetchWarnings = [];
        if (txnsResult.status === 'rejected') fetchWarnings.push(`transactions: ${txnsResult.reason.response?.data?.message || txnsResult.reason.message}`);
        if (affResult.status  === 'rejected') fetchWarnings.push(`affiliates: ${affResult.reason.response?.data?.message  || affResult.reason.message}`);
        const ghlTxns       = txnsResult.status === 'fulfilled' ? txnsResult.value : [];
        const ghlAffiliates = affResult.status  === 'fulfilled' ? affResult.value  : [];

        // Same scoping as the real sync — only this location's affiliates are candidates
        ghlAffiliates.forEach(a => { db.affiliates[a.id] = { ...db.affiliates[a.id], ...a, locationId }; });
        const affiliates = Object.values(db.affiliates).filter(a => a.locationId === locationId);

        const subStripeId = sub.subscriptionId || '';
        const relatedTxns = ghlTxns.filter(t => t.subscriptionId === subStripeId || t.subscriptionId === ghlSubId);

        const contactMap = db.contactAffiliateMap || {};
        const cachedMapping = contactMap[sub.contactId] || contactMap[sub.contactEmail] || null;

        const { affiliate, source } = matchAffiliate({ sub, affiliates, contactMap, relatedTxns });

        res.json({
            success: true,
            rawSubscription: sub,
            relatedTransactions: relatedTxns,
            scopedAffiliateCount: affiliates.length,
            scopedAffiliates: affiliates.map(a => ({ id: a.id, contactId: a.contactId || null, name: a.name, email: a.email, refId: a.refId })),
            cachedContactMapping: cachedMapping,
            payloadAffiliateManagerId: sub.entitySourceMeta?.affiliateManager?.id || null,
            matchResult: {
                matchedAffiliateId:   affiliate?.id   || null,
                matchedAffiliateName: affiliate?.name || null,
                matchedAffiliateContactId: affiliate?.contactId || null,
                source
            },
            earnings: affiliate ? {
                cashThisWeek: computeAffiliateCash(db, affiliate.id, 7),
                cashTotal:    computeAffiliateCash(db, affiliate.id, null)
            } : null,
            fetchWarnings: fetchWarnings.length ? fetchWarnings : undefined
        });
    } catch (err) {
        console.error('[debug-subscription] error:', err.response?.data || err.message);
        res.status(500).json({ success: false, error: err.response?.data?.message || err.message });
    }
});

// ─── API: Purge stale/demo data ───────────────────────────────────────────────
// Removes any affiliate record with no locationId (i.e. leftover seedDB demo
// data — the "Alex Rivera" / "John Doe" / "Jane Smith" records) so it can
// never again be matched against a real subscription. Optionally also clears
// contactAffiliateMap and trackedSubscriptions for a given locationId so the
// next sync rebuilds everything from scratch with clean, validated matches.
app.post('/api/admin/purge-stale-data', (req, res) => {
    const { locationId, resetTracking } = req.body || {};
    const db = loadDB();

    const beforeAffCount = Object.keys(db.affiliates || {}).length;
    const removedAffiliates = [];
    Object.entries(db.affiliates || {}).forEach(([id, a]) => {
        if (!a.locationId) {
            removedAffiliates.push({ id, name: a.name });
            delete db.affiliates[id];
        }
    });

    let removedMappings = 0;
    let removedTracked = 0;

    if (resetTracking && locationId) {
        Object.entries(db.contactAffiliateMap || {}).forEach(([contactKey, mapping]) => {
            if (mapping?.locationId === locationId || !mapping?.locationId) {
                delete db.contactAffiliateMap[contactKey];
                removedMappings++;
            }
        });
        Object.entries(db.trackedSubscriptions || {}).forEach(([subId, sub]) => {
            if (sub.locationId === locationId) {
                delete db.trackedSubscriptions[subId];
                removedTracked++;
            }
        });
    }

    saveDB(db);
    res.json({
        success: true,
        removedAffiliates,
        affiliatesBefore: beforeAffCount,
        affiliatesAfter: Object.keys(db.affiliates || {}).length,
        removedContactMappings: removedMappings,
        removedTrackedSubscriptions: removedTracked
    });
});

// ─── API: List tracked subscriptions ─────────────────────────────────────────
app.get('/api/tracked-subscriptions/:locationId', (req, res) => {
    const { locationId } = req.params;
    const db = loadDB();
    const subs = Object.values(db.trackedSubscriptions || {})
        .filter(s => s.locationId === locationId)
        .sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));
    res.json({ success: true, subscriptions: subs, total: subs.length });
});

// ─── API: Manually override billing interval for a subscription ───────────────
app.patch('/api/tracked-subscriptions/:ghlSubId', (req, res) => {
    const { ghlSubId } = req.params;
    const { billingInterval, affiliateId, affiliateName, isAffiliated } = req.body;
    const db = loadDB();
    const rec = db.trackedSubscriptions?.[ghlSubId];
    if (!rec) return res.status(404).json({ success: false, error: 'Subscription not found' });

    if (billingInterval) {
        rec.billingInterval = billingInterval;
        const newRenewal   = new Date(new Date(rec.renewalDate).getTime()).toISOString();
        rec.nextCheckDate  = calcNextCheckDate(newRenewal);
    }
    if (affiliateId   !== undefined) rec.affiliateId   = affiliateId;
    if (affiliateName !== undefined) rec.affiliateName = affiliateName;
    if (isAffiliated  !== undefined) rec.isAffiliated  = isAffiliated;
    if (isAffiliated) rec.stopped = false;  // re-enable if manually marked affiliated

    saveDB(db);
    res.json({ success: true, subscription: rec });
});

// ─── API: Manual trigger — run subscription renewal checks now ────────────────
app.post('/api/subscription-check/run', async (req, res) => {
    const { locationId } = req.query;
    try {
        const result = await runSubscriptionChecks(locationId || null);
        res.json({ success: true, ...result });
    } catch (err) {
        console.error('[sub-check] manual trigger error:', err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ─── API: Subscription check status + log ────────────────────────────────────
app.get('/api/subscription-check/status', (req, res) => {
    const { locationId } = req.query;
    const db = loadDB();

    const tracked = Object.values(db.trackedSubscriptions || {})
        .filter(s => !locationId || s.locationId === locationId)
        .map(s => ({
            ghlSubId:       s.ghlSubId,
            contactEmail:   s.contactEmail,
            contactName:    s.contactName,
            affiliateName:  s.affiliateName,
            isAffiliated:   s.isAffiliated,
            billingInterval: s.billingInterval,
            status:         s.status,
            isActive:       s.isActive,
            stopped:        s.stopped,
            renewalDate:    s.renewalDate,
            nextCheckDate:  s.nextCheckDate,
            lastChecked:    s.lastChecked,
            checkCount:     s.checkCount || 0,
            checkRetryCount: s.checkRetryCount || 0,
            lastCheckError: s.lastCheckError || null,
            amount:         s.amount,
            currency:       s.currency
        }));

    res.json({
        success: true,
        tracked,
        log: (db.subscriptionCheckLog || []).slice(0, 10)
    });
});

// ─── Legacy: Weekly check endpoint (kept for backward compat) ─────────────────
app.post('/api/weekly-check/run', async (req, res) => {
    try {
        const result = await runSubscriptionChecks(null);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/weekly-check/status', (req, res) => {
    res.redirect('/api/subscription-check/status');
});

// ─── Sync runner shared by the boot-time kickoff and the hourly cron tick ────
async function runFullSyncCycle(trigger) {
    console.log(`[${trigger}] Auto-refresh — syncing campaigns/products/affiliates/subscriptions for all locations`);
    try {
        await autoRefreshAllLocations();
    } catch (err) {
        console.error(`[${trigger}] Auto-refresh failed:`, err.message);
    }

    console.log(`[${trigger}] Subscription renewal check`);
    try {
        await runSubscriptionChecks(null);
    } catch (err) {
        console.error(`[${trigger}] Subscription check failed:`, err.message);
    }
}

// ─── Hourly cron: auto-refresh (full sync) + check due subscription renewals ──
cron.schedule('0 * * * *', () => runFullSyncCycle('cron'), { timezone: 'UTC' });

// ─── Boot-time sync: run once on startup so a fresh deploy/restart doesn't ───
// sit on stale data for up to 59 minutes waiting for the next hourly tick.
// Fired after the server starts listening (see app.listen below) rather than
// here, so it runs against a fully-initialized process.
let bootSyncStarted = false;
function runBootSyncOnce() {
    if (bootSyncStarted) return;
    bootSyncStarted = true;
    runFullSyncCycle('boot-sync').catch(err => {
        console.error('[boot-sync] unexpected failure:', err.message);
    });
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status:  'ok',
        version: 'CRM API v2 | Subscription Tracker v3 (auto-refresh + recurring rewards)',
        time:    new Date().toISOString(),
        callbackUrl: process.env.GHL_REDIRECT_URI || '(redirect URI not set)',
        ghlAppIdConfigured: !!process.env.GHL_APP_ID,
        dbStore: DB_PERSISTENT ? 'Upstash Redis' : `local file (${DB_FILE})`,
        dbPersistent: DB_PERSISTENT,
        warning: [
            process.env.GHL_APP_ID ? null : 'GHL_APP_ID is not set — Company/Agency-level installs will resolve 0 locations. Set it and use POST /api/admin/resolve-locations/:companyId to fix existing installs.',
            DB_PERSISTENT ? null : 'UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set — the token database lives on the default (ephemeral) local disk. On Render (or similar hosts), a spin-down/restart or redeploy will WIPE all stored OAuth tokens, forcing a full reinstall from the GHL Marketplace. Set up a free Upstash Redis database and set those two env vars to fix this permanently.'
        ].filter(Boolean).join(' | ') || undefined
    });
});

const PORT = process.env.PORT || 5000;
if (!process.env.GHL_APP_ID) {
    console.warn('[startup] WARNING: GHL_APP_ID is not set. Company/Agency-level OAuth installs will resolve 0 locations until this is configured (GET /oauth/installedLocations requires it).');
}
if (!DB_PERSISTENT) {
    console.warn(`[startup] WARNING: UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set — leaf_database.json (which holds every OAuth access/refresh token) lives at ${DB_FILE}, on the default disk. On Render, this disk is EPHEMERAL: a free-tier spin-down/spin-up or any redeploy wipes it, deleting every stored refresh token and forcing users to reinstall from the GHL Marketplace to reconnect. Fix: create a free Upstash Redis database (upstash.com) and set those two env vars — no further code changes needed beyond that.`);
}
if (!GHL_SHARED_SECRET) {
    console.warn('[startup] WARNING: GHL_SHARED_SECRET is not set. The frontend will not be able to resolve locationId via SSO for Marketplace Custom Pages (POST /sso/decrypt will return 500) — it will fall back to the (locationId-gated, empty-by-default) location picker instead.');
}

// Pull the DB down from Redis (or local file) before accepting any traffic,
// then run the one-time migration/seed steps against it.
initDB().then(() => {
    migrateDB();
    seedDB();
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`LEAF Server running on port ${PORT} | Subscription Tracker v2 | callback: ${process.env.GHL_REDIRECT_URI || '(not set)'} | DB store: ${DB_PERSISTENT ? 'Upstash Redis' : DB_FILE}`);
        runBootSyncOnce();
    });
}).catch(err => {
    console.error('[startup] initDB failed unexpectedly:', err.message);
    process.exit(1);
});
