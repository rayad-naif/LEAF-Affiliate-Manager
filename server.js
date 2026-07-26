const express  = require('express');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const cron     = require('node-cron');

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

// ─── CRM API constants ────────────────────────────────────────────────────────
const GHL_API_BASE         = 'https://services.leadconnectorhq.com';
const GHL_API_VER          = '2021-04-15';  // installedLocations
const GHL_API_VER_V3       = 'v3';          // affiliate-manager, payments, contacts
const GHL_API_VER_PRODUCTS = '2021-07-28';  // products
const GHL_TOKEN_URL        = `${GHL_API_BASE}/oauth/token`;
const GHL_LOC_TOKEN_URL    = `${GHL_API_BASE}/oauth/location-token`;
const GHL_INSTALLED_LOCS   = `${GHL_API_BASE}/oauth/installedLocations`;

function ghlHeaders(accessToken, version = GHL_API_VER) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Version':       version,
        'Content-Type':  'application/json'
    };
}

// ─── JSON file store ──────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'leaf_database.json');

function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
    }
    return {
        campaigns: {}, settings: {}, products: {}, affiliates: {}, transactions: {},
        installs: {}, customFields: {},
        // New: per-subscription tracking
        trackedSubscriptions: {},   // ghlSubId → tracked record
        contactAffiliateMap:  {},   // contactId → { affiliateId, affiliateName, locationId }
        subscriptionCheckLog: []    // last N check run summaries
    };
}

function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Migrate old DB on load — add missing top-level keys without losing existing data
function migrateDB() {
    const db = loadDB();
    let dirty = false;
    if (!db.trackedSubscriptions) { db.trackedSubscriptions = {}; dirty = true; }
    if (!db.contactAffiliateMap)  { db.contactAffiliateMap  = {}; dirty = true; }
    if (!db.subscriptionCheckLog) { db.subscriptionCheckLog = []; dirty = true; }
    if (dirty) saveDB(db);
}
migrateDB();

// Seed demo data on first run
(function seedDB() {
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
})();

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

