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

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function ghlHeaders(accessToken, version = GHL_API_VER) {
    return {
        'Authorization': `Bearer ${accessToken}`,
        'Version':       version,
        'Content-Type':  'application/json'
    };
}

// Universal API Caller with auto-refresh and rate limit handling
async function ghlApiRequest(method, endpoint, locationId, version, options = {}, retry = true) {
    const token = await getOrCreateLocationToken(locationId);
    try {
        const res = await axios({
            method,
            url: `${GHL_API_BASE}${endpoint}`,
            headers: ghlHeaders(token, version),
            ...options
        });
        return res.data;
    } catch (err) {
        if (err.response?.status === 401 && retry) {
            console.warn(`[API] 401 Unauthorized on ${endpoint}. Refreshing token...`);
            const db = loadDB();
            if (db.installs[locationId]) {
                db.installs[locationId].accessToken = null;
                saveDB(db);
            }
            return ghlApiRequest(method, endpoint, locationId, version, options, false);
        }
        if (err.response?.status === 429) {
            console.warn(`[API] 429 Rate Limit hit on ${endpoint}. Backing off...`);
            await delay(2000); 
            if (retry) return ghlApiRequest(method, endpoint, locationId, version, options, false);
        }
        throw err;
    }
}

// ─── JSON file store ──────────────────────────────────────────────────────────
const DB_FILE = path.join(__dirname, 'leaf_database.json');

function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
    }
    return {
        campaigns: {}, settings: {}, products: {}, affiliates: {}, transactions: {},
        installs: {}, customFields: {}, trackedSubscriptions: {}, contactAffiliateMap:  {}, subscriptionCheckLog: []
    };
}