// ─── GHL: Affiliate Manager — Campaigns ──────────────────────────────────────
async function fetchGHLCampaigns(locationId) {
    const token = await getOrCreateLocationToken(locationId);
    const res = await axios.get(`${GHL_API_BASE}/affiliate-manager/${locationId}/campaigns`, {
        headers: ghlHeaders(token, GHL_API_VER_V3),
        timeout: 10000
    });
    return (res.data.campaigns || []).map(c => ({
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

// ─── GHL: Products ────────────────────────────────────────────────────────────
async function fetchGHLProducts(locationId, retry = true) {
    const token = await getOrCreateLocationToken(locationId);
    const db = loadDB();
    try {
        const res = await axios.get(`${GHL_API_BASE}/products/`, {
            params:  { locationId },
            headers: ghlHeaders(token, GHL_API_VER_PRODUCTS),
            timeout: 10000
        });
        return (res.data.products || []).map(p => {
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
    } catch (err) {
        if (err.response?.status === 401 && retry) {
            await refreshCompanyToken(locationId);
            return fetchGHLProducts(locationId, false);
        }
        throw err;
    }
}

// ─── GHL: Affiliate Manager — Affiliates ─────────────────────────────────────
async function fetchGHLAffiliates(locationId) {
    const token = await getOrCreateLocationToken(locationId);
    const res = await axios.get(`${GHL_API_BASE}/affiliate-manager/${locationId}/affiliates`, {
        headers: ghlHeaders(token, GHL_API_VER_V3),
        timeout: 10000
    });
    return (res.data.affiliates || []).map(a => ({
        id:          a._id || a.id,
        name:        `${a.firstName || ''} ${a.lastName || ''}`.trim() || a.email || a._id,
        email:       a.email || '',
        refId:       a.referralCode || a._id,
        campaignIds: a.campaignIds  || [],
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

// ─── GHL: Payments — List Subscriptions ──────────────────────────────────────
// GET /payments/subscriptions?altId=locationId&altType=location  Version: v3
async function fetchGHLSubscriptions(locationId) {
    const token = await getOrCreateLocationToken(locationId);
    const allSubs = [];
    let offset = 0;
    const limit = 100;

    while (true) {
        const res = await axios.get(`${GHL_API_BASE}/payments/subscriptions`, {
            params:  { altId: locationId, altType: 'location', limit, offset },
            headers: ghlHeaders(token, GHL_API_VER_V3),
            timeout: 15000
        });
        const page = res.data?.data || [];
        allSubs.push(...page);
        if (page.length < limit) break;
        offset += limit;
    }

    console.log(`[subscriptions] fetched ${allSubs.length} subscription(s) for ${locationId}`);
    return allSubs;
}

// ─── GHL: Payments — Get Single Subscription ─────────────────────────────────
async function fetchGHLSubscriptionById(locationId, ghlSubId) {
    const token = await getOrCreateLocationToken(locationId);
    const res = await axios.get(`${GHL_API_BASE}/payments/subscriptions/${ghlSubId}`, {
        params:  { altId: locationId, altType: 'location' },
        headers: ghlHeaders(token, GHL_API_VER_V3),
        timeout: 10000
    });
    return res.data?.data || res.data;
}

// ─── GHL: Payments — List Transactions ───────────────────────────────────────
// GET /payments/transactions?altId=locationId&altType=location  Version: v3
async function fetchGHLTransactions(locationId) {
    const token = await getOrCreateLocationToken(locationId);
    const allTxns = [];
    let offset = 0;
    const limit = 100;

    while (true) {
        const res = await axios.get(`${GHL_API_BASE}/payments/transactions`, {
            params:  { altId: locationId, altType: 'location', limit, offset },
            headers: ghlHeaders(token, GHL_API_VER_V3),
            timeout: 15000
        });
        const page = res.data?.data || [];
        allTxns.push(...page);
        if (page.length < limit) break;
        offset += limit;
    }

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

// ─── Sync subscriptions from GHL and match to affiliates ─────────────────────
// This is the core of the new system.
// Steps:
//   1. Fetch all GHL subscriptions and transactions for the location
//   2. Build contactId → affiliate map from GHL transactions & affiliate manager
//   3. For each subscription:
//      - If the contact is in the affiliate map → track it
//      - Detect billing interval, compute next check date
//      - Store in db.trackedSubscriptions (idempotent — update if already exists)
//   4. Return a summary of what was found / newly tracked
async function syncSubscriptionsFromGHL(locationId) {
    const db = loadDB();
    if (!db.trackedSubscriptions) db.trackedSubscriptions = {};
    if (!db.contactAffiliateMap)  db.contactAffiliateMap  = {};

    // Step 1: fetch in parallel
    const [ghlSubs, ghlTxns, affiliates] = await Promise.all([
        fetchGHLSubscriptions(locationId),
        fetchGHLTransactions(locationId),
        fetchGHLAffiliates(locationId)
    ]);

    // Step 2: Build contactId → affiliate mapping
    // 2a. From GHL payment transactions — transactions that have a subscriptionId
    //     and whose contact matches an affiliate we know.
    //     We cross-reference by the contactId field on the transaction.
    //     GHL doesn't directly expose "this transaction came from affiliate X" in the
    //     payments API, BUT the affiliate manager tracks customers internally.
    //     We also use our own webhook records (contactAffiliateMap) built at purchase time.

    // 2b. From our webhook records (already in db.contactAffiliateMap) — keep those
    const contactMap = { ...db.contactAffiliateMap };

    // 2c. Also look at transactions fetched from GHL: if ANY of our affiliates' names
    //     appear in the transaction metadata / source, try to map it.
    //     Build a quick name→affiliate lookup
    const affiliateByName = {};
    const affiliateByEmail = {};
    affiliates.forEach(a => {
        if (a.name)  affiliateByName[a.name.toLowerCase()]  = a;
        if (a.email) affiliateByEmail[a.email.toLowerCase()] = a;
    });

    // Step 3: Group transactions by subscriptionId so we can find the
    // originating transaction for each subscription.
    const txnsBySubId = {};
    ghlTxns.forEach(t => {
        const sid = t.subscriptionId;
        if (!sid) return;
        if (!txnsBySubId[sid]) txnsBySubId[sid] = [];
        txnsBySubId[sid].push(t);
    });

    // Step 4: Process each subscription
    const results = { locationId, added: [], updated: [], skipped: [], rawCount: ghlSubs.length };

    for (const sub of ghlSubs) {
        const ghlSubId    = sub._id || sub.id;
        const subStripeId = sub.subscriptionId || '';  // e.g. sub_1KGcXDCScnf89tZoVkoEMCEL
        const contactId   = sub.contactId   || '';
        const contactEmail = sub.contactEmail || '';
        const status      = (typeof sub.status === 'object' ? sub.status?.status : sub.status) || 'unknown';

        // Identify affiliate for this subscription
        let affiliateEntry = contactMap[contactId] || (contactEmail && contactMap[contactEmail]) || null;

        // If not found via contact map, check if transactions for this sub mention an affiliate
        if (!affiliateEntry) {
            const relatedTxns = txnsBySubId[subStripeId] || txnsBySubId[ghlSubId] || [];
            for (const t of relatedTxns) {
                // Look for affiliate info in transaction source metadata
                const metaStr = JSON.stringify(t).toLowerCase();
                for (const [name, aff] of Object.entries(affiliateByName)) {
                    if (metaStr.includes(name)) {
                        affiliateEntry = { affiliateId: aff.id, affiliateName: aff.name, locationId };
                        // Remember for future
                        if (contactId) contactMap[contactId] = affiliateEntry;
                        break;
                    }
                }
                if (affiliateEntry) break;
            }
        }

        // Detect billing interval
        const billingInterval = detectBillingInterval(sub);
        const intervalMs      = intervalToMs(billingInterval);

        // Determine current period end / renewal date
        // GHL might have currentPeriodEnd, or we estimate from createdAt + interval
        const createdAt       = sub.createdAt || new Date().toISOString();
        const rawPeriodEnd    = sub.currentPeriodEnd || sub.nextBillingDate || null;
        const periodEndMs     = rawPeriodEnd
            ? new Date(rawPeriodEnd).getTime()
            : new Date(createdAt).getTime() + intervalMs;
        const renewalDate     = new Date(periodEndMs).toISOString();
        const nextCheckDate   = calcNextCheckDate(renewalDate);

        const existing = db.trackedSubscriptions[ghlSubId];

        // NEW: Grab the Product ID from the subscription and apply custom rules!
        const productId = sub.recurringProduct?.product?._id || sub.productId;
        
        if (!existing && affiliateEntry && productId) {
            const rule = db.products[productId];
            // If a rule exists and has a value, generate the initial transaction
            if (rule && rule.payoutValue > 0) {
                const txId = `tx_sync_${ghlSubId}`;
                db.transactions[txId] = {
                    id: txId, 
                    campaignId: rule.campaignId || affiliateEntry.campaignId || 'unknown',
                    contactId: contactId,
                    affiliateName: affiliateEntry.affiliateName,
                    productId: productId,
                    subscriptionId: ghlSubId,
                    type: rule.payoutType || 'CASH', // This applies 'LEAD' if configured!
                    amount: rule.payoutValue,
                    createdAt: sub.createdAt || new Date().toISOString()
                };
            }
        }

        // Always store the subscription (affiliated or not) so admin can see raw data.
        // Only active-status check is gated on affiliate association.

        // Always store the subscription (affiliated or not) so admin can see raw data.
        // Only active-status check is gated on affiliate association.
        const record = {
            ghlSubId,
            stripeSubId:     subStripeId,
            contactId,
            contactEmail,
            contactName:     sub.contactName || '',
            locationId,
            // Affiliate info (null if unaffiliated)
            affiliateId:     affiliateEntry?.affiliateId   || null,
            affiliateName:   affiliateEntry?.affiliateName || null,
            isAffiliated:    !!affiliateEntry,
            // Billing
            billingInterval,
            amount:          sub.amount   || 0,
            currency:        sub.currency || 'USD',
            // Status
            status,
            isActive:        status === 'active',
            // Period tracking
            startDate:       existing?.startDate || createdAt,
            renewalDate,
            nextCheckDate:   existing?.nextCheckDate || nextCheckDate,
            lastChecked:     existing?.lastChecked  || null,
            checkCount:      existing?.checkCount   || 0,
            stopped:         existing?.stopped      || false,
            // Raw snapshot for debugging — lets admin see all fields
            _raw:            { entityType: sub.entityType, entitySourceType: sub.entitySourceType,
                               entitySourceName: sub.entitySourceName, liveMode: sub.liveMode }
        };

        // Don't overwrite nextCheckDate if we already have a future one scheduled
        if (existing?.nextCheckDate && !existing?.stopped) {
            record.nextCheckDate = existing.nextCheckDate;
        }

        db.trackedSubscriptions[ghlSubId] = record;

        if (!existing) {
            results.added.push({ ghlSubId, contact: contactEmail || contactId, affiliated: record.isAffiliated, interval: billingInterval });
        } else {
            results.updated.push(ghlSubId);
        }
    }

    // Persist updated contact map
    db.contactAffiliateMap = contactMap;
    saveDB(db);

    console.log(`[sync-subs] ${locationId}: ${results.added.length} added, ${results.updated.length} updated, ${ghlSubs.length} total`);
    return results;
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
                result.action      = `renewed — next check: ${newNextCheck}`;
                console.log(`[sub-check] ${tracked.contactEmail} (${tracked.billingInterval}) → RENEWED, next check: ${newNextCheck}`);

                // ── Push updated stats to CRM contact custom fields ─────────
                const locationId     = tracked.locationId;
                const customFieldIds = db.customFields?.[locationId] || {};
                const affiliateRec   = Object.values(db.affiliates || {}).find(a => a.id === tracked.affiliateId);

                if (affiliateRec && (customFieldIds.leads_this_week || customFieldIds.total_earned)) {
                    try {
                        // Count active affiliated subscriptions as "leads" for this affiliate
                        const leadsCount = Object.values(db.trackedSubscriptions).filter(s =>
                            s.affiliateId === tracked.affiliateId && s.isActive && !s.stopped
                        ).length;

                        const contact = await searchContactByEmail(locationId, affiliateRec.email);
                        if (contact) {
                            const fields = [];
                            if (customFieldIds.leads_this_week)
                                fields.push({ id: customFieldIds.leads_this_week, fieldValue: String(leadsCount) });
                            if (customFieldIds.total_earned)
                                fields.push({ id: customFieldIds.total_earned, fieldValue: String(affiliateRec.totalCash || 0) });
                            if (fields.length) {
                                await updateContactCustomFields(locationId, contact.id || contact._id, fields);
                                result.crmUpdated = true;
                            }
                        }
                    } catch (crmErr) {
                        result.crmError = crmErr.message;
                        console.warn(`[sub-check] CRM update failed for ${affiliateRec?.email}:`, crmErr.message);
                    }
                }
            }

        } catch (err) {
            result.error = err.response?.data?.message || err.message;
            console.error(`[sub-check] Error checking ${tracked.ghlSubId}:`, result.error);
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

    try {
        const [campaigns, affiliates, products] = await Promise.all([
            fetchGHLCampaigns(locationId),
            fetchGHLAffiliates(locationId),
            fetchGHLProducts(locationId)
        ]);

        campaigns.forEach(c  => { db.campaigns[c.id]  = c; });
        affiliates.forEach(a => { db.affiliates[a.id] = { ...db.affiliates[a.id], ...a }; });
        products.forEach(p   => { db.products[p.id]   = p; });
        saveDB(db);

        console.log(`[campaigns] synced for ${locationId}: ${campaigns.length} campaigns, ${affiliates.length} affiliates, ${products.length} products`);
        return res.json({ success: true, campaigns, source: 'crm' });
    } catch (err) {
        console.error('[campaigns] GHL fetch failed:', err.response?.data || err.message);
        const campaigns = Object.values(db.campaigns).filter(c => c.locationId === locationId);
        return res.json({ success: true, campaigns, source: 'local', warning: err.message });
    }
});

// ─── API: Dashboard data for a campaign ──────────────────────────────────────
app.get('/api/dashboard/:campaignId', async (req, res) => {
    const { campaignId } = req.params;
    const { locationId } = req.query;
    const db = loadDB();

    if (locationId) {
        try {
            const [affiliates, products] = await Promise.all([
                fetchGHLAffiliates(locationId),
                fetchGHLProducts(locationId)
            ]);
            affiliates.forEach(a => { db.affiliates[a.id] = { ...db.affiliates[a.id], ...a }; });
            products.forEach(p => { db.products[p.id] = p; });
            saveDB(db);
        } catch (err) {
            console.warn(`[dashboard] GHL sync failed for ${locationId}:`, err.response?.data || err.message);
        }
    }

    const campaign   = db.campaigns[campaignId];
    const affiliates = Object.values(db.affiliates).filter(a =>
        (Array.isArray(a.campaignIds) && a.campaignIds.includes(campaignId)) ||
        a.campaignId === campaignId
    );

    const products = Object.values(db.products).filter(p =>
        p.locationId === locationId ||
        p.campaignId === campaignId ||
        (!p.campaignId && p.locationId === (campaign?.locationId || locationId))
    );

    const allCampaignTxns = Object.values(db.transactions)
        .filter(t => t.campaignId === campaignId);

    // OVERRIDE native GHL stats with your custom Product Rules
    affiliates.forEach(aff => {
        const affTxns = allCampaignTxns.filter(t => t.affiliateName?.toLowerCase() === aff.name?.toLowerCase());
        
        // Sum up CASH rules and LEAD rules separately
        aff.totalCash  = affTxns.filter(t => t.type === 'CASH').reduce((sum, t) => sum + Number(t.amount || 0), 0);
        aff.totalLeads = affTxns.filter(t => t.type === 'LEAD').reduce((sum, t) => sum + Number(t.amount || 0), 0);
        aff.customer   = affTxns.length; // Total transaction count
    });

    const recentTransactions = allCampaignTxns
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .slice(0, 50);

    res.json({ success: true, affiliates, transactions: recentTransactions, products, campaign: campaign || null });
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
        db.products[productId]   = { id: productId, campaignId, name: productName, payoutType, payoutValue };

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

    db.transactions[txId] = {
        id: txId, campaignId, contactId,
        affiliateName: affiliateName || 'Unknown',
        productId:     productId     || 'unknown',
        subscriptionId: subscriptionId || null,
        type: 'CASH', amount: amount || 0,
        createdAt: new Date().toISOString()
    };

    // Record contactId → affiliate mapping so subscription sync can use it
    if (affiliateName && affiliateName !== 'Unknown' && contactId) {
        if (!db.contactAffiliateMap) db.contactAffiliateMap = {};
        // Find affiliate by name in our store
        const aff = Object.values(db.affiliates || {}).find(
            a => a.name?.toLowerCase() === affiliateName.toLowerCase()
        );
        db.contactAffiliateMap[contactId] = {
            affiliateId:   aff?.id   || null,
            affiliateName: affiliateName,
            locationId:    aff?.locationId || null
        };
    }

    saveDB(db);
    res.json({ success: true, transactionId: txId });
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
            approvedLocations = []
        } = tokenRes.data;

        const db = loadDB();
        const installedLocations = [];

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
                    const ilRes = await axios.get(GHL_INSTALLED_LOCS, {
                        params:  { companyId, appId: process.env.GHL_APP_ID, isInstalled: true, limit: 100 },
                        headers: { 'Authorization': `Bearer ${access_token}`, 'Version': GHL_API_VER, 'Accept': 'application/json' },
                        timeout: 10000
                    });
                    const rawLocs = ilRes.data?.locations || ilRes.data?.installedLocations || [];
                    locIds = rawLocs.map(l => l.locationId || l._id || l.id).filter(Boolean);
                    console.log(`[oauth] installedLocations returned ${locIds.length} location(s):`, locIds);
                } catch (ilErr) {
                    console.error('[oauth] installedLocations fetch failed:', ilErr.response?.data || ilErr.message);
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
    ${primaryLocId ? `<a href="/?locationId=${primaryLocId}" class="inline-block bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-3 rounded-xl transition-colors">Open Dashboard →</a>` : `<p class="text-gray-400 text-sm">No locations resolved.</p>`}
  </div>
</body></html>`);

    } catch (err) {
        console.error('[oauth] error:', err.response?.data || err.message);
        return res.status(500).send(`<h2>OAuth Failed</h2><pre>${err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message}</pre>`);
    }
});

// ─── API: List installed locations ────────────────────────────────────────────
app.get('/api/locations', (req, res) => {
    const db = loadDB();
    const locations = Object.values(db.installs)
        .filter(i => i.locationId && !i.locationId.startsWith('company_'))
        .map(i => ({ locationId: i.locationId, companyId: i.companyId || null, userId: i.userId || null, installedAt: i.installedAt || null }));
    return res.json({ success: true, locations });
});

// ─── CRM: Search contact by email ────────────────────────────────────────────
async function searchContactByEmail(locationId, email) {
    const token = await getOrCreateLocationToken(locationId);
    const res = await axios.get(`${GHL_API_BASE}/contacts/search`, {
        params:  { locationId, query: email, limit: 1 },
        headers: ghlHeaders(token, GHL_API_VER_PRODUCTS),
        timeout: 10000
    });
    const contacts = res.data?.contacts || res.data?.data || [];
    return contacts[0] || null;
}

// ─── CRM: Update a contact's custom fields ────────────────────────────────────
async function updateContactCustomFields(locationId, contactId, fields) {
    // fields: [{ id, key, fieldValue }]  — Version: v3
    const token = await getOrCreateLocationToken(locationId);
    await axios.put(`${GHL_API_BASE}/contacts/${contactId}`, {
        customFields: fields
    }, {
        headers: ghlHeaders(token, GHL_API_VER_V3),
        timeout: 10000
    });
}

// ─── CRM: Create a custom field for a location ───────────────────────────────
// Endpoint: POST /locations/:locationId/customFields  Version: v3
async function createCustomField(locationId, name, fieldKey, dataType = 'NUMERICAL') {
    const token = await getOrCreateLocationToken(locationId);
    const res = await axios.post(`${GHL_API_BASE}/locations/${locationId}/customFields`, {
        name, dataType, placeholder: '0', model: 'contact'
    }, {
        headers: ghlHeaders(token, GHL_API_VER_V3),
        timeout: 10000
    });
    return res.data?.customField || res.data;
}

// ─── CRM: Ensure custom fields exist for a location ──────────────────────────
async function setupCustomFieldsForLocation(locationId) {
    const db = loadDB();
    if (!db.customFields) db.customFields = {};
    const existing = db.customFields[locationId] || {};
    const results  = { locationId, created: [], alreadyExists: [] };

    async function ensureField(label, key) {
        if (existing[key]) {
            results.alreadyExists.push(label);
            return existing[key];
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
                results.alreadyExists.push(label);
                return null;
            }
            console.error(`[setup-custom-fields] failed to create "${label}":`, errMsg);
            results.errors = results.errors || [];
            results.errors.push(`${label}: ${errData?.message || err.message}`);
            return null;
        }
    }

    await ensureField('Leads This Week', 'leads_this_week');
    await ensureField('Total Earned',    'total_earned');
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

// ─── Hourly cron: check due subscription renewals ─────────────────────────────
cron.schedule('0 * * * *', async () => {
    console.log('[cron] Hourly subscription renewal check');
    try {
        await runSubscriptionChecks(null);
    } catch (err) {
        console.error('[cron] Subscription check failed:', err.message);
    }
}, { timezone: 'UTC' });

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status:  'ok',
        version: 'CRM API v2 | Subscription Tracker v2',
        time:    new Date().toISOString(),
        callbackUrl: process.env.GHL_REDIRECT_URI || '(redirect URI not set)'
    });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`LEAF Server running on port ${PORT} | Subscription Tracker v2 | callback: ${process.env.GHL_REDIRECT_URI || '(not set)'}`));