function saveDB(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function migrateDB() {
    const db = loadDB();
    let dirty = false;
    if (!db.trackedSubscriptions) { db.trackedSubscriptions = {}; dirty = true; }
    if (!db.contactAffiliateMap)  { db.contactAffiliateMap  = {}; dirty = true; }
    if (!db.subscriptionCheckLog) { db.subscriptionCheckLog = []; dirty = true; }
    if (dirty) saveDB(db);
}
migrateDB();

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
        companyToken = await refreshCompanyToken(companyId);
    }

    try {
        return await exchangeLocationToken(companyToken, companyId, locationId);
    } catch (err) {
        if (err.response?.status === 401) {
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

// ─── GHL: Core Fetch Functions ───────────────────────────────────────────────
async function fetchGHLCampaigns(locationId) {
    const data = await ghlApiRequest('GET', `/affiliate-manager/${locationId}/campaigns`, locationId, GHL_API_VER_V3, { timeout: 10000 });
    return (data.campaigns || []).map(c => ({
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

async function fetchGHLProducts(locationId) {
    const db = loadDB();
    const data = await ghlApiRequest('GET', `/products/`, locationId, GHL_API_VER_PRODUCTS, { params: { locationId }, timeout: 10000 });
    return (data.products || []).map(p => {
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

async function fetchGHLAffiliates(locationId) {
    const data = await ghlApiRequest('GET', `/affiliate-manager/${locationId}/affiliates`, locationId, GHL_API_VER_V3, { timeout: 10000 });
    return (data.affiliates || []).map(a => ({
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

async function fetchGHLSubscriptions(locationId) {
    const allSubs = [];
    let offset = 0;
    const limit = 100;
    while (true) {
        const data = await ghlApiRequest('GET', `/payments/subscriptions`, locationId, GHL_API_VER_V3, {
            params: { altId: locationId, altType: 'location', limit, offset }, timeout: 15000
        });
        const page = data.data || [];
        allSubs.push(...page);
        if (page.length < limit) break;
        offset += limit;
        await delay(500);
    }
    return allSubs;
}

async function fetchGHLSubscriptionById(locationId, ghlSubId) {
    const data = await ghlApiRequest('GET', `/payments/subscriptions/${ghlSubId}`, locationId, GHL_API_VER_V3, {
        params: { altId: locationId, altType: 'location' }, timeout: 10000
    });
    return data.data || data;
}

// ─── Billing interval helpers ─────────────────────────────────────────────────
function detectBillingInterval(sub) {
    const direct = (sub.interval || sub.billingInterval || '').toLowerCase();
    if (direct.includes('year'))  return 'yearly';
    if (direct.includes('week'))  return 'weekly';
    if (direct.includes('month')) return 'monthly';
    const snapshots = [sub.chargeSnapshot, sub.subscriptionSnapshot, sub.entitySourceMeta]
        .map(s => (typeof s === 'string' ? s : JSON.stringify(s || ''))).join(' ').toLowerCase();
    if (snapshots.includes('"interval":"year')  || snapshots.includes('"interval": "year'))  return 'yearly';
    if (snapshots.includes('"interval":"week')  || snapshots.includes('"interval": "week'))  return 'weekly';
    if (snapshots.includes('"interval":"month') || snapshots.includes('"interval": "month')) return 'monthly';
    return 'monthly';
}

function intervalToMs(interval) {
    switch (interval) {
        case 'yearly':  return 365 * 24 * 60 * 60 * 1000;
        case 'weekly':  return   7 * 24 * 60 * 60 * 1000;
        default:        return  30 * 24 * 60 * 60 * 1000;
    }
}

function calcNextCheckDate(renewalDate) {
    return new Date(new Date(renewalDate).getTime() + 2 * 24 * 60 * 60 * 1000).toISOString();
}

// ─── Sync subscriptions & Generate Transactions ──────────────────────────────
async function syncSubscriptionsFromGHL(locationId) {
    const db = loadDB();
    if (!db.trackedSubscriptions) db.trackedSubscriptions = {};
    if (!db.contactAffiliateMap)  db.contactAffiliateMap  = {};

    const [ghlSubs, affiliates] = await Promise.all([
        fetchGHLSubscriptions(locationId),
        fetchGHLAffiliates(locationId)
    ]);

    const contactMap = { ...db.contactAffiliateMap };
    const results = { locationId, added: [], updated: [], skipped: [], rawCount: ghlSubs.length };

    for (const sub of ghlSubs) {
        const ghlSubId    = sub._id || sub.id;
        const subStripeId = sub.subscriptionId || ''; 
        const contactId   = sub.contactId   || '';
        const contactEmail = sub.contactEmail || '';
        const status      = (typeof sub.status === 'object' ? sub.status?.status : sub.status) || 'unknown';

        const productId = sub.recurringProduct?.product?._id || sub.productId;
        const payloadAffId = sub.entitySourceMeta?.affiliateManager?.id || '';
        
        let affiliateRec = null;

        // 1. Exact Match
        if (payloadAffId) {
            affiliateRec = Object.values(db.affiliates).find(a => a.id === payloadAffId || a.refId === payloadAffId);
        }

        // 2. Fuzzy Match (Strip special characters, numbers, and spaces)
        if (!affiliateRec && payloadAffId) {
            const cleanPayload = payloadAffId.replace(/[^a-zA-Z]/g, '').toLowerCase(); // e.g. "examplealex"
            if (cleanPayload.length >= 3) {
                affiliateRec = Object.values(db.affiliates).find(a => {
                    const cleanName = (a.name || '').replace(/[^a-zA-Z]/g, '').toLowerCase(); // e.g. "examplealexdoecarter"
                    const cleanEmail = (a.email || '').split('@')[0].replace(/[^a-zA-Z]/g, '').toLowerCase();
                    return (cleanName && (cleanName.includes(cleanPayload) || cleanPayload.includes(cleanName))) ||
                           (cleanEmail && (cleanEmail.includes(cleanPayload) || cleanPayload.includes(cleanEmail)));
                });
            }
        }

        // 3. Contact Fallback Map
        if (!affiliateRec) {
            let affiliateEntry = contactMap[contactId] || (contactEmail && contactMap[contactEmail]) || null;
            if (affiliateEntry) affiliateRec = Object.values(db.affiliates).find(a => a.id === affiliateEntry.affiliateId);
        }

        // Remember the contact mapping for the future
        if (affiliateRec && contactId) {
            contactMap[contactId] = { affiliateId: affiliateRec.id, affiliateName: affiliateRec.name, locationId };
        }

        // FORCE GENERATE MISSING INITIAL TRANSACTION
        const txId = `tx_sync_${ghlSubId}`;
        const existingTx = db.transactions[txId];
        
        if (!existingTx && productId) {
            const rule = db.products[productId];
            
            // If we matched an affiliate OR there is a custom rule to apply
            if (rule && rule.payoutValue > 0) {
                db.transactions[txId] = {
                    id: txId, 
                    campaignId: rule.campaignId || affiliateRec?.campaignId || 'unknown',
                    contactId: contactId,
                    affiliateId: affiliateRec?.id || payloadAffId || null,
                    affiliateName: affiliateRec?.name || payloadAffId || 'Unknown Affiliate',
                    productId: productId,
                    subscriptionId: ghlSubId,
                    type: rule.payoutType || 'CASH',
                    amount: rule.payoutValue,
                    createdAt: sub.createdAt || new Date().toISOString()
                };
            }
        }

        const billingInterval = detectBillingInterval(sub);
        const intervalMs      = intervalToMs(billingInterval);
        const createdAt       = sub.createdAt || new Date().toISOString();
        const rawPeriodEnd    = sub.currentPeriodEnd || sub.nextBillingDate || null;
        const periodEndMs     = rawPeriodEnd ? new Date(rawPeriodEnd).getTime() : new Date(createdAt).getTime() + intervalMs;
        const renewalDate     = new Date(periodEndMs).toISOString();
        const nextCheckDate   = calcNextCheckDate(renewalDate);

        const existing = db.trackedSubscriptions[ghlSubId];

        const record = {
            ghlSubId, stripeSubId: subStripeId, contactId, contactEmail, contactName: sub.contactName || '', locationId,
            affiliateId: affiliateRec?.id || payloadAffId || null,
            affiliateName: affiliateRec?.name || payloadAffId || null,
            isAffiliated: !!affiliateRec || !!payloadAffId,
            billingInterval, amount: sub.amount || 0, currency: sub.currency || 'USD', status, isActive: status === 'active',
            startDate: existing?.startDate || createdAt, renewalDate, 
            nextCheckDate: existing?.nextCheckDate || nextCheckDate,
            lastChecked: existing?.lastChecked || null, checkCount: existing?.checkCount || 0, stopped: existing?.stopped || false
        };

        if (existing?.nextCheckDate && !existing?.stopped) record.nextCheckDate = existing.nextCheckDate;

        db.trackedSubscriptions[ghlSubId] = record;
        if (!existing) results.added.push({ ghlSubId, contact: contactEmail || contactId, affiliated: record.isAffiliated });
        else results.updated.push(ghlSubId);
    }

    db.contactAffiliateMap = contactMap;
    saveDB(db);
    return results;
}

// ─── Per-subscription renewal check ──────────────────────────────────────────
async function runSubscriptionChecks(locationIdFilter) {
    const db  = loadDB();
    const now = Date.now();
    const runAt = new Date().toISOString();

    const due = Object.values(db.trackedSubscriptions || {}).filter(s => {
        if (s.stopped)       return false;
        if (!s.isAffiliated) return false; 
        if (locationIdFilter && s.locationId !== locationIdFilter) return false;
        return s.nextCheckDate && new Date(s.nextCheckDate).getTime() <= now;
    });

    if (due.length === 0) return { runAt, summary: [], dueCount: 0 };

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
            const live = await fetchGHLSubscriptionById(tracked.locationId, tracked.ghlSubId);
            const liveStatus = (typeof live?.status === 'object' ? live.status?.status : live?.status) || 'unknown';
            const isActive   = liveStatus === 'active';

            const rec = db.trackedSubscriptions[tracked.ghlSubId];

            if (!isActive) {
                rec.isActive   = false;
                rec.status     = liveStatus;
                rec.stopped    = true;
                rec.lastChecked = runAt;
                rec.checkCount  = (rec.checkCount || 0) + 1;
                result.action   = `stopped — status: ${liveStatus}`;
            } else {
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

                const customFieldIds = db.customFields?.[tracked.locationId] || {};
                const affiliateRec   = Object.values(db.affiliates || {}).find(a => a.id === tracked.affiliateId);

                if (affiliateRec && (customFieldIds.leads_this_week || customFieldIds.total_earned)) {
                    try {
                        const leadsCount = Object.values(db.trackedSubscriptions).filter(s => s.affiliateId === tracked.affiliateId && s.isActive && !s.stopped).length;
                        const contact = await searchContactByEmail(tracked.locationId, affiliateRec.email);
                        if (contact) {
                            const fields = [];
                            if (customFieldIds.leads_this_week) fields.push({ id: customFieldIds.leads_this_week, fieldValue: String(leadsCount) });
                            if (customFieldIds.total_earned) fields.push({ id: customFieldIds.total_earned, fieldValue: String(affiliateRec.totalCash || 0) });
                            if (fields.length) {
                                await updateContactCustomFields(tracked.locationId, contact.id || contact._id, fields);
                                result.crmUpdated = true;
                            }
                        }
                    } catch (crmErr) {
                        result.crmError = crmErr.message;
                    }
                }
            }
        } catch (err) {
            result.error = err.response?.data?.message || err.message;
        }
        summary.push(result);
    }

    if (!db.subscriptionCheckLog) db.subscriptionCheckLog = [];
    db.subscriptionCheckLog.unshift({ runAt, summary });
    if (db.subscriptionCheckLog.length > 20) db.subscriptionCheckLog.length = 20;
    saveDB(db);
    return { runAt, summary, dueCount: due.length };
}

// ─── API Routes ──────────────────────────────────────────────────────────────
app.get('/api/campaigns/:locationId', async (req, res) => {
    const { locationId } = req.params;
    const db = loadDB();
    const hasCompanyToken = Object.values(db.installs).some(i => i.userType === 'Company' && i.refreshToken);
    if (!db.installs[locationId] && !hasCompanyToken) {
        return res.json({ success: true, campaigns: Object.values(db.campaigns).filter(c => c.locationId === locationId), source: 'local' });
    }
    try {
        const [campaigns, affiliates, products] = await Promise.all([ fetchGHLCampaigns(locationId), fetchGHLAffiliates(locationId), fetchGHLProducts(locationId) ]);
        campaigns.forEach(c  => { db.campaigns[c.id]  = c; });
        affiliates.forEach(a => { db.affiliates[a.id] = { ...db.affiliates[a.id], ...a }; });
        products.forEach(p   => { db.products[p.id]   = p; });
        saveDB(db);
        return res.json({ success: true, campaigns, source: 'crm' });
    } catch (err) {
        return res.json({ success: true, campaigns: Object.values(db.campaigns).filter(c => c.locationId === locationId), source: 'local', warning: err.message });
    }
});

app.get('/api/dashboard/:campaignId', async (req, res) => {
    const { campaignId } = req.params;
    const { locationId } = req.query;
    const db = loadDB();

    if (locationId) {
        try {
            const [affiliates, products] = await Promise.all([fetchGHLAffiliates(locationId), fetchGHLProducts(locationId)]);
            affiliates.forEach(a => { db.affiliates[a.id] = { ...db.affiliates[a.id], ...a }; });
            products.forEach(p => { db.products[p.id] = p; });
            saveDB(db);
        } catch (err) { }
    }

    const campaign   = db.campaigns[campaignId];
    const affiliates = Object.values(db.affiliates).filter(a => (Array.isArray(a.campaignIds) && a.campaignIds.includes(campaignId)) || a.campaignId === campaignId );
    const products = Object.values(db.products).filter(p => p.locationId === locationId || p.campaignId === campaignId || (!p.campaignId && p.locationId === (campaign?.locationId || locationId)) );

    const allCampaignTxns = Object.values(db.transactions).filter(t => t.campaignId === campaignId);

    // FUZZY DASHBOARD MATCHING OVERRIDE
    affiliates.forEach(aff => {
        const cleanAffName = (aff.name || '').replace(/[^a-zA-Z]/g, '').toLowerCase();
        const cleanAffEmail = (aff.email || '').split('@')[0].replace(/[^a-zA-Z]/g, '').toLowerCase();

        const affTxns = allCampaignTxns.filter(t => {
            // 1. Strict ID Match
            if (t.affiliateId && t.affiliateId === aff.id) return true;
            
            // 2. Fuzzy Name/Email Match
            const rawTxName = t.affiliateName || t.affiliateId || '';
            const cleanTxName = rawTxName.replace(/[^a-zA-Z]/g, '').toLowerCase();
            
            if (cleanTxName.length >= 3 && cleanAffName.length >= 3) {
                if (cleanAffName.includes(cleanTxName) || cleanTxName.includes(cleanAffName)) return true;
            }
            if (cleanTxName.length >= 3 && cleanAffEmail.length >= 3) {
                if (cleanAffEmail.includes(cleanTxName) || cleanTxName.includes(cleanAffEmail)) return true;
            }
            return false;
        });
        
        aff.totalCash  = affTxns.filter(t => t.type === 'CASH').reduce((sum, t) => sum + Number(t.amount || 0), 0);
        aff.totalLeads = affTxns.filter(t => t.type === 'LEAD').reduce((sum, t) => sum + Number(t.amount || 0), 0);
        aff.customer   = affTxns.length > 0 ? affTxns.length : (aff.customer || 0);
    });

    const recentTransactions = allCampaignTxns.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 50);
    res.json({ success: true, affiliates, transactions: recentTransactions, products, campaign: campaign || null });
});

app.post('/api/settings', (req, res) => {
    const { locationId, campaignId, campaignName, productId, productName, payoutType, payoutValue, sheetId } = req.body;
    const db = loadDB();
    if (campaignId && campaignName) db.campaigns[campaignId] = { ...db.campaigns[campaignId], id: campaignId, locationId, name: campaignName };
    if (locationId && sheetId) db.settings[locationId]  = { locationId, sheetId };
    if (productId && campaignId) db.products[productId]   = { id: productId, campaignId, name: productName, payoutType, payoutValue };
    saveDB(db);
    res.json({ success: true });
});

app.post('/webhook/purchase', (req, res) => {
    const { campaignId, contactId, productId, amount, affiliateName, subscriptionId } = req.body;
    if (!campaignId || !contactId) return res.status(400).json({ error: 'Missing required fields: campaignId, contactId' });
    const db  = loadDB();
    const txId = `trans_${Date.now()}`;
    db.transactions[txId] = {
        id: txId, campaignId, contactId, affiliateName: affiliateName || 'Unknown', productId: productId || 'unknown',
        subscriptionId: subscriptionId || null, type: 'CASH', amount: amount || 0, createdAt: new Date().toISOString()
    };
    if (affiliateName && affiliateName !== 'Unknown' && contactId) {
        if (!db.contactAffiliateMap) db.contactAffiliateMap = {};
        const aff = Object.values(db.affiliates || {}).find(a => a.name?.toLowerCase() === affiliateName.toLowerCase());
        db.contactAffiliateMap[contactId] = { affiliateId: aff?.id || null, affiliateName: affiliateName, locationId: aff?.locationId || null };
    }
    saveDB(db);
    res.json({ success: true, transactionId: txId });
});

app.get('/oauth/callback/lc', async (req, res) => {
    const { code, error, error_description } = req.query;
    if (error) return res.status(400).send(`<h2>OAuth Error</h2><p><strong>${error}</strong>: ${error_description || 'Unknown error'}</p>`);
    if (!code) return res.status(400).send('<h2>Missing authorization code.</h2>');
    try {
        const tokenParams = new URLSearchParams({ client_id: process.env.GHL_CLIENT_ID, client_secret: process.env.GHL_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.GHL_REDIRECT_URI });
        const tokenRes = await axios.post(GHL_TOKEN_URL, tokenParams.toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const { access_token, refresh_token, token_type, expires_in, scope, userType, locationId: directLocationId, companyId, userId, approvedLocations = [] } = tokenRes.data;
        const db = loadDB();
        const installedLocations = [];

        if (userType === 'Location' && directLocationId) {
            db.installs[directLocationId] = { locationId: directLocationId, accessToken: access_token, refreshToken: refresh_token, tokenType: token_type, expiresIn: expires_in, scope, userId, companyId, userType, installedAt: new Date().toISOString() };
            installedLocations.push(directLocationId);
        } else if (userType === 'Company') {
            db.installs[`company_${companyId}`] = { companyId, accessToken: access_token, refreshToken: refresh_token, tokenType: token_type, expiresIn: expires_in, scope, userId, userType, installedAt: new Date().toISOString() };
            saveDB(db);
            let locIds = approvedLocations.length > 0 ? [...approvedLocations] : [];
            if (locIds.length === 0) {
                try {
                    const ilRes = await axios.get(GHL_INSTALLED_LOCS, { params: { companyId, appId: process.env.GHL_APP_ID, isInstalled: true, limit: 100 }, headers: { 'Authorization': `Bearer ${access_token}`, 'Version': GHL_API_VER, 'Accept': 'application/json' }, timeout: 10000 });
                    const rawLocs = ilRes.data?.locations || ilRes.data?.installedLocations || [];
                    locIds = rawLocs.map(l => l.locationId || l._id || l.id).filter(Boolean);
                } catch (ilErr) { }
            }
            for (const locId of locIds) {
                try {
                    const locData = await getLocationToken(access_token, companyId, locId);
                    db.installs[locId] = { locationId: locId, accessToken: locData.accessToken, refreshToken: locData.refreshToken || refresh_token, tokenType: locData.tokenType || 'Bearer', expiresIn: locData.expiresIn, scope: locData.scope || scope, userId: locData.userId || userId, companyId, userType: 'Location', installedAt: new Date().toISOString() };
                    installedLocations.push(locId);
                } catch (locErr) { }
            }
        }

        for (const locId of installedLocations) {
            try { const campaigns = await fetchGHLCampaigns(locId); campaigns.forEach(c => { db.campaigns[c.id] = c; }); } catch (e) { }
        }
        saveDB(db);
        const primaryLocId = installedLocations[0] || '';
        return res.send(`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>LEAF Installed</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-50 flex items-center justify-center min-h-screen font-sans"><div class="bg-white rounded-2xl shadow-lg p-10 max-w-lg w-full text-center"><h1 class="text-2xl font-bold text-gray-900 mb-2">LEAF Installed!</h1><p class="text-gray-500 mb-6">Successfully connected to your CRM account.</p>${primaryLocId ? `<a href="/?locationId=${primaryLocId}" class="inline-block bg-blue-600 hover:bg-blue-700 text-white font-semibold px-6 py-3 rounded-xl transition-colors">Open Dashboard →</a>` : ''}</div></body></html>`);
    } catch (err) {
        return res.status(500).send(`<h2>OAuth Failed</h2><pre>${err.response?.data ? JSON.stringify(err.response.data, null, 2) : err.message}</pre>`);
    }
});

app.get('/api/locations', (req, res) => {
    const db = loadDB();
    const locations = Object.values(db.installs).filter(i => i.locationId && !i.locationId.startsWith('company_')).map(i => ({ locationId: i.locationId, companyId: i.companyId || null, userId: i.userId || null, installedAt: i.installedAt || null }));
    return res.json({ success: true, locations });
});

async function searchContactByEmail(locationId, email) {
    const token = await getOrCreateLocationToken(locationId);
    const res = await axios.get(`${GHL_API_BASE}/contacts/search`, { params: { locationId, query: email, limit: 1 }, headers: ghlHeaders(token, GHL_API_VER_PRODUCTS), timeout: 10000 });
    const contacts = res.data?.contacts || res.data?.data || [];
    return contacts[0] || null;
}

async function updateContactCustomFields(locationId, contactId, fields) {
    const token = await getOrCreateLocationToken(locationId);
    await axios.put(`${GHL_API_BASE}/contacts/${contactId}`, { customFields: fields }, { headers: ghlHeaders(token, GHL_API_VER_V3), timeout: 10000 });
}

async function createCustomField(locationId, name, fieldKey, dataType = 'NUMERICAL') {
    const token = await getOrCreateLocationToken(locationId);
    const res = await axios.post(`${GHL_API_BASE}/locations/${locationId}/customFields`, { name, dataType, placeholder: '0', model: 'contact' }, { headers: ghlHeaders(token, GHL_API_VER_V3), timeout: 10000 });
    return res.data?.customField || res.data;
}

async function setupCustomFieldsForLocation(locationId) {
    const db = loadDB();
    if (!db.customFields) db.customFields = {};
    const existing = db.customFields[locationId] || {};
    const results  = { locationId, created: [], alreadyExists: [] };
    async function ensureField(label, key) {
        if (existing[key]) { results.alreadyExists.push(label); return existing[key]; }
        try {
            const field = await createCustomField(locationId, label, key, 'NUMERICAL');
            const id = field?.id || field?._id || field?.fieldId;
            if (id) { db.customFields[locationId] = { ...db.customFields[locationId], [key]: id }; saveDB(db); results.created.push(label); }
            return id;
        } catch (err) { return null; }
    }
    await ensureField('Leads This Week', 'leads_this_week');
    await ensureField('Total Earned',    'total_earned');
    return results;
}

app.post('/api/setup-custom-fields/:locationId', async (req, res) => {
    try {
        const results = await setupCustomFieldsForLocation(req.params.locationId);
        res.json({ success: true, ...results });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.post('/api/sync-subscriptions/:locationId', async (req, res) => {
    try {
        const results = await syncSubscriptionsFromGHL(req.params.locationId);
        res.json({ success: true, ...results });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/tracked-subscriptions/:locationId', (req, res) => {
    const db = loadDB();
    const subs = Object.values(db.trackedSubscriptions || {}).filter(s => s.locationId === req.params.locationId).sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0));
    res.json({ success: true, subscriptions: subs, total: subs.length });
});

app.patch('/api/tracked-subscriptions/:ghlSubId', (req, res) => {
    const { billingInterval, affiliateId, affiliateName, isAffiliated } = req.body;
    const db = loadDB();
    const rec = db.trackedSubscriptions?.[req.params.ghlSubId];
    if (!rec) return res.status(404).json({ success: false, error: 'Not found' });
    if (billingInterval) { rec.billingInterval = billingInterval; rec.nextCheckDate = calcNextCheckDate(new Date(rec.renewalDate).toISOString()); }
    if (affiliateId !== undefined) rec.affiliateId = affiliateId;
    if (affiliateName !== undefined) rec.affiliateName = affiliateName;
    if (isAffiliated !== undefined) rec.isAffiliated = isAffiliated;
    if (isAffiliated) rec.stopped = false;
    saveDB(db);
    res.json({ success: true, subscription: rec });
});

app.post('/api/subscription-check/run', async (req, res) => {
    try {
        const result = await runSubscriptionChecks(req.query.locationId || null);
        res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/subscription-check/status', (req, res) => {
    const { locationId } = req.query;
    const db = loadDB();
    const tracked = Object.values(db.trackedSubscriptions || {}).filter(s => !locationId || s.locationId === locationId).map(s => ({
        ghlSubId: s.ghlSubId, contactEmail: s.contactEmail, contactName: s.contactName, affiliateName: s.affiliateName, isAffiliated: s.isAffiliated, billingInterval: s.billingInterval, status: s.status, isActive: s.isActive, stopped: s.stopped, renewalDate: s.renewalDate, nextCheckDate: s.nextCheckDate, lastChecked: s.lastChecked, checkCount: s.checkCount || 0, amount: s.amount, currency: s.currency
    }));
    res.json({ success: true, tracked, log: (db.subscriptionCheckLog || []).slice(0, 10) });
});

cron.schedule('0 * * * *', async () => { await runSubscriptionChecks(null); }, { timezone: 'UTC' });

app.get('/health', (req, res) => { res.json({ status: 'ok', version: 'v3 Fuzzy Logic' }); });

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => console.log(`LEAF Server running on port ${PORT}`));
