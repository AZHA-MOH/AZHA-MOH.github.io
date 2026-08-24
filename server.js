const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const WebSocket = require('ws');
const { createStorage } = require('./storage');

const app = express();
const port = process.env.PORT || 3000;
const storage = createStorage();

function shouldServeLegacyBrowser(req) {
    if (String(req.query?.modern || '') === '1') return false;
    const userAgent = String(req.headers['user-agent'] || '');
    return /MSIE|Trident|IEMobile/i.test(userAgent)
        || /Windows 3\.1|Win16|Windows 95|Windows 98|Windows ME|Windows CE|Windows NT 3\.|Windows NT 4\.|Windows NT 5\.|Windows NT 6\.0|Windows NT 6\.1/i.test(userAgent);
}

app.use((req, res, next) => {
    if (shouldServeLegacyBrowser(req) && ['/', '/index.html'].includes(req.path)) {
        return res.sendFile(path.join(__dirname, 'Legacy.html'));
    }
    next();
});

app.use(express.static(path.join(__dirname)));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// Meeting room manager for WebSocket signaling
const meetingRooms = new Map();

// Track connected users for real-time messaging
const connectedUsers = new Map(); // username -> ws connection

// Track active rooms with timestamps for cross-instance visibility
const activeRooms = new Map(); // roomCode -> { createdAt, lastActivity }
const ACTIVE_ROOM_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// In-memory meetings storage (Vercel filesystem is read-only)
let meetingsMemoryCache = [];
let meetingsLastRead = 0;

const MEMBERSHIP_PLANS = {
    PLUS: {
        key: 'PLUS',
        label: 'Plus',
        azincCost: 1,
        rewardAmount: 15000,
        rewardInterval: 'month',
        features: []
    },
    PRO: {
        key: 'PRO',
        label: 'Pro',
        azincCost: 2,
        rewardAmount: 50000,
        rewardInterval: 'week',
        features: ['messages']
    },
    AZHA: {
        key: 'AZHA',
        label: 'AZHA',
        azincCost: 5,
        rewardAmount: 999999999,
        rewardInterval: 'day',
        features: ['messages', 'meetings', 'shared-storage']
    }
};

const SUPABASE_STATE_TABLE = 'azha_launchpad_state';

async function readMeetingsWithFallback() {
    try {
        const meetings = await readMeetings();
        meetingsMemoryCache = meetings;
        meetingsLastRead = Date.now();
        return meetings;
    } catch (error) {
        console.warn('Failed to read meetings from file, using memory cache:', error.message);
        return meetingsMemoryCache;
    }
}

async function writeMeetingsWithFallback(meetings) {
    meetingsMemoryCache = meetings;
    try {
        await writeMeetings(meetings);
    } catch (error) {
        console.warn('Failed to write meetings to file, using memory cache:', error.message);
    }
}

function getMeetingRoom(roomCode) {
    if (!meetingRooms.has(roomCode)) {
        meetingRooms.set(roomCode, { participants: new Map(), messages: [] });
        // Mark room as active for cross-instance visibility
        activeRooms.set(roomCode, { 
            createdAt: Date.now(), 
            lastActivity: Date.now() 
        });
    } else {
        // Update last activity timestamp
        if (activeRooms.has(roomCode)) {
            activeRooms.get(roomCode).lastActivity = Date.now();
        }
    }
    return meetingRooms.get(roomCode);
}

// Cleanup stale rooms periodically
setInterval(() => {
    const now = Date.now();
    for (const [roomCode, roomInfo] of activeRooms.entries()) {
        if (now - roomInfo.lastActivity > ACTIVE_ROOM_TIMEOUT) {
            activeRooms.delete(roomCode);
            meetingRooms.delete(roomCode);
        }
    }
}, 5 * 60 * 1000); // Cleanup every 5 minutes

const pageRoutes = ['Getin.html', 'Message.html', 'Meetings.html', 'contact.html', 'Download.html', 'Admin.html', 'Profile.html', 'Browser.html', 'Chat.html', 'Friends.html', 'Clubs.html', 'Shop.html', 'Announcements.html', 'games.html', 'CEOPanel.html', 'OrganizationAdmin.html', 'Legacy.html'];
pageRoutes.forEach((page) => {
    app.get(`/${page}`, (req, res) => {
        res.sendFile(path.join(__dirname, page));
    });
});

function wrap(handler) {
    return (req, res, next) => {
        Promise.resolve(handler(req, res, next)).catch(next);
    };
}

function getBaseUrl(req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    return `${proto}://${host}`;
}

function getMembershipPlan(planKey) {
    return MEMBERSHIP_PLANS[String(planKey || '').toUpperCase()] || null;
}

function addInterval(dateInput, interval, count = 1) {
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) {
        return new Date();
    }
    const next = new Date(date);
    if (interval === 'day') {
        next.setUTCDate(next.getUTCDate() + count);
    } else if (interval === 'week') {
        next.setUTCDate(next.getUTCDate() + (7 * count));
    } else {
        next.setUTCMonth(next.getUTCMonth() + count);
    }
    return next;
}

function addYear(dateInput) {
    const date = new Date(dateInput);
    if (Number.isNaN(date.getTime())) {
        return new Date();
    }
    const next = new Date(date);
    next.setUTCFullYear(next.getUTCFullYear() + 1);
    return next;
}

function normalizeBrowserProfile(profile = {}) {
    const tabs = Array.isArray(profile?.tabs)
        ? profile.tabs
            .map((item) => ({
                id: String(item?.id || crypto.randomUUID()),
                title: String(item?.title || item?.url || 'New tab').slice(0, 120),
                url: String(item?.url || '').trim()
            }))
            .filter((item) => item.url)
            .slice(0, 8)
        : [];
    const bookmarks = Array.isArray(profile?.bookmarks)
        ? profile.bookmarks
            .map((item) => ({
                id: String(item?.id || crypto.randomUUID()),
                title: String(item?.title || item?.url || 'Saved page').slice(0, 120),
                url: String(item?.url || '').trim(),
                createdAt: String(item?.createdAt || new Date().toISOString())
            }))
            .filter((item) => item.url)
            .slice(0, 30)
        : [];
    const history = Array.isArray(profile?.history)
        ? profile.history
            .map((item) => ({
                id: String(item?.id || crypto.randomUUID()),
                title: String(item?.title || item?.url || 'Visited page').slice(0, 120),
                url: String(item?.url || '').trim(),
                visitedAt: String(item?.visitedAt || new Date().toISOString())
            }))
            .filter((item) => item.url)
            .slice(0, 60)
        : [];
    return {
        homeUrl: String(profile?.homeUrl || 'https://start.coderazhaf.local').trim(),
        searchEngine: ['azha'].includes(String(profile?.searchEngine || '').toLowerCase())
            ? String(profile.searchEngine).toLowerCase()
            : 'azha',
        theme: ['midnight', 'sunrise', 'forest', 'school'].includes(String(profile?.theme || '').toLowerCase())
            ? String(profile.theme).toLowerCase()
            : 'midnight',
        tabs: tabs.length ? tabs : [{ id: 'home-tab', title: 'Start', url: String(profile?.homeUrl || 'https://start.coderazhaf.local').trim() || 'https://start.coderazhaf.local' }],
        activeTabId: String(profile?.activeTabId || (tabs[0]?.id || 'home-tab')),
        bookmarks,
        history,
        organization: {
            name: String(profile?.organization?.name || ''),
            type: ['personal', 'school', 'work'].includes(String(profile?.organization?.type || '').toLowerCase())
                ? String(profile.organization.type).toLowerCase()
                : 'personal',
            emailDomain: String(profile?.organization?.emailDomain || ''),
            logoText: String(profile?.organization?.logoText || 'AZHA'),
            managed: {
                enabled: Boolean(profile?.organization?.managed?.enabled),
                by: String(profile?.organization?.managed?.by || '')
            },
            managedBookmarks: Array.isArray(profile?.organization?.managedBookmarks)
                ? profile.organization.managedBookmarks
                    .map((item) => ({
                        id: String(item?.id || crypto.randomUUID()),
                        title: String(item?.title || item?.url || 'Managed link').slice(0, 120),
                        url: String(item?.url || '').trim()
                    }))
                    .filter((item) => item.url)
                    .slice(0, 12)
                : []
        },
        controls: {
            blockedDomains: Array.isArray(profile?.controls?.blockedDomains)
                ? profile.controls.blockedDomains.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean).slice(0, 40)
                : [],
            allowedDomains: Array.isArray(profile?.controls?.allowedDomains)
                ? profile.controls.allowedDomains.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean).slice(0, 40)
                : [],
            strictMode: Boolean(profile?.controls?.strictMode),
            studentSafeMode: Boolean(profile?.controls?.studentSafeMode)
        },
        updatedAt: String(profile?.updatedAt || '')
    };
}

function normalizeMembershipRecord(membership) {
    const plan = getMembershipPlan(membership?.planKey);
    const planKey = plan?.key || '';
    return {
        planKey,
        status: String(membership?.status || (planKey ? 'active' : 'none')),
        expiresAt: String(membership?.expiresAt || ''),
        nextRewardAt: String(membership?.nextRewardAt || ''),
        rewardInterval: String(membership?.rewardInterval || plan?.rewardInterval || ''),
        rewardAmount: Number(membership?.rewardAmount ?? plan?.rewardAmount ?? 0) || 0,
        features: Array.isArray(membership?.features) ? membership.features.map(String) : (plan?.features || []),
        azincCost: Number(membership?.azincCost ?? plan?.azincCost ?? 0) || 0,
        grantedBy: String(membership?.grantedBy || ''),
        source: String(membership?.source || ''),
        purchasedAt: String(membership?.purchasedAt || '')
    };
}

function buildMembershipRecord(planKey, extras = {}) {
    const plan = getMembershipPlan(planKey);
    if (!plan) return normalizeMembershipRecord({});
    const now = new Date();
    return normalizeMembershipRecord({
        planKey: plan.key,
        status: 'active',
        expiresAt: extras.expiresAt || addYear(now).toISOString(),
        nextRewardAt: extras.nextRewardAt || now.toISOString(),
        rewardInterval: plan.rewardInterval,
        rewardAmount: plan.rewardAmount,
        features: plan.features,
        azincCost: plan.azincCost,
        grantedBy: extras.grantedBy || '',
        source: extras.source || '',
        purchasedAt: extras.purchasedAt || ''
    });
}

function isMembershipActive(membership) {
    if (!membership?.planKey || membership.status !== 'active' || !membership.expiresAt) {
        return false;
    }
    const expiresAt = new Date(membership.expiresAt);
    return !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() > Date.now();
}

function serializeMembership(membership) {
    const normalized = normalizeMembershipRecord(membership);
    const plan = getMembershipPlan(normalized.planKey);
    return {
        planKey: normalized.planKey,
        label: plan?.label || 'None',
        active: isMembershipActive(normalized),
        expiresAt: normalized.expiresAt,
        nextRewardAt: normalized.nextRewardAt,
        rewardAmount: normalized.rewardAmount,
        rewardInterval: normalized.rewardInterval,
        features: normalized.features,
        azincCost: normalized.azincCost,
        source: normalized.source
    };
}

function normalizeStoragePreference(preference = {}) {
    const mode = ['shared', 'supabase'].includes(String(preference?.mode || '').toLowerCase())
        ? String(preference.mode).toLowerCase()
        : 'shared';
    return {
        mode,
        supabaseUrl: String(preference?.supabaseUrl || '').trim().replace(/\/+$/, ''),
        supabaseKey: String(preference?.supabaseKey || '').trim(),
        status: String(preference?.status || (mode === 'shared' ? 'shared' : 'not_configured')),
        lastCheckedAt: String(preference?.lastCheckedAt || ''),
        lastError: String(preference?.lastError || '')
    };
}

function canUseSharedStorage(account) {
    if (!account) return false;
    if (account.username === 'AZHA') return true;
    const membership = normalizeMembershipRecord(account.membership);
    return isMembershipActive(membership) && membership.planKey === 'AZHA';
}

function shouldUseSupabaseStorage(account) {
    const preference = normalizeStoragePreference(account?.storagePreference);
    return preference.mode === 'supabase' && Boolean(preference.supabaseUrl && preference.supabaseKey) && preference.status !== 'expired';
}

function serializeStoragePreference(account) {
    const preference = normalizeStoragePreference(account?.storagePreference);
    return {
        mode: preference.mode,
        status: preference.status,
        lastCheckedAt: preference.lastCheckedAt,
        lastError: preference.lastError,
        supabaseUrl: preference.supabaseUrl,
        hasKey: Boolean(preference.supabaseKey),
        sharedAllowed: canUseSharedStorage(account)
    };
}

function summarizeStorageAccess(account) {
    const preference = normalizeStoragePreference(account?.storagePreference);
    const sharedAllowed = canUseSharedStorage(account);
    if (preference.mode === 'supabase') {
        if (preference.status === 'expired' || preference.status === 'error') {
            return {
                label: 'Supabase expired',
                detail: preference.lastError || 'Reconnect Supabase or switch storage.'
            };
        }
        return {
            label: 'Supabase',
            detail: 'Using your own Supabase storage.'
        };
    }
    if (sharedAllowed) {
        return {
            label: 'AZHA Upstash',
            detail: 'Shared AZHA Upstash storage is unlocked for this account.'
        };
    }
    return {
        label: 'Locked',
        detail: 'Shared AZHA Upstash storage needs an active MAX membership.'
    };
}

function getAccountType(account) {
    const profile = normalizeBrowserProfile(account?.browserProfile);
    const type = String(profile?.organization?.type || '').toLowerCase();
    return ['school', 'work'].includes(type) ? type : 'personal';
}

function isOrganizationManagedAccount(account) {
    const profile = normalizeBrowserProfile(account?.browserProfile);
    return Boolean(profile.organization?.managed?.enabled && ['school', 'work'].includes(getAccountType(account)));
}

function membershipHasFeature(account, feature) {
    if (!account) return false;
    if (account.username === 'AZHA') return true;
    const membership = normalizeMembershipRecord(account.membership);
    if (!isMembershipActive(membership)) return false;
    return membership.features.includes(feature);
}

function sanitizeDisplayBalance(username, balance) {
    if (username === 'AZHA') return 'INF';
    if (balance === 'INF' || balance === Infinity || Number.isNaN(Number(balance))) return 0;
    return Number(balance || 0);
}

function serializeAccount(account, balance) {
    const membership = serializeMembership(account.membership);
    return {
        ...account,
        membership,
        storagePreference: serializeStoragePreference(account),
        browserProfile: normalizeBrowserProfile(account.browserProfile),
        accountType: getAccountType(account),
        managedAccount: isOrganizationManagedAccount(account),
        featureAccess: {
            messages: membershipHasFeature(account, 'messages'),
            meetings: membershipHasFeature(account, 'meetings'),
            sharedStorage: membershipHasFeature(account, 'shared-storage')
        },
        balance: sanitizeDisplayBalance(account.username, balance)
    };
}


function parseCookies(req) {
    const header = req.headers.cookie || '';
    return header.split(';').reduce((cookies, pair) => {
        const [rawKey, ...rest] = pair.trim().split('=');
        if (!rawKey) return cookies;
        cookies[rawKey] = decodeURIComponent(rest.join('=') || '');
        return cookies;
    }, {});
}

function setCookie(res, name, value, options = {}) {
    const parts = [`${name}=${encodeURIComponent(value)}`];
    if (options.httpOnly !== false) parts.push('HttpOnly');
    parts.push(`Path=${options.path || '/'}`);
    parts.push(`SameSite=${options.sameSite || 'Lax'}`);
    if (options.maxAge) parts.push(`Max-Age=${options.maxAge}`);
    if (options.secure !== false) parts.push('Secure');
    const existing = res.getHeader('Set-Cookie');
    const next = existing ? (Array.isArray(existing) ? existing.concat(parts.join('; ')) : [existing, parts.join('; ')]) : parts.join('; ');
    res.setHeader('Set-Cookie', next);
}

function clearCookie(res, name) {
    setCookie(res, name, '', { maxAge: 0 });
}

function buildRedirectUri(req, envName, fallbackPath) {
    return process.env[envName] || `${getBaseUrl(req)}${fallbackPath}`;
}

function missingEnv(names) {
    return names.filter((name) => !String(process.env[name] || '').trim());
}

async function sendSignupNotification(account, source) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.SIGNUP_EMAIL_FROM;
    const to = process.env.SIGNUP_EMAIL_TO || 'Azhafuddin@coderazhaf.github.io';
    if (!apiKey || !from) return false;

    const html = `
        <div style="font-family:Arial,sans-serif;line-height:1.6">
            <h2>New CoderAzhaf signup</h2>
            <p><strong>Source:</strong> ${source}</p>
            <p><strong>Username:</strong> ${account.username}</p>
            <p><strong>Full name:</strong> ${account.fullName}</p>
            <p><strong>Email:</strong> ${account.email || 'Not provided'}</p>
            <p><strong>Provider:</strong> ${account.authProvider || 'local'}</p>
        </div>
    `;

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from,
            to: [to],
            subject: `New signup: ${account.username}`,
            html
        })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Signup email failed: ${response.status} ${text}`);
    }

    return true;
}

async function readResponsePayload(response) {
    const text = await response.text();
    try {
        return { data: JSON.parse(text), text };
    } catch (error) {
        return { data: null, text };
    }
}

async function upsertOAuthAccount(profile) {
    const accounts = await readAccounts();
    const balances = await readBalances();
    const email = String(profile.email || '').trim().toLowerCase();
    let existingKey = Object.keys(accounts).find((key) => accounts[key].email && accounts[key].email.toLowerCase() === email);
    if (!existingKey) {
        existingKey = Object.keys(accounts).find((key) => accounts[key].username.toLowerCase() === email);
    }

    const isNewAccount = !existingKey;
    const username = existingKey ? accounts[existingKey].username : email;
    const account = {
        ...(existingKey ? accounts[existingKey] : {}),
        username,
        password: existingKey ? accounts[existingKey].password : '',
        fullName: profile.fullName || email,
        profilePic: profile.profilePic || (existingKey ? accounts[existingKey].profilePic : ''),
        isAdmin: existingKey ? accounts[existingKey].isAdmin : false,
        warnings: existingKey ? accounts[existingKey].warnings || 0 : 0,
        status: existingKey ? accounts[existingKey].status || 'active' : 'active',
        email,
        authProvider: profile.provider,
        membership: normalizeMembershipRecord(existingKey ? accounts[existingKey].membership : {}),
        storagePreference: normalizeStoragePreference(existingKey ? accounts[existingKey].storagePreference : { mode: 'shared', status: 'shared' })
    };

    if (existingKey && existingKey !== username) {
        delete accounts[existingKey];
    }
    accounts[username] = account;
    if (username !== 'AZHA' && !Object.prototype.hasOwnProperty.call(balances, username)) {
        balances[username] = 0;
    }

    await Promise.all([writeAccounts(accounts), writeBalances(balances)]);
    if (isNewAccount) {
        try {
            await sendSignupNotification(account, `${profile.provider} oauth`);
        } catch (error) {
            console.error(error);
        }
    }
    return account;
}

function renderOAuthSuccess(res, account) {
    const encoded = Buffer.from(JSON.stringify({
        username: account.username,
        fullName: account.fullName,
        profilePic: account.profilePic || '',
        isAdmin: Boolean(account.isAdmin)
    })).toString('base64');

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Signing you in</title></head>
<body style="font-family:Arial,sans-serif;background:#06131a;color:#f4f2ea;display:grid;place-items:center;min-height:100vh;">
<div style="text-align:center"><img src="channels4profile.jpg" alt="AZHA" style="width:96px;height:96px;border-radius:24px"><h1>Signing you in...</h1><p>Your ${account.authProvider || 'oauth'} account is ready.</p></div>
<script>
const payload = JSON.parse(atob('${encoded}'));
localStorage.setItem('currentUser', payload.fullName);
localStorage.setItem('currentUsername', payload.username);
localStorage.setItem('isLoggedIn', 'true');
localStorage.setItem('isAdmin', payload.isAdmin ? 'true' : 'false');
window.location.replace('/index.html');
</script>
</body>
</html>`);
}

app.get('/api/auth/google/start', wrap(async (req, res) => {
    const missing = missingEnv(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
    if (missing.length) {
        return res.status(400).send(`Google login is not configured yet. Missing: ${missing.join(', ')}`);
    }
    const state = crypto.randomUUID();
    setCookie(res, 'oauth_google_state', state, { maxAge: 600 });
    const redirectUri = buildRedirectUri(req, 'GOOGLE_REDIRECT_URI', '/api/auth/google/callback');
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid email profile');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('prompt', 'select_account');
    res.redirect(authUrl.toString());
}));

app.get('/api/auth/google/callback', wrap(async (req, res) => {
    const cookies = parseCookies(req);
    if (!req.query.code || !req.query.state || cookies.oauth_google_state !== req.query.state) {
        return res.status(400).send('Google login could not be verified.');
    }
    clearCookie(res, 'oauth_google_state');
    const redirectUri = buildRedirectUri(req, 'GOOGLE_REDIRECT_URI', '/api/auth/google/callback');
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code: String(req.query.code),
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
        })
    });
    const { data: tokenData, text: tokenText } = await readResponsePayload(tokenResponse);
    if (!tokenResponse.ok) {
        return res.status(400).send(tokenData?.error_description || tokenData?.error || tokenText || 'Google token exchange failed.');
    }
    if (!tokenData?.access_token) {
        return res.status(400).send('Google token exchange did not return an access token.');
    }
    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const { data: profile, text: profileText } = await readResponsePayload(profileResponse);
    if (!profileResponse.ok || !profile.email) {
        return res.status(400).send(profileText || 'Google profile fetch failed.');
    }
    const account = await upsertOAuthAccount({
        provider: 'google',
        email: profile.email,
        fullName: profile.name || profile.email,
        profilePic: profile.picture || ''
    });
    renderOAuthSuccess(res, account);
}));

app.get('/api/auth/microsoft/start', wrap(async (req, res) => {
    const missing = missingEnv(['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET']);
    if (missing.length) {
        return res.status(400).send(`Microsoft login is not configured yet. Missing: ${missing.join(', ')}`);
    }
    const state = crypto.randomUUID();
    setCookie(res, 'oauth_microsoft_state', state, { maxAge: 600 });
    const redirectUri = buildRedirectUri(req, 'MICROSOFT_REDIRECT_URI', '/api/auth/microsoft/callback');
    const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
    const authUrl = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
    authUrl.searchParams.set('client_id', process.env.MICROSOFT_CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', 'openid profile email User.Read');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('prompt', 'select_account');
    res.redirect(authUrl.toString());
}));

app.get('/api/auth/microsoft/callback', wrap(async (req, res) => {
    const cookies = parseCookies(req);
    if (!req.query.code || !req.query.state || cookies.oauth_microsoft_state !== req.query.state) {
        return res.status(400).send('Microsoft login could not be verified.');
    }
    clearCookie(res, 'oauth_microsoft_state');
    const redirectUri = buildRedirectUri(req, 'MICROSOFT_REDIRECT_URI', '/api/auth/microsoft/callback');
    const tenant = process.env.MICROSOFT_TENANT_ID || 'common';
    const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code: String(req.query.code),
            client_id: process.env.MICROSOFT_CLIENT_ID,
            client_secret: process.env.MICROSOFT_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code'
        })
    });
    const { data: tokenData, text: tokenText } = await readResponsePayload(tokenResponse);
    if (!tokenResponse.ok) {
        return res.status(400).send(tokenData?.error_description || tokenData?.error || tokenText || 'Microsoft token exchange failed.');
    }
    if (!tokenData?.access_token) {
        return res.status(400).send('Microsoft token exchange did not return an access token.');
    }
    const profileResponse = await fetch('https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const { data: profile, text: profileText } = await readResponsePayload(profileResponse);
    const email = profile.mail || profile.userPrincipalName;
    if (!profileResponse.ok || !email) {
        return res.status(400).send(profileText || 'Microsoft profile fetch failed.');
    }
    const account = await upsertOAuthAccount({
        provider: 'microsoft',
        email,
        fullName: profile.displayName || email,
        profilePic: ''
    });
    renderOAuthSuccess(res, account);
}));

async function readAccounts() {
    const rawAccounts = await storage.readAccounts();
    const entries = rawAccounts && typeof rawAccounts === 'object' ? Object.values(rawAccounts) : [];
    const normalized = {};
    entries.forEach((account) => {
        const username = String(account?.username || '').trim();
        if (!username) return;
        normalized[username] = {
            username,
            password: String(account?.password || ''),
            fullName: String(account?.fullName || username),
            profilePic: String(account?.profilePic || ''),
            email: String(account?.email || ''),
            authProvider: String(account?.authProvider || 'local'),
            isAdmin: Boolean(account?.isAdmin),
            warnings: Number(account?.warnings || 0),
            orgWarnings: Number(account?.orgWarnings || 0),
            status: String(account?.status || 'active'),
            organizationId: String(account?.organizationId || ''),
            presenceStatus: ['online', 'busy', 'offline'].includes(String(account?.presenceStatus || '').toLowerCase())
                ? String(account.presenceStatus).toLowerCase()
                : 'offline',
            lastSeenAt: String(account?.lastSeenAt || ''),
            membership: normalizeMembershipRecord(account?.membership),
            storagePreference: normalizeStoragePreference(account?.storagePreference),
            browserProfile: normalizeBrowserProfile(account?.browserProfile)
        };
    });
    return normalized;
}

async function writeAccounts(accounts) {
    await storage.writeAccounts(accounts);
}

async function readMessages() {
    const rawMessages = await storage.readMessages();
    const list = Array.isArray(rawMessages) ? rawMessages : [];
    return list.map(normalizeMessageRecord).filter((message) => message.from && message.to);
}

async function writeMessages(messages) {
    await storage.writeMessages(messages);
}

async function readBalances() {
    const rawBalances = await storage.readBalances();
    const accounts = await readAccounts();
    const validUsers = new Set(Object.values(accounts).map((account) => String(account.username || '')));
    validUsers.add('AZHA');
    const source = rawBalances && typeof rawBalances === 'object' ? { ...rawBalances } : {};
    const balances = {};
    Object.keys(source).forEach((username) => {
        if (!validUsers.has(username)) return;
        if (username === 'AZHA') {
            balances[username] = 'INF';
            return;
        }
        if (source[username] === 'INF' || source[username] === Infinity || Number.isNaN(Number(source[username]))) {
            balances[username] = 0;
            return;
        }
        balances[username] = Number(source[username] || 0);
    });
    validUsers.forEach((username) => {
        if (!Object.prototype.hasOwnProperty.call(balances, username)) {
            balances[username] = username === 'AZHA' ? 'INF' : 0;
        }
    });
    return balances;
}

async function writeBalances(balances) {
    await storage.writeBalances(balances);
}

function normalizeMeetingRecord(meeting) {
    return {
        id: String(meeting?.id || ''),
        title: String(meeting?.title || 'AZHA Meeting'),
        roomCode: String(meeting?.roomCode || ''),
        host: String(meeting?.host || ''),
        startsAt: String(meeting?.startsAt || ''),
        note: String(meeting?.note || ''),
        createdAt: String(meeting?.createdAt || ''),
        status: String(meeting?.status || 'scheduled'),
        durationMinutes: meeting?.durationMinutes === null || meeting?.durationMinutes === undefined ? null : Number(meeting?.durationMinutes) || null,
        recordingEnabled: Boolean(meeting?.recordingEnabled || false),
        hostControls: {
            canEndMeeting: Boolean(meeting?.hostControls?.canEndMeeting !== false),
            canMuteParticipants: Boolean(meeting?.hostControls?.canMuteParticipants !== false),
            canRemoveParticipants: Boolean(meeting?.hostControls?.canRemoveParticipants !== false),
            canShareScreen: Boolean(meeting?.hostControls?.canShareScreen !== false),
            canRecord: Boolean(meeting?.hostControls?.canRecord !== false)
        },
        recordings: Array.isArray(meeting?.recordings) ? meeting.recordings : []
    };
}

async function readMeetings() {
    const rawMeetings = await storage.readMeetings();
    const list = Array.isArray(rawMeetings) ? rawMeetings : [];
    return list
        .map(normalizeMeetingRecord)
        .filter((meeting) => meeting.id && meeting.roomCode);
}

async function writeMeetings(meetings) {
    await storage.writeMeetings(meetings);
}

async function readFriendsData() {
    const raw = await storage.readFriends();
    return {
        requests: Array.isArray(raw?.requests) ? raw.requests : [],
        friendships: Array.isArray(raw?.friendships) ? raw.friendships : []
    };
}

async function writeFriendsData(friends) {
    await storage.writeFriends({
        requests: Array.isArray(friends?.requests) ? friends.requests : [],
        friendships: Array.isArray(friends?.friendships) ? friends.friendships : []
    });
}

async function readChatsData() {
    const raw = await storage.readChats();
    return Array.isArray(raw) ? raw : [];
}

async function writeChatsData(chats) {
    await storage.writeChats(Array.isArray(chats) ? chats : []);
}

async function findAccount(username) {
    if (!username) return undefined;
    const accounts = await readAccounts();
    const lowered = String(username).trim().toLowerCase();
    return Object.values(accounts).find((account) => String(account.username || '').toLowerCase() === lowered);
}

async function findAccountKey(username) {
    const accounts = await readAccounts();
    const lowered = String(username).trim().toLowerCase();
    const key = Object.keys(accounts).find((entry) => String(accounts[entry]?.username || '').toLowerCase() === lowered);
    return { accounts, key };
}

function normalizeOrganizationRecord(organization = {}) {
    const owner = String(organization?.owner || '').trim();
    const unique = (values = []) => Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
    const members = unique([owner, ...(Array.isArray(organization?.members) ? organization.members : [])]);
    const admins = unique([owner, ...(Array.isArray(organization?.admins) ? organization.admins : [])]).filter((username) => members.includes(username));
    const banned = unique(Array.isArray(organization?.banned) ? organization.banned : []).filter((username) => username !== owner);
    const kind = ['school', 'work'].includes(String(organization?.kind || '').toLowerCase())
        ? String(organization.kind).toLowerCase()
        : 'work';
    const logoText = String(organization?.logoText || organization?.name || 'AZHA').trim().slice(0, 30) || 'AZHA';
    const domain = String(organization?.domain || organization?.emailDomain || '').trim().toLowerCase();
    return {
        id: String(organization?.id || crypto.randomUUID()),
        name: String(organization?.name || 'Organization').trim() || 'Organization',
        description: String(organization?.description || '').trim(),
        kind,
        domain,
        logoText,
        owner,
        admins,
        members,
        banned,
        createdAt: String(organization?.createdAt || new Date().toISOString())
    };
}

async function readOrganizationsData() {
    const raw = await storage.readOrganizations();
    return {
        organizations: Array.isArray(raw?.organizations)
            ? raw.organizations.map(normalizeOrganizationRecord).filter((organization) => organization.owner)
            : []
    };
}

async function writeOrganizationsData(data) {
    await storage.writeOrganizations({
        organizations: Array.isArray(data?.organizations)
            ? data.organizations.map(normalizeOrganizationRecord).filter((organization) => organization.owner)
            : []
    });
}

function organizationHasUser(organization, username) {
    const lowered = String(username || '').trim().toLowerCase();
    if (!lowered) return false;
    return [organization.owner, ...(organization.admins || []), ...(organization.members || [])]
        .some((value) => String(value || '').trim().toLowerCase() === lowered);
}

function getOrganizationRole(organization, username) {
    const lowered = String(username || '').trim().toLowerCase();
    if (!lowered) return 'outside';
    if (lowered === 'azha') return 'ceo';
    if (String(organization?.owner || '').trim().toLowerCase() === lowered) return 'owner';
    if ((organization?.admins || []).some((value) => String(value || '').trim().toLowerCase() === lowered)) return 'admin';
    if ((organization?.members || []).some((value) => String(value || '').trim().toLowerCase() === lowered)) return 'member';
    if ((organization?.banned || []).some((value) => String(value || '').trim().toLowerCase() === lowered)) return 'banned';
    return 'outside';
}

function isOrganizationManager(organization, username) {
    return ['ceo', 'owner', 'admin'].includes(getOrganizationRole(organization, username));
}

function canActorManageTargetInOrganization(organization, actor, targetUsername) {
    const actorRole = getOrganizationRole(organization, actor);
    const targetRole = getOrganizationRole(organization, targetUsername);
    if (actorRole === 'ceo') return targetUsername !== 'AZHA';
    if (!['owner', 'admin'].includes(actorRole)) return false;
    if (!['member', 'admin'].includes(targetRole)) return false;
    if (targetRole === 'owner') return false;
    if (actorRole === 'admin' && targetRole !== 'member') return false;
    return true;
}

function buildOrganizationManagedBrowserProfile(organization, accountType, currentProfile = {}, managedBy = '') {
    const current = normalizeBrowserProfile(currentProfile);
    const orgType = ['school', 'work'].includes(String(accountType || '').toLowerCase())
        ? String(accountType).toLowerCase()
        : (organization.kind || 'work');
    return normalizeBrowserProfile({
        ...current,
        organization: {
            ...current.organization,
            name: organization.name,
            type: orgType,
            emailDomain: organization.domain || current.organization.emailDomain,
            logoText: organization.logoText || current.organization.logoText || 'AZHA',
            managed: {
                enabled: true,
                by: managedBy || organization.name
            },
            managedBookmarks: current.organization.managedBookmarks || []
        }
    });
}

function clearOrganizationManagedBrowserProfile(currentProfile = {}) {
    const current = normalizeBrowserProfile(currentProfile);
    return normalizeBrowserProfile({
        ...current,
        organization: {
            ...current.organization,
            name: '',
            type: 'personal',
            emailDomain: '',
            logoText: 'AZHA',
            managed: {
                enabled: false,
                by: ''
            },
            managedBookmarks: []
        }
    });
}

async function getOrganizationsForUser(username) {
    const data = await readOrganizationsData();
    if (String(username || '').trim() === 'AZHA') {
        return data.organizations;
    }
    return data.organizations.filter((organization) => organizationHasUser(organization, username));
}

async function findOrganizationById(orgId) {
    const data = await readOrganizationsData();
    return {
        organizations: data,
        organization: data.organizations.find((entry) => entry.id === orgId)
    };
}

async function canSendMeetingInviteForAccount(username) {
    if (String(username || '').trim() === 'AZHA') return true;
    const organizations = await getOrganizationsForUser(username);
    if (!organizations.length) return true;
    return organizations.some((organization) => ['owner', 'admin'].includes(getOrganizationRole(organization, username)));
}

function normalizeMessageRecord(message) {
    return {
        id: String(message?.id || ''),
        from: String(message?.from || ''),
        to: String(message?.to || ''),
        text: String(message?.text || ''),
        kind: String(message?.kind || 'message'),
        timestamp: String(message?.timestamp || ''),
        read: Boolean(message?.read),
        meta: message?.meta && typeof message.meta === 'object'
            ? {
                roomCode: String(message.meta.roomCode || ''),
                title: String(message.meta.title || ''),
                startsAt: String(message.meta.startsAt || ''),
                host: String(message.meta.host || ''),
                note: String(message.meta.note || ''),
                joinUrl: String(message.meta.joinUrl || ''),
                replyTo: message.meta.replyTo && typeof message.meta.replyTo === 'object'
                    ? {
                        id: String(message.meta.replyTo.id || ''),
                        from: String(message.meta.replyTo.from || ''),
                        text: String(message.meta.replyTo.text || '')
                    }
                    : null,
                forwardedFrom: message.meta.forwardedFrom && typeof message.meta.forwardedFrom === 'object'
                    ? {
                        id: String(message.meta.forwardedFrom.id || ''),
                        from: String(message.meta.forwardedFrom.from || ''),
                        to: String(message.meta.forwardedFrom.to || ''),
                        text: String(message.meta.forwardedFrom.text || '')
                    }
                    : null
            }
            : {},
        attachments: Array.isArray(message?.attachments)
            ? message.attachments.slice(0, 4).map((attachment) => ({
                type: ['image', 'video'].includes(String(attachment?.type || '')) ? String(attachment.type) : 'file',
                name: String(attachment?.name || 'attachment'),
                url: String(attachment?.url || '')
            })).filter((attachment) => attachment.url)
            : []
    };
}

function normalizeSupabasePayload(payload = {}) {
    return {
        messages: Array.isArray(payload?.messages)
            ? payload.messages.map(normalizeMessageRecord).filter((message) => message.from && message.to)
            : [],
        balance: Number(payload?.balance || 0) || 0
    };
}

function normalizeFriendRequestRecord(request) {
    return {
        id: String(request?.id || ''),
        from: String(request?.from || ''),
        to: String(request?.to || ''),
        status: String(request?.status || 'pending'),
        createdAt: String(request?.createdAt || new Date().toISOString())
    };
}

function normalizeFriendshipRecord(friendship) {
    const users = Array.isArray(friendship?.users)
        ? friendship.users.map((user) => String(user || '').trim()).filter(Boolean).slice(0, 2)
        : [];
    return {
        id: String(friendship?.id || ''),
        users: users.length === 2 ? users : [],
        createdAt: String(friendship?.createdAt || new Date().toISOString())
    };
}

function normalizeChatMessageRecord(message) {
    return {
        id: String(message?.id || ''),
        from: String(message?.from || ''),
        to: String(message?.to || ''),
        text: String(message?.text || ''),
        timestamp: String(message?.timestamp || new Date().toISOString()),
        read: Boolean(message?.read),
        replyTo: message?.replyTo && typeof message.replyTo === 'object'
            ? {
                id: String(message.replyTo.id || ''),
                from: String(message.replyTo.from || ''),
                text: String(message.replyTo.text || '')
            }
            : null,
        forwardedFrom: message?.forwardedFrom && typeof message.forwardedFrom === 'object'
            ? {
                id: String(message.forwardedFrom.id || ''),
                from: String(message.forwardedFrom.from || ''),
                to: String(message.forwardedFrom.to || ''),
                text: String(message.forwardedFrom.text || '')
            }
            : null
    };
}

function friendshipKey(a, b) {
    return [String(a || '').trim().toLowerCase(), String(b || '').trim().toLowerCase()].sort().join('::');
}

function effectivePresenceStatus(account) {
    const raw = String(account?.presenceStatus || 'offline').toLowerCase();
    const lastSeen = Date.parse(String(account?.lastSeenAt || ''));
    if (raw !== 'offline' && (!lastSeen || (Date.now() - lastSeen) > 5 * 60 * 1000)) {
        return 'offline';
    }
    return ['online', 'busy', 'offline'].includes(raw) ? raw : 'offline';
}

function areFriends(friendships, left, right) {
    const key = friendshipKey(left, right);
    return friendships.some((friendship) => friendshipKey(friendship.users[0], friendship.users[1]) === key);
}

async function buildFriendSummaries(friendUsernames, actorUsername) {
    const summaries = [];
    for (const username of friendUsernames) {
        const account = await findAccount(username);
        if (!account) continue;
        const membership = serializeMembership(account.membership);
        const balance = await getBalanceForAccount(account);
        summaries.push({
            username: account.username,
            fullName: account.fullName,
            profilePic: account.profilePic || '',
            status: effectivePresenceStatus(account),
            lastSeenAt: account.lastSeenAt || '',
            membershipLabel: membership.active ? membership.label : 'Locked',
            balance,
            isAdmin: Boolean(account.isAdmin),
            actorCanInspect: actorUsername === 'AZHA'
        });
    }
    return summaries.sort((a, b) => a.username.localeCompare(b.username));
}

async function updateAccountStoragePreference(username, updater) {
    const { accounts, key } = await findAccountKey(username);
    if (!key) return null;
    const current = normalizeStoragePreference(accounts[key].storagePreference);
    accounts[key].storagePreference = normalizeStoragePreference(typeof updater === 'function' ? updater(current) : updater);
    await writeAccounts(accounts);
    return accounts[key];
}

async function markSupabaseStorageIssue(username, error) {
    const message = String(error?.message || error || 'Supabase storage is unavailable').slice(0, 220);
    return updateAccountStoragePreference(username, (current) => ({
        ...current,
        status: 'expired',
        lastCheckedAt: new Date().toISOString(),
        lastError: message
    }));
}

function buildSupabaseHeaders(preference) {
    return {
        apikey: preference.supabaseKey,
        Authorization: `Bearer ${preference.supabaseKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation,resolution=merge-duplicates'
    };
}

async function requestSupabase(preference, pathSuffix, options = {}) {
    const baseUrl = String(preference.supabaseUrl || '').replace(/\/+$/, '');
    if (!baseUrl || !preference.supabaseKey) {
        throw new Error('Supabase URL or key is missing');
    }
    const response = await fetch(`${baseUrl}/rest/v1/${pathSuffix}`, {
        headers: {
            ...buildSupabaseHeaders(preference),
            ...(options.headers || {})
        },
        method: options.method || 'GET',
        body: options.body,
        cache: 'no-store'
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Supabase storage failed: ${response.status} ${text}`);
    }

    const text = await response.text();
    if (!text) return null;
    try {
        return JSON.parse(text);
    } catch (error) {
        return null;
    }
}

async function readSupabaseState(account) {
    const preference = normalizeStoragePreference(account.storagePreference);
    try {
        const rows = await requestSupabase(
            preference,
            `${SUPABASE_STATE_TABLE}?owner=eq.${encodeURIComponent(account.username)}&select=payload`
        );
        if (!Array.isArray(rows) || !rows.length) {
            return normalizeSupabasePayload({});
        }
        return normalizeSupabasePayload(rows[0]?.payload || {});
    } catch (error) {
        await markSupabaseStorageIssue(account.username, error);
        throw error;
    }
}

async function writeSupabaseState(account, payload) {
    const preference = normalizeStoragePreference(account.storagePreference);
    const normalizedPayload = normalizeSupabasePayload(payload);
    try {
        await requestSupabase(
            preference,
            `${SUPABASE_STATE_TABLE}?on_conflict=owner`,
            {
                method: 'POST',
                body: JSON.stringify([{
                    owner: account.username,
                    payload: normalizedPayload,
                    updated_at: new Date().toISOString()
                }])
            }
        );
        await updateAccountStoragePreference(account.username, (current) => ({
            ...current,
            status: 'connected',
            lastCheckedAt: new Date().toISOString(),
            lastError: ''
        }));
        return normalizedPayload;
    } catch (error) {
        await markSupabaseStorageIssue(account.username, error);
        throw error;
    }
}

async function readMessagesForAccount(account) {
    if (shouldUseSupabaseStorage(account)) {
        const state = await readSupabaseState(account);
        return state.messages;
    }
    const messages = await readMessages();
    const lowered = String(account.username).toLowerCase();
    return messages.filter((message) => message.to.toLowerCase() === lowered || message.from.toLowerCase() === lowered);
}

async function writeMessagesForAccount(account, userMessages) {
    const normalizedMessages = (Array.isArray(userMessages) ? userMessages : []).map(normalizeMessageRecord);
    if (shouldUseSupabaseStorage(account)) {
        const state = await readSupabaseState(account);
        state.messages = normalizedMessages;
        await writeSupabaseState(account, state);
        return;
    }
    const allMessages = await readMessages();
    const lowered = String(account.username).toLowerCase();
    const preserved = allMessages.filter((message) => message.to.toLowerCase() !== lowered && message.from.toLowerCase() !== lowered);
    await writeMessages([...preserved, ...normalizedMessages]);
}

async function appendMessageForUsers(message, sender, recipient) {
    const senderUsesSupabase = shouldUseSupabaseStorage(sender);
    const recipientUsesSupabase = shouldUseSupabaseStorage(recipient);

    if (!senderUsesSupabase && !recipientUsesSupabase) {
        const messages = await readMessages();
        messages.push(message);
        await writeMessages(messages);
        return;
    }

    if (!senderUsesSupabase || sender.username === recipient.username) {
        const messages = await readMessages();
        messages.push(message);
        await writeMessages(messages);
    } else {
        const senderMessages = await readMessagesForAccount(sender);
        senderMessages.push(message);
        await writeMessagesForAccount(sender, senderMessages);
    }

    if (recipient.username === sender.username) return;

    if (recipientUsesSupabase) {
        const recipientMessages = await readMessagesForAccount(recipient);
        recipientMessages.push(message);
        await writeMessagesForAccount(recipient, recipientMessages);
    } else if (senderUsesSupabase) {
        const messages = await readMessages();
        messages.push(message);
        await writeMessages(messages);
    }
}

async function getBalanceForAccount(account) {
    if (shouldUseSupabaseStorage(account)) {
        const state = await readSupabaseState(account);
        return sanitizeDisplayBalance(account.username, state.balance);
    }
    const balances = await readBalances();
    return sanitizeDisplayBalance(account.username, balances[account.username]);
}

async function setBalanceForAccount(account, nextBalance) {
    if (shouldUseSupabaseStorage(account)) {
        const state = await readSupabaseState(account);
        state.balance = account.username === 'AZHA' ? 'INF' : Number(nextBalance || 0);
        await writeSupabaseState(account, state);
        return state.balance;
    }
    const balances = await readBalances();
    balances[account.username] = account.username === 'AZHA' ? 'INF' : Number(nextBalance || 0);
    await writeBalances(balances);
    return balances[account.username];
}

async function buildPortableSupabaseSnapshot(account) {
    try {
        return {
            messages: await readMessagesForAccount(account),
            balance: await getBalanceForAccount(account)
        };
    } catch (error) {
        const sharedMessages = await readMessages();
        const lowered = String(account.username).toLowerCase();
        const sharedBalances = await readBalances();
        return {
            messages: sharedMessages.filter((message) => message.to.toLowerCase() === lowered || message.from.toLowerCase() === lowered),
            balance: sanitizeDisplayBalance(account.username, sharedBalances[account.username])
        };
    }
}

async function isAdminUser(username) {
    const account = await findAccount(username);
    return Boolean(account && account.isAdmin);
}

function applyAccountRename(accounts, messages, balances, oldUsername, newUsername) {
    if (oldUsername === newUsername) {
        return { accounts, messages, balances };
    }

    const existing = accounts[oldUsername];
    delete accounts[oldUsername];
    accounts[newUsername] = {
        ...existing,
        username: newUsername
    };

    const updatedMessages = messages.map((message) => ({
        ...message,
        from: message.from === oldUsername ? newUsername : message.from,
        to: message.to === oldUsername ? newUsername : message.to
    }));

    if (Object.prototype.hasOwnProperty.call(balances, oldUsername)) {
        balances[newUsername] = balances[oldUsername];
        delete balances[oldUsername];
    } else if (newUsername !== 'AZHA') {
        balances[newUsername] = balances[newUsername] ?? 0;
    }

    return { accounts, messages: updatedMessages, balances };
}

function normalizeRoomCode(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .replace(/[^a-z0-9-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

function createMeetingCode(hostUsername, title) {
    const hostPart = normalizeRoomCode(hostUsername || 'guest') || 'guest';
    const titlePart = normalizeRoomCode(title || 'meeting') || 'meeting';
    const randomPart = crypto.randomBytes(2).toString('hex');
    return `${hostPart}-${titlePart}-${randomPart}`;
}

app.get('/api/health', (req, res) => {
    res.json({ ok: true, storage: storage.getMode() });
});

app.get('/api/site-summary', wrap(async (req, res) => {
    const username = req.query.username ? String(req.query.username) : '';
    const accounts = await readAccounts();
    const meetings = await readMeetingsWithFallback();
    let messages = await readMessages();
    let unreadCount = 0;
    let currentUserBalance = null;
    let storageSummary = {
        label: 'Locked',
        detail: 'Visitors do not have shared storage access. Sign in and unlock the right plan to use storage.'
    };
    if (username) {
        const account = await findAccount(username);
        if (account) {
            const personalMessages = await readMessagesForAccount(account);
            messages = personalMessages;
            unreadCount = personalMessages.filter((message) => message.to === username && !message.read).length;
            currentUserBalance = await getBalanceForAccount(account);
            storageSummary = summarizeStorageAccess(account);
        }
    }
    const balances = await readBalances();

    res.json({
        storage: storageSummary.label,
        storageDetail: storageSummary.detail,
        users: Object.keys(accounts).length,
        messages: messages.length,
        meetings: meetings.length,
        unreadCount,
        featuredProjects: 3,
        azhaBalance: balances.AZHA || 'INF',
        currentUserBalance
    });
}));

app.post('/api/signup', wrap(async (req, res) => {
    let { username, password, fullName, actor } = req.body;
    username = username && String(username).trim();
    password = password && String(password).trim();
    fullName = fullName && String(fullName).trim();
    actor = actor && String(actor).trim();

    if (!username || !password || !fullName) {
        return res.status(400).json({ error: 'Please fill in all fields' });
    }

    if (actor) {
        const actorAccount = await findAccount(actor);
        if (actorAccount && isOrganizationManagedAccount(actorAccount)) {
            return res.status(403).json({ error: 'School and work accounts cannot create new accounts.' });
        }
    }

    if (await findAccount(username)) {
        return res.status(400).json({ error: 'Username already exists' });
    }

    const accounts = await readAccounts();
    const balances = await readBalances();
    accounts[username] = {
        username,
        password,
        fullName,
        profilePic: '',
        email: '',
        authProvider: 'local',
        isAdmin: false,
        warnings: 0,
        status: 'active',
        presenceStatus: 'offline',
        lastSeenAt: '',
        membership: normalizeMembershipRecord({}),
        storagePreference: normalizeStoragePreference({ mode: 'shared', status: 'shared' }),
        browserProfile: normalizeBrowserProfile({})
    };
    if (username !== 'AZHA') {
        balances[username] = 0;
    }

    await Promise.all([writeAccounts(accounts), writeBalances(balances)]);
    try {
        await sendSignupNotification(accounts[username], 'local signup');
    } catch (error) {
        console.error(error);
    }
    res.json({ message: 'Account created successfully' });
}));

app.post('/api/admin/create-managed-account', wrap(async (req, res) => {
    const actor = String(req.body.actor || '').trim();
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '').trim();
    const fullName = String(req.body.fullName || '').trim();
    const accountType = String(req.body.accountType || '').trim().toLowerCase();
    const orgName = String(req.body.orgName || '').trim();
    const orgDomain = String(req.body.orgDomain || '').trim();
    const orgLogoText = String(req.body.orgLogoText || 'AZHA').trim();

    if (!(await isAdminUser(actor))) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    if (!username || !password || !fullName) {
        return res.status(400).json({ error: 'Username, password, and full name are required' });
    }
    if (!['school', 'work'].includes(accountType)) {
        return res.status(400).json({ error: 'Choose school or work account type' });
    }
    if (await findAccount(username)) {
        return res.status(400).json({ error: 'Username already exists' });
    }

    const accounts = await readAccounts();
    const balances = await readBalances();
    accounts[username] = {
        username,
        password,
        fullName,
        profilePic: '',
        email: '',
        authProvider: 'local',
        isAdmin: false,
        warnings: 0,
        status: 'active',
        presenceStatus: 'offline',
        lastSeenAt: '',
        membership: normalizeMembershipRecord({}),
        storagePreference: normalizeStoragePreference({ mode: 'shared', status: 'shared' }),
        browserProfile: normalizeBrowserProfile({
            organization: {
                name: orgName,
                type: accountType,
                emailDomain: orgDomain,
                logoText: orgLogoText || 'AZHA',
                managed: {
                    enabled: true,
                    by: actor
                },
                managedBookmarks: []
            }
        })
    };
    balances[username] = 0;
    await Promise.all([writeAccounts(accounts), writeBalances(balances)]);
    res.json({
        message: `${accountType[0].toUpperCase() + accountType.slice(1)} account created.`,
        account: serializeAccount(accounts[username], balances[username])
    });
}));

app.post('/api/login', wrap(async (req, res) => {
    let { username, password } = req.body;
    username = username && String(username).trim();
    password = password && String(password).trim();

    if (!username || !password) {
        return res.status(400).json({ error: 'Please enter both username and password' });
    }

    const account = await findAccount(username);
    if (!account || account.password !== password) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (account.status === 'banned') {
        return res.status(403).json({ error: 'This account has been banned' });
    }

    const balance = await getBalanceForAccount(account);
    res.json(serializeAccount(account, balance));
}));

app.get('/api/users', wrap(async (req, res) => {
    const accounts = await readAccounts();
    const balances = await readBalances();
    res.json(
        Object.values(accounts).map((account) => ({
            ...serializeAccount(account, balances[account.username])
        }))
    );
}));

app.get('/api/account/:username', wrap(async (req, res) => {
    const account = await findAccount(req.params.username);
    if (!account) {
        return res.status(404).json({ error: 'User not found' });
    }
    const balance = await getBalanceForAccount(account);
    res.json(serializeAccount(account, balance));
}));

app.get('/api/browser-profile/:username', wrap(async (req, res) => {
    const account = await findAccount(req.params.username);
    if (!account) {
        return res.status(404).json({ error: 'User not found' });
    }
    res.json({
        username: account.username,
        browserProfile: normalizeBrowserProfile(account.browserProfile)
    });
}));

app.put('/api/browser-profile/:username', wrap(async (req, res) => {
    const actor = String(req.body.actor || '').trim();
    const targetUsername = String(req.params.username || '').trim();
    if (!actor || actor.toLowerCase() !== targetUsername.toLowerCase()) {
        return res.status(403).json({ error: 'You can only update your own browser profile.' });
    }

    const { accounts, key } = await findAccountKey(targetUsername);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    const current = normalizeBrowserProfile(accounts[key].browserProfile);
    const nextProfile = normalizeBrowserProfile({
        ...current,
        ...req.body.browserProfile,
        updatedAt: new Date().toISOString()
    });
    accounts[key].browserProfile = nextProfile;
    await writeAccounts(accounts);

    res.json({
        message: 'Browser profile updated.',
        username: accounts[key].username,
        browserProfile: nextProfile
    });
}));

app.get('/api/membership/plans', (req, res) => {
    res.json(Object.values(MEMBERSHIP_PLANS));
});

app.post('/api/membership/claim', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const { accounts, key } = await findAccountKey(username);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    const account = accounts[key];
    const membership = normalizeMembershipRecord(account.membership);
    if (!isMembershipActive(membership)) {
        return res.status(400).json({ error: 'You do not have an active membership to claim from.' });
    }

    const now = new Date();
    const expiresAt = new Date(membership.expiresAt);
    let nextRewardAt = new Date(membership.nextRewardAt || now.toISOString());
    if (Number.isNaN(nextRewardAt.getTime())) {
        nextRewardAt = new Date();
    }

    let claimCount = 0;
    while (nextRewardAt <= now && nextRewardAt < expiresAt && claimCount < 500) {
        claimCount += 1;
        nextRewardAt = addInterval(nextRewardAt, membership.rewardInterval);
    }

    if (!claimCount) {
        return res.status(400).json({ error: `Next reward is available on ${new Date(membership.nextRewardAt).toLocaleString()}.` });
    }

    const balances = await readBalances();
    const currentBalance = Number(balances[account.username] || 0);
    const claimedAmount = membership.rewardAmount * claimCount;
    balances[account.username] = account.username === 'AZHA' ? 'INF' : currentBalance + claimedAmount;
    accounts[key].membership = {
        ...membership,
        nextRewardAt: nextRewardAt.toISOString()
    };

    await Promise.all([writeAccounts(accounts), writeBalances(balances)]);
    res.json({
        message: 'Membership reward claimed.',
        claimedAmount,
        balance: balances[account.username],
        membership: serializeMembership(accounts[key].membership)
    });
}));

app.post('/api/membership/buy', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const planKey = String(req.body.planKey || '').trim().toUpperCase();
    const plan = getMembershipPlan(planKey);
    if (!plan) {
        return res.status(400).json({ error: 'Unknown membership plan' });
    }

    const account = await findAccount(username);
    if (!account) {
        return res.status(404).json({ error: 'User not found' });
    }
    const balances = await readBalances();
    if (account.username !== 'AZHA') {
        const currentBalance = Number(balances[account.username] || 0);
        if (currentBalance < plan.azincCost) {
            return res.status(400).json({ error: `You need ${plan.azincCost} AZHA to buy ${plan.label}.` });
        }
        balances[account.username] = currentBalance - plan.azincCost;
        await writeBalances(balances);
    }

    const { accounts, key } = await findAccountKey(username);
    accounts[key].membership = buildMembershipRecord(plan.key, {
        expiresAt: addYear(new Date()).toISOString(),
        nextRewardAt: new Date().toISOString(),
        source: 'azha',
        grantedBy: username,
        purchasedAt: new Date().toISOString()
    });
    await writeAccounts(accounts);

    res.json({
        message: `${plan.label} membership activated with AZHA.`,
        account: serializeAccount(accounts[key], balances[accounts[key].username]),
        remainingBalance: balances[accounts[key].username]
    });
}));

app.post('/api/membership/cancel', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const { accounts, key } = await findAccountKey(username);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }
    accounts[key].membership = normalizeMembershipRecord({});
    await writeAccounts(accounts);
    const balances = await readBalances();
    res.json({
        message: 'Membership cancelled.',
        account: serializeAccount(accounts[key], balances[accounts[key].username])
    });
}));

app.put('/api/admin/users/:username', wrap(async (req, res) => {
    const actor = req.body.actor;
    if (!(await isAdminUser(actor))) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const originalUsername = req.params.username;
    const nextUsername = String(req.body.username || '').trim();
    const requestedPassword = String(req.body.password || '').trim();
    const nextFullName = String(req.body.fullName || '').trim();

    if (!nextUsername) {
        return res.status(400).json({ error: 'Username is required' });
    }

    const { accounts, key } = await findAccountKey(originalUsername);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    const originalAccount = accounts[key];
    const nextPassword = requestedPassword || (actor === 'AZHA' ? originalAccount.password : '');
    if (!nextPassword) {
        return res.status(400).json({ error: 'Password is required unless AZHA leaves it blank to keep the current one' });
    }
    const candidate = await findAccount(nextUsername);
    if (candidate && candidate.username !== originalAccount.username) {
        return res.status(400).json({ error: 'Username already exists' });
    }

    const messages = await readMessages();
    const balances = await readBalances();
    const renamed = applyAccountRename(accounts, messages, balances, originalAccount.username, nextUsername);
    renamed.accounts[nextUsername] = {
        ...renamed.accounts[nextUsername],
        username: nextUsername,
        password: nextPassword,
        fullName: nextFullName || renamed.accounts[nextUsername].fullName,
        profilePic: req.body.profilePic ?? renamed.accounts[nextUsername].profilePic ?? '',
        browserProfile: req.body.browserProfile ? normalizeBrowserProfile(req.body.browserProfile) : renamed.accounts[nextUsername].browserProfile
    };

    await Promise.all([
        writeAccounts(renamed.accounts),
        writeMessages(renamed.messages),
        writeBalances(renamed.balances)
    ]);

    res.json({ message: 'User updated', username: nextUsername });
}));

app.put('/api/profile', wrap(async (req, res) => {
    const actor = String(req.body.actor || '').trim();
    const nextUsername = String(req.body.username || '').trim();
    const nextPassword = String(req.body.password || '').trim();
    const nextFullName = String(req.body.fullName || '').trim();
    const nextProfilePic = req.body.profilePic ?? '';

    if (!actor) {
        return res.status(400).json({ error: 'Actor is required' });
    }

    if (!nextUsername || !nextPassword || !nextFullName) {
        return res.status(400).json({ error: 'Username, password, and full name are required' });
    }

    const { accounts, key } = await findAccountKey(actor);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    const currentAccount = accounts[key];
    const candidate = await findAccount(nextUsername);
    if (candidate && candidate.username !== currentAccount.username) {
        return res.status(400).json({ error: 'Username already exists' });
    }

    const messages = await readMessages();
    const balances = await readBalances();
    const renamed = applyAccountRename(accounts, messages, balances, currentAccount.username, nextUsername);
    renamed.accounts[nextUsername] = {
        ...renamed.accounts[nextUsername],
        username: nextUsername,
        password: nextPassword,
        fullName: nextFullName,
        profilePic: String(nextProfilePic)
    };

    await Promise.all([
        writeAccounts(renamed.accounts),
        writeMessages(renamed.messages),
        writeBalances(renamed.balances)
    ]);

    res.json({
        message: 'Profile updated',
        username: nextUsername,
        fullName: nextFullName,
        profilePic: String(nextProfilePic),
        isAdmin: renamed.accounts[nextUsername].isAdmin,
        membership: serializeMembership(renamed.accounts[nextUsername].membership),
        featureAccess: {
            messages: membershipHasFeature(renamed.accounts[nextUsername], 'messages'),
            meetings: membershipHasFeature(renamed.accounts[nextUsername], 'meetings'),
            sharedStorage: membershipHasFeature(renamed.accounts[nextUsername], 'shared-storage')
        }
    });
}));

app.delete('/api/users/:username', wrap(async (req, res) => {
    const actor = req.body.actor;
    if (!(await isAdminUser(actor))) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const { accounts, key } = await findAccountKey(req.params.username);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    if (accounts[key].username === 'AZHA') {
        return res.status(400).json({ error: 'Cannot delete AZHA' });
    }

    const targetUsername = accounts[key].username;
    delete accounts[key];
    const balances = await readBalances();
    delete balances[targetUsername];
    const messages = await readMessages();
    const remainingMessages = messages.filter((message) => message.from !== targetUsername && message.to !== targetUsername);

    await Promise.all([
        writeAccounts(accounts),
        writeBalances(balances),
        writeMessages(remainingMessages)
    ]);
    res.json({ message: 'deleted' });
}));

app.post('/api/admin/makeadmin', wrap(async (req, res) => {
    const { actor, username } = req.body;
    if (String(actor || '').trim() !== 'AZHA') {
        return res.status(403).json({ error: 'Only AZHA can give admin access' });
    }

    const { accounts, key } = await findAccountKey(username);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    accounts[key].isAdmin = true;
    await writeAccounts(accounts);
    res.json({ message: 'OK' });
}));

app.post('/api/admin/removeadmin', wrap(async (req, res) => {
    const { actor, username } = req.body;
    if (!(await isAdminUser(actor))) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const actorAccount = await findAccount(actor);
    if (!actorAccount || actorAccount.username !== 'AZHA') {
        return res.status(403).json({ error: 'Only AZHA can remove admin access' });
    }

    const { accounts, key } = await findAccountKey(username);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    if (accounts[key].username === 'AZHA') {
        return res.status(400).json({ error: 'Cannot remove admin from AZHA' });
    }

    accounts[key].isAdmin = false;
    await writeAccounts(accounts);
    res.json({ message: 'OK' });
}));

app.post('/api/admin/warn', wrap(async (req, res) => {
    const { actor, username } = req.body;
    if (!(await isAdminUser(actor))) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const { accounts, key } = await findAccountKey(username);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    accounts[key].warnings = (accounts[key].warnings || 0) + 1;
    await writeAccounts(accounts);
    res.json({ message: 'OK', warnings: accounts[key].warnings });
}));

app.post('/api/admin/ban', wrap(async (req, res) => {
    const { actor, username, action } = req.body;
    if (!(await isAdminUser(actor))) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const { accounts, key } = await findAccountKey(username);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    if (accounts[key].username === 'AZHA' && action !== 'unban') {
        return res.status(400).json({ error: 'Cannot ban AZHA' });
    }

    accounts[key].status = action === 'unban' ? 'active' : 'banned';
    await writeAccounts(accounts);
    res.json({ message: 'OK', status: accounts[key].status });
}));

app.get('/api/balances', wrap(async (req, res) => {
    const username = req.query.username ? String(req.query.username) : '';
    if (username) {
        const account = await findAccount(username);
        if (!account) {
            return res.json({ [username]: username === 'AZHA' ? 'INF' : 0 });
        }
        return res.json({ [username]: await getBalanceForAccount(account) });
    }
    const balances = await readBalances();
    res.json(balances);
}));

app.post('/api/admin/azinc', wrap(async (req, res) => {
    const { actor, username, amount } = req.body;
    if (!(await isAdminUser(actor))) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    if (!username || typeof amount !== 'number' || Number.isNaN(amount)) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const recipient = await findAccount(username);
    if (!recipient) {
        return res.status(404).json({ error: 'User not found' });
    }

    const current = await getBalanceForAccount(recipient);
    const nextBalance = recipient.username === 'AZHA' ? 'INF' : Number(current || 0) + amount;
    await setBalanceForAccount(recipient, nextBalance);
    res.json({ message: 'Balance updated', balance: nextBalance });
}));

app.post('/api/admin/set-balance', wrap(async (req, res) => {
    const actor = String(req.body.actor || '').trim();
    const username = String(req.body.username || '').trim();
    const rawAmount = req.body.amount;
    
    if (!(await isAdminUser(actor))) {
        return res.status(403).json({ error: 'Not authorized' });
    }
    if (actor !== 'AZHA') {
        return res.status(403).json({ error: 'Only AZHA can set exact AZHA balances.' });
    }
    if (!username) {
        return res.status(400).json({ error: 'A username is required.' });
    }
    
    let nextBalance;
    if (rawAmount === 'INF') {
        nextBalance = 'INF';
    } else {
        const amount = Number(rawAmount);
        if (Number.isNaN(amount) || amount < 0) {
            return res.status(400).json({ error: 'A valid balance is required.' });
        }
        nextBalance = Math.floor(amount);
    }
    
    const recipient = await findAccount(username);
    if (!recipient) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    await setBalanceForAccount(recipient, nextBalance);
    res.json({ message: 'AZHA balance set', balance: nextBalance });
}));

app.post('/api/admin/reset-balance', wrap(async (req, res) => {
    const { actor, username } = req.body;
    if (!(await isAdminUser(actor))) {
        return res.status(403).json({ error: 'Not authorized' });
    }

    const recipient = await findAccount(username);
    if (!recipient) {
        return res.status(404).json({ error: 'User not found' });
    }

    const nextBalance = recipient.username === 'AZHA' ? 'INF' : 0;
    await setBalanceForAccount(recipient, nextBalance);
    res.json({ message: 'Balance reset', balance: nextBalance });
}));

app.post('/api/admin/membership/grant', wrap(async (req, res) => {
    const actor = String(req.body.actor || '').trim();
    const username = String(req.body.username || '').trim();
    const planKey = String(req.body.planKey || '').trim().toUpperCase();

    if (actor !== 'AZHA') {
        return res.status(403).json({ error: 'Only AZHA can grant free memberships.' });
    }

    const plan = getMembershipPlan(planKey);
    if (!plan) {
        return res.status(400).json({ error: 'Unknown membership plan' });
    }

    const { accounts, key } = await findAccountKey(username);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    accounts[key].membership = buildMembershipRecord(plan.key, {
        source: 'admin_free',
        grantedBy: actor,
        expiresAt: addYear(new Date()).toISOString(),
        nextRewardAt: new Date().toISOString()
    });

    await writeAccounts(accounts);
    const balances = await readBalances();
    res.json({
        message: `${plan.label} membership granted for free.`,
        account: serializeAccount(accounts[key], balances[accounts[key].username])
    });
}));

app.post('/api/admin/membership/clear', wrap(async (req, res) => {
    const actor = String(req.body.actor || '').trim();
    const username = String(req.body.username || '').trim();

    if (actor !== 'AZHA') {
        return res.status(403).json({ error: 'Only AZHA can remove memberships.' });
    }

    const { accounts, key } = await findAccountKey(username);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    accounts[key].membership = normalizeMembershipRecord({});
    await writeAccounts(accounts);
    const balances = await readBalances();
    res.json({
        message: 'Membership removed.',
        account: serializeAccount(accounts[key], balances[accounts[key].username])
    });
}));

app.post('/api/storage/configure', wrap(async (req, res) => {
    const actor = String(req.body.actor || '').trim();
    const mode = String(req.body.mode || '').trim().toLowerCase();
    const supabaseUrl = String(req.body.supabaseUrl || '').trim();
    const supabaseKey = String(req.body.supabaseKey || '').trim();

    const { accounts, key } = await findAccountKey(actor);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }

    const account = accounts[key];
    if (mode === 'shared') {
        if (!canUseSharedStorage(account)) {
            return res.status(403).json({ error: 'Shared AZHA storage requires an active MAX membership.' });
        }
        account.storagePreference = normalizeStoragePreference({
            mode: 'shared',
            status: 'shared',
            lastCheckedAt: new Date().toISOString(),
            lastError: ''
        });
        await writeAccounts(accounts);
        const balance = await getBalanceForAccount(account);
        return res.json({
            message: 'Shared AZHA storage is now active.',
            account: serializeAccount(account, balance)
        });
    }

    if (mode !== 'supabase') {
        return res.status(400).json({ error: 'Choose shared or supabase storage.' });
    }

    if (!supabaseUrl || !supabaseKey) {
        return res.status(400).json({ error: 'Supabase URL and key are required.' });
    }

    const snapshot = await buildPortableSupabaseSnapshot(account);
    account.storagePreference = normalizeStoragePreference({
        mode: 'supabase',
        supabaseUrl,
        supabaseKey,
        status: 'checking',
        lastCheckedAt: new Date().toISOString(),
        lastError: ''
    });
    await writeSupabaseState(account, snapshot);
    accounts[key] = account;
    await writeAccounts(accounts);
    const balance = await getBalanceForAccount(account);
    res.json({
        message: 'Supabase storage connected and your portable data was copied there.',
        account: serializeAccount(account, balance)
    });
}));

app.get('/api/social/friends', wrap(async (req, res) => {
    const targetUsername = String(req.query.username || '').trim();
    const actorUsername = String(req.query.actor || targetUsername).trim();
    if (!targetUsername) {
        return res.status(400).json({ error: 'Username is required' });
    }
    if (actorUsername !== 'AZHA' && actorUsername.toLowerCase() !== targetUsername.toLowerCase()) {
        return res.status(403).json({ error: 'Only AZHA can inspect another user friend list.' });
    }
    const account = await findAccount(targetUsername);
    if (!account) {
        return res.status(404).json({ error: 'User not found' });
    }

    const friendsData = await readFriendsData();
    const requests = friendsData.requests.map(normalizeFriendRequestRecord).filter((entry) => entry.status === 'pending');
    const friendships = friendsData.friendships.map(normalizeFriendshipRecord).filter((entry) => entry.users.length === 2);
    const lowered = targetUsername.toLowerCase();
    const friendUsernames = friendships
        .filter((friendship) => friendship.users.some((user) => user.toLowerCase() === lowered))
        .map((friendship) => friendship.users.find((user) => user.toLowerCase() !== lowered))
        .filter(Boolean);

    res.json({
        username: account.username,
        presence: effectivePresenceStatus(account),
        lastSeenAt: account.lastSeenAt || '',
        incomingRequests: requests.filter((request) => request.to.toLowerCase() === lowered),
        outgoingRequests: requests.filter((request) => request.from.toLowerCase() === lowered),
        friends: await buildFriendSummaries(friendUsernames, actorUsername)
    });
}));

app.post('/api/social/friends/request', wrap(async (req, res) => {
    const from = String(req.body.from || '').trim();
    const to = String(req.body.to || '').trim();
    if (!from || !to) {
        return res.status(400).json({ error: 'Both users are required.' });
    }
    if (from.toLowerCase() === to.toLowerCase()) {
        return res.status(400).json({ error: 'You cannot friend yourself.' });
    }
    const sender = await findAccount(from);
    const recipient = await findAccount(to);
    if (!sender || !recipient) {
        return res.status(404).json({ error: 'User not found' });
    }

    const friendsData = await readFriendsData();
    const requests = friendsData.requests.map(normalizeFriendRequestRecord);
    const friendships = friendsData.friendships.map(normalizeFriendshipRecord);
    if (areFriends(friendships, sender.username, recipient.username)) {
        return res.status(400).json({ error: 'You are already friends.' });
    }
    const alreadyPending = requests.some((request) => (
        request.status === 'pending' &&
        (
            (request.from.toLowerCase() === sender.username.toLowerCase() && request.to.toLowerCase() === recipient.username.toLowerCase()) ||
            (request.from.toLowerCase() === recipient.username.toLowerCase() && request.to.toLowerCase() === sender.username.toLowerCase())
        )
    ));
    if (alreadyPending) {
        return res.status(400).json({ error: 'A friend request is already pending.' });
    }

    requests.push(normalizeFriendRequestRecord({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        from: sender.username,
        to: recipient.username,
        status: 'pending',
        createdAt: new Date().toISOString()
    }));
    await writeFriendsData({ requests, friendships });
    res.json({ message: 'Friend request sent.' });
}));

app.post('/api/social/friends/accept', wrap(async (req, res) => {
    const actor = String(req.body.actor || '').trim();
    const fromUsername = String(req.body.fromUsername || '').trim();
    const actorAccount = await findAccount(actor);
    const requester = await findAccount(fromUsername);
    if (!actorAccount || !requester) {
        return res.status(404).json({ error: 'User not found' });
    }
    const friendsData = await readFriendsData();
    const requests = friendsData.requests.map(normalizeFriendRequestRecord);
    const friendships = friendsData.friendships.map(normalizeFriendshipRecord);
    const requestIndex = requests.findIndex((request) => (
        request.status === 'pending' &&
        request.from.toLowerCase() === requester.username.toLowerCase() &&
        request.to.toLowerCase() === actorAccount.username.toLowerCase()
    ));
    if (requestIndex === -1) {
        return res.status(404).json({ error: 'Friend request not found.' });
    }
    requests.splice(requestIndex, 1);
    if (!areFriends(friendships, actorAccount.username, requester.username)) {
        friendships.push(normalizeFriendshipRecord({
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            users: [actorAccount.username, requester.username],
            createdAt: new Date().toISOString()
        }));
    }
    await writeFriendsData({ requests, friendships });
    res.json({ message: 'Friend request accepted.' });
}));

app.post('/api/social/friends/reject', wrap(async (req, res) => {
    const actor = String(req.body.actor || '').trim();
    const fromUsername = String(req.body.fromUsername || '').trim();
    const actorAccount = await findAccount(actor);
    const requester = await findAccount(fromUsername);
    if (!actorAccount || !requester) {
        return res.status(404).json({ error: 'User not found' });
    }
    const friendsData = await readFriendsData();
    const requests = friendsData.requests
        .map(normalizeFriendRequestRecord)
        .filter((request) => !(
            request.status === 'pending' &&
            request.from.toLowerCase() === requester.username.toLowerCase() &&
            request.to.toLowerCase() === actorAccount.username.toLowerCase()
        ));
    await writeFriendsData({ requests, friendships: friendsData.friendships.map(normalizeFriendshipRecord) });
    res.json({ message: 'Friend request removed.' });
}));

app.post('/api/social/presence', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const status = String(req.body.status || '').trim().toLowerCase();
    if (!username || !['online', 'busy', 'offline'].includes(status)) {
        return res.status(400).json({ error: 'A valid user and presence status are required.' });
    }
    const { accounts, key } = await findAccountKey(username);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }
    accounts[key].presenceStatus = status;
    accounts[key].lastSeenAt = new Date().toISOString();
    await writeAccounts(accounts);
    res.json({
        message: 'Presence updated.',
        status: effectivePresenceStatus(accounts[key]),
        lastSeenAt: accounts[key].lastSeenAt
    });
}));

app.get('/api/social/chat/:friendUsername', wrap(async (req, res) => {
    const username = String(req.query.username || '').trim();
    const friendUsername = String(req.params.friendUsername || '').trim();
    const account = await findAccount(username);
    const friend = await findAccount(friendUsername);
    if (!account || !friend) {
        return res.status(404).json({ error: 'User not found' });
    }
    const friendsData = await readFriendsData();
    const friendships = friendsData.friendships.map(normalizeFriendshipRecord);
    if (!areFriends(friendships, account.username, friend.username)) {
        return res.status(403).json({ error: 'You must be friends to chat.' });
    }
    const chats = (await readChatsData())
        .map(normalizeChatMessageRecord)
        .filter((message) => friendshipKey(message.from, message.to) === friendshipKey(account.username, friend.username))
        .sort((a, b) => (Date.parse(a.timestamp || '') || 0) - (Date.parse(b.timestamp || '') || 0));
    res.json(chats);
}));

app.post('/api/social/chat', wrap(async (req, res) => {
    const from = String(req.body.from || '').trim();
    const to = String(req.body.to || '').trim();
    const text = String(req.body.text || '').trim();
    if (!from || !to || !text) {
        return res.status(400).json({ error: 'Chat sender, recipient, and text are required.' });
    }
    const sender = await findAccount(from);
    const recipient = await findAccount(to);
    if (!sender || !recipient) {
        return res.status(404).json({ error: 'User not found' });
    }
    const friendsData = await readFriendsData();
    const friendships = friendsData.friendships.map(normalizeFriendshipRecord);
    if (!areFriends(friendships, sender.username, recipient.username)) {
        return res.status(403).json({ error: 'You must be friends to chat.' });
    }
    const chats = (await readChatsData()).map(normalizeChatMessageRecord);
    const chatMessage = normalizeChatMessageRecord({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        from: sender.username,
        to: recipient.username,
        text,
        timestamp: new Date().toISOString(),
        read: false,
        replyTo: req.body.replyTo,
        forwardedFrom: req.body.forwardedFrom
    });
    chats.push(chatMessage);
    await writeChatsData(chats);
    
    // Broadcast message to recipient via WebSocket if they're connected
    const recipientWs = connectedUsers.get(recipient.username);
    if (recipientWs && recipientWs.readyState === WebSocket.OPEN) {
        recipientWs.send(JSON.stringify({
            type: 'chat-message-received',
            from: sender.username,
            to: recipient.username,
            text,
            timestamp: chatMessage.timestamp,
            id: chatMessage.id,
            replyTo: req.body.replyTo || null,
            forwardedFrom: req.body.forwardedFrom || null
        }));
    }
    
    res.json({ message: 'Chat sent.', chat: chatMessage });
}));

app.put('/api/social/chat/:id/read', wrap(async (req, res) => {
    const username = String(req.body.username || '').trim();
    const chats = (await readChatsData()).map(normalizeChatMessageRecord);
    const index = chats.findIndex((chat) => chat.id === req.params.id && chat.to.toLowerCase() === username.toLowerCase());
    if (index === -1) {
        return res.status(404).json({ error: 'Chat message not found.' });
    }
    chats[index].read = true;
    await writeChatsData(chats);
    res.json({ message: 'Chat marked as read.' });
}));

app.get('/api/messages', wrap(async (req, res) => {
    const username = req.query.username;
    if (!username) {
        return res.status(400).json({ error: 'Username required' });
    }

    const account = await findAccount(username);
    if (!account) {
        return res.status(404).json({ error: 'User not found' });
    }
    if (!membershipHasFeature(account, 'messages')) {
        return res.status(403).json({ error: 'Messages are locked. Upgrade to Pro or MAX.' });
    }

    const userMessages = await readMessagesForAccount(account);
    res.json(userMessages);
}));

app.post('/api/messages', wrap(async (req, res) => {
    const { from, to, text, attachments, kind, meta } = req.body;
    const safeText = String(text || '').trim();
    const safeKind = ['message', 'meeting-invite'].includes(String(kind || '')) ? String(kind) : 'message';
    const safeMeta = meta && typeof meta === 'object'
        ? {
            roomCode: String(meta.roomCode || ''),
            title: String(meta.title || ''),
            startsAt: String(meta.startsAt || ''),
            host: String(meta.host || ''),
            note: String(meta.note || ''),
            joinUrl: String(meta.joinUrl || ''),
            replyTo: meta.replyTo && typeof meta.replyTo === 'object'
                ? {
                    id: String(meta.replyTo.id || ''),
                    from: String(meta.replyTo.from || ''),
                    text: String(meta.replyTo.text || '')
                }
                : null,
            forwardedFrom: meta.forwardedFrom && typeof meta.forwardedFrom === 'object'
                ? {
                    id: String(meta.forwardedFrom.id || ''),
                    from: String(meta.forwardedFrom.from || ''),
                    to: String(meta.forwardedFrom.to || ''),
                    text: String(meta.forwardedFrom.text || '')
                }
                : null
        }
        : {};
    const safeAttachments = Array.isArray(attachments)
        ? attachments.slice(0, 4).map((attachment) => ({
            type: ['image', 'video'].includes(String(attachment?.type || '')) ? String(attachment.type) : 'file',
            name: String(attachment?.name || 'attachment'),
            url: String(attachment?.url || '')
        })).filter((attachment) => attachment.url)
        : [];
    if (!from || !to || (!safeText && !safeAttachments.length && safeKind !== 'meeting-invite')) {
        return res.status(400).json({ error: 'Add some text or at least one attachment.' });
    }

    const recipient = await findAccount(to);
    if (!recipient) {
        return res.status(400).json({ error: 'Recipient does not exist' });
    }

    const sender = await findAccount(from);
    if (!sender) {
        return res.status(400).json({ error: 'Sender does not exist' });
    }
    if (!membershipHasFeature(sender, 'messages')) {
        return res.status(403).json({ error: 'Messages are locked. Upgrade to Pro or MAX.' });
    }
    if (safeKind === 'meeting-invite' && !(await canSendMeetingInviteForAccount(sender.username))) {
        return res.status(403).json({ error: 'Only the CEO, organization owners, or organization admins can send meeting invites from an organization account.' });
    }

    const message = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        from: sender.username,
        to: recipient.username,
        text: safeText,
        kind: safeKind,
        meta: safeMeta,
        timestamp: new Date().toISOString(),
        read: false,
        attachments: safeAttachments
    };

    await appendMessageForUsers(message, sender, recipient);
    res.json({ message: 'Message sent successfully', id: message.id });
}));

app.put('/api/messages/:id/read', wrap(async (req, res) => {
    const { id } = req.params;
    const { username } = req.body;
    const lowered = String(username || '').toLowerCase();
    const account = await findAccount(username);
    if (!account) {
        return res.status(404).json({ error: 'User not found' });
    }
    if (!membershipHasFeature(account, 'messages')) {
        return res.status(403).json({ error: 'Messages are locked. Upgrade to Pro or MAX.' });
    }
    const messages = await readMessagesForAccount(account);
    const messageIndex = messages.findIndex((message) => message.id === id && message.to.toLowerCase() === lowered);

    if (messageIndex === -1) {
        return res.status(404).json({ error: 'Message not found' });
    }

    messages[messageIndex].read = true;
    await writeMessagesForAccount(account, messages);
    res.json({ message: 'Message marked as read' });
}));

app.delete('/api/messages/:id', wrap(async (req, res) => {
    const { id } = req.params;
    const lowered = String(req.body.username || '').toLowerCase();
    const account = await findAccount(req.body.username);
    if (!account) {
        return res.status(404).json({ error: 'User not found' });
    }
    if (!membershipHasFeature(account, 'messages')) {
        return res.status(403).json({ error: 'Messages are locked. Upgrade to Pro or MAX.' });
    }
    const messages = await readMessagesForAccount(account);
    const messageIndex = messages.findIndex((message) => message.id === id && (message.to.toLowerCase() === lowered || message.from.toLowerCase() === lowered));

    if (messageIndex === -1) {
        return res.status(404).json({ error: 'Message not found' });
    }

    messages.splice(messageIndex, 1);
    await writeMessagesForAccount(account, messages);
    res.json({ message: 'Message deleted' });
}));

app.get('/api/meetings', wrap(async (req, res) => {
    const username = String(req.query.username || '').trim();
    const account = await findAccount(username);
    if (!account) {
        return res.status(404).json({ error: 'User not found' });
    }
    if (!membershipHasFeature(account, 'meetings')) {
        return res.status(403).json({ error: 'Meetings are locked. Upgrade to MAX.' });
    }
    const meetings = await readMeetingsWithFallback();
    const sorted = meetings.sort((a, b) => {
        const aTime = Date.parse(a.startsAt || '') || 0;
        const bTime = Date.parse(b.startsAt || '') || 0;
        return aTime - bTime;
    });
    res.json(sorted.map((meeting) => {
        const normalizedCode = normalizeRoomCode(meeting.roomCode);
        const room = meetingRooms.get(normalizedCode);
        const participantCount = room ? room.participants.size : 0;
        return {
            ...meeting,
            active: activeRooms.has(normalizedCode) || Boolean(room),
            participantCount
        };
    }));
}));

app.get('/api/debug/meetings', wrap(async (req, res) => {
    const meetings = await readMeetingsWithFallback();
    res.json(meetings.map(m => ({ roomCode: m.roomCode, title: m.title, host: m.host })));
}));

// ============ FRIENDS SYSTEM ============
app.get('/api/friends/:username', wrap(async (req, res) => {
    const { username } = req.params;
    const friends = await storage.readFriends();
    const userFriends = friends.friendships.filter(f => f.user1 === username || f.user2 === username);
    const userRequests = friends.requests.filter(r => r.to === username || r.from === username);
    res.json({ friendships: userFriends, requests: userRequests });
}));

app.post('/api/friends/request', wrap(async (req, res) => {
    const { from, to } = req.body;
    if (!from || !to || from === to) return res.status(400).json({ error: 'Invalid request' });
    const friends = await storage.readFriends();
    const exists = friends.requests.some(r => r.from === from && r.to === to);
    if (exists) return res.status(400).json({ error: 'Request already sent' });
    const request = { from, to, timestamp: new Date().toISOString(), status: 'pending' };
    friends.requests.push(request);
    await storage.writeFriends(friends);
    res.json({ message: 'Friend request sent', request });
}));

app.post('/api/friends/accept', wrap(async (req, res) => {
    const { from, to } = req.body;
    const friends = await storage.readFriends();
    const reqIndex = friends.requests.findIndex(r => r.from === from && r.to === to);
    if (reqIndex === -1) return res.status(404).json({ error: 'Request not found' });
    friends.requests.splice(reqIndex, 1);
    friends.friendships.push({ user1: from, user2: to, timestamp: new Date().toISOString() });
    await storage.writeFriends(friends);
    res.json({ message: 'Friend request accepted' });
}));

app.post('/api/friends/reject', wrap(async (req, res) => {
    const { from, to } = req.body;
    const friends = await storage.readFriends();
    const reqIndex = friends.requests.findIndex(r => r.from === from && r.to === to);
    if (reqIndex === -1) return res.status(404).json({ error: 'Request not found' });
    friends.requests.splice(reqIndex, 1);
    await storage.writeFriends(friends);
    res.json({ message: 'Friend request rejected' });
}));

// ============ DAILY REWARDS SYSTEM ============
app.post('/api/claim-daily-reward', wrap(async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username required' });
    
    const account = await findAccount(username);
    if (!account) return res.status(404).json({ error: 'User not found' });
    
    const now = new Date();
    const lastClaimTime = account.lastDailyRewardClaimAt ? new Date(account.lastDailyRewardClaimAt).getTime() : 0;
    const timeSinceLastClaim = now.getTime() - lastClaimTime;
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    
    if (timeSinceLastClaim < TWENTY_FOUR_HOURS) {
        const nextClaimTime = new Date(lastClaimTime + TWENTY_FOUR_HOURS);
        return res.status(429).json({ 
            error: `Already claimed today. Next claim available at ${nextClaimTime.toLocaleTimeString()}`,
            nextClaimAt: nextClaimTime.toISOString()
        });
    }
    
    // Determine reward amount based on membership
    let rewardAmount = 15; // Default for no membership
    if (account.membership && account.membership.status === 'active' && account.membership.expiresAt && new Date(account.membership.expiresAt).getTime() > now.getTime()) {
        const planKey = String(account.membership.planKey || '').toUpperCase();
        const dailyRewards = {
            'PLUS': 35,
            'PRO': 1555,
            'AZHA': 99999999999999999
        };
        rewardAmount = dailyRewards[planKey] || 15;
    }
    
    // Cap daily reward at max
    const MAX_DAILY_REWARD = 99999999999999999;
    rewardAmount = Math.min(rewardAmount, MAX_DAILY_REWARD);
    
    // Update account with claim time
    account.lastDailyRewardClaimAt = now.toISOString();
    
    // Update balance
    const balances = await storage.readBalances();
    const currentBalance = balances[username] === 'INF' ? Infinity : Number(balances[username] || 0);
    balances[username] = currentBalance === Infinity ? 'INF' : Math.min(currentBalance + rewardAmount, MAX_DAILY_REWARD);
    
    // Save updates
    await storage.writeBalances(balances);
    const accounts = await storage.readAccounts();
    accounts[username] = account;
    await storage.writeAccounts(accounts);
    
    res.json({ 
        message: 'Daily reward claimed',
        rewardAmount,
        newBalance: balances[username],
        membershipLevel: account.membership?.planKey || 'None'
    });
}));

// ============ ANNOUNCEMENTS SYSTEM ============
app.get('/api/announcements', wrap(async (req, res) => {
    const announcements = await storage.readAnnouncements();
    const active = announcements.announcements.filter(a => !a.archived);
    res.json(active.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
}));

app.post('/api/announcements', wrap(async (req, res) => {
    const { username, title, content, image } = req.body;
    const account = await findAccount(username);
    if (!account || (!account.isAdmin && username !== 'AZHA')) {
        return res.status(403).json({ error: 'Only admins can create announcements' });
    }
    const announcements = await storage.readAnnouncements();
    const announcement = {
        id: Date.now().toString(36),
        title: String(title || ''),
        content: String(content || ''),
        image: String(image || ''),
        createdBy: username,
        timestamp: new Date().toISOString(),
        status: username === 'AZHA' ? 'approved' : 'pending',
        replies: [],
        archived: false
    };
    if (username === 'AZHA') {
        announcements.announcements.push(announcement);
    } else {
        announcements.pending.push(announcement);
    }
    await storage.writeAnnouncements(announcements);
    res.json({ message: 'Announcement created', announcement });
}));

app.post('/api/announcements/:id/reply', wrap(async (req, res) => {
    const { username, text } = req.body;
    const { id } = req.params;
    const announcements = await storage.readAnnouncements();
    const announcement = announcements.announcements.find(a => a.id === id);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
    announcement.replies.push({
        username,
        text,
        timestamp: new Date().toISOString()
    });
    await storage.writeAnnouncements(announcements);
    res.json({ message: 'Reply added' });
}));

app.post('/api/announcements/:id/approve', wrap(async (req, res) => {
    const { username } = req.body;
    const { id } = req.params;
    if (username !== 'AZHA') return res.status(403).json({ error: 'Only CEO can approve' });
    const announcements = await storage.readAnnouncements();
    const pending = announcements.pending.find(a => a.id === id);
    if (!pending) return res.status(404).json({ error: 'Announcement not found' });
    pending.status = 'approved';
    const index = announcements.pending.indexOf(pending);
    announcements.pending.splice(index, 1);
    announcements.announcements.push(pending);
    await storage.writeAnnouncements(announcements);
    res.json({ message: 'Announcement approved' });
}));

app.post('/api/announcements/:id/edit', wrap(async (req, res) => {
    const { username, title, content, image } = req.body;
    const { id } = req.params;
    const announcements = await storage.readAnnouncements();
    const announcement = announcements.announcements.find(a => a.id === id);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
    if (announcement.createdBy !== username && username !== 'AZHA') {
        return res.status(403).json({ error: 'Only creator or CEO can edit' });
    }
    announcement.title = String(title || announcement.title);
    announcement.content = String(content || announcement.content);
    if (Object.prototype.hasOwnProperty.call(req.body, 'image')) {
        announcement.image = String(image || '');
    }
    announcement.editedAt = new Date().toISOString();
    await storage.writeAnnouncements(announcements);
    res.json({ message: 'Announcement updated', announcement });
}));

// ============ ITEMS/SHOP SYSTEM ============
app.get('/api/items', wrap(async (req, res) => {
    const items = await storage.readItems();
    const active = items.items.filter(i => !i.archived && new Date(i.releaseDate) <= new Date(Date.now() + 1000));
    res.json(active);
}));

app.post('/api/items', wrap(async (req, res) => {
    const { username, name, rarity, price, image } = req.body;
    const account = await findAccount(username);
    if (!account || (!account.isAdmin && username !== 'AZHA')) {
        return res.status(403).json({ error: 'Only admins can create items' });
    }
    const items = await storage.readItems();
    
    // Handle both number and 'INF' string prices
    const finalPrice = price === 'INF' ? 'INF' : Number(price || 0);
    
    const item = {
        id: Date.now().toString(36),
        name: String(name || ''),
        rarity: String(rarity || 'common'),
        price: finalPrice,
        image: String(image || ''),
        createdBy: username,
        releaseDate: new Date().toISOString(),
        archived: false
    };
    items.items.push(item);
    await storage.writeItems(items);
    res.json({ message: 'Item created', item });
}));

app.post('/api/items/buy', wrap(async (req, res) => {
    const { username, itemId } = req.body;
    const account = await findAccount(username);
    if (!account) return res.status(404).json({ error: 'User not found' });
    const items = await storage.readItems();
    const item = items.items.find(i => i.id === itemId);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    
    const balances = await storage.readBalances();
    const userBalance = balances[username] === 'INF' ? Infinity : Number(balances[username] || 0);
    
    // Allow CEO/infinite balance users to buy infinite-cost items
    if (item.price === 'INF') {
        if (userBalance !== Infinity && username !== 'AZHA') {
            return res.status(400).json({ error: 'Insufficient balance to buy infinite-cost item' });
        }
    } else if (userBalance < item.price) {
        return res.status(400).json({ error: 'Insufficient balance' });
    }
    
    // Only deduct from balance if price is not infinite
    if (item.price !== 'INF') {
        balances[username] = userBalance === Infinity ? 'INF' : (userBalance - item.price);
        balances['AZHA'] = (balances['AZHA'] === 'INF' ? 'INF' : (Number(balances['AZHA'] || 0) + item.price));
    }
    
    await storage.writeBalances(balances);
    if (!account.inventory) account.inventory = [];
    account.inventory.push({ itemId, purchasedAt: new Date().toISOString() });
    const accounts = await storage.readAccounts();
    accounts[username] = account;
    await storage.writeAccounts(accounts);
    res.json({ message: 'Item purchased', itemName: item.name });
}));

// ============ CLUBS SYSTEM ============
function normalizeClubRecord(club = {}) {
    const owner = String(club?.owner || club?.admin || '').trim();
    const admin = String(club?.admin || owner || '').trim();
    const admins = Array.isArray(club?.admins)
        ? club.admins.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const members = Array.isArray(club?.members)
        ? club.members.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const uniqueAdmins = Array.from(new Set([owner, admin, ...admins].filter(Boolean)));
    const uniqueMembers = Array.from(new Set([owner, admin, ...uniqueAdmins, ...members].filter(Boolean)));
    return {
        id: String(club?.id || Date.now().toString(36)),
        name: String(club?.name || '').trim(),
        description: String(club?.description || '').trim(),
        icon: String(club?.icon || '').trim(),
        owner: owner || uniqueAdmins[0] || '',
        admin: admin || uniqueAdmins[0] || '',
        admins: uniqueAdmins.length ? uniqueAdmins : (owner ? [owner] : (admin ? [admin] : [])),
        members: uniqueMembers,
        messages: Array.isArray(club?.messages) ? club.messages : [],
        bannedUsers: Array.isArray(club?.bannedUsers) ? club.bannedUsers.map((value) => String(value || '').trim()).filter(Boolean) : [],
        joinType: ['request', 'open'].includes(String(club?.joinType || '').toLowerCase()) ? String(club.joinType).toLowerCase() : 'request',
        joinRequests: Array.isArray(club?.joinRequests) ? club.joinRequests : [],
        announcements: Array.isArray(club?.announcements) ? club.announcements : [],
        isPrivate: Boolean(club?.isPrivate),
        createdAt: String(club?.createdAt || new Date().toISOString())
    };
}

function sameUsername(left, right) {
    return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

function getClubOwner(club) {
    const normalized = normalizeClubRecord(club);
    return String(normalized.owner || normalized.admin || '').trim();
}

function getClubAdminList(club) {
    const normalized = normalizeClubRecord(club);
    return Array.from(new Set([normalized.owner, normalized.admin, ...normalized.admins].filter(Boolean)));
}

function isClubOwner(club, username) {
    const lowered = String(username || '').trim().toLowerCase();
    if (!lowered) return false;
    return sameUsername(getClubOwner(club), lowered);
}

function isClubAdminUser(club, username) {
    const lowered = String(username || '').trim().toLowerCase();
    if (!lowered) return false;
    if (lowered === 'azha') return true;
    return getClubAdminList(club).some((value) => sameUsername(value, lowered));
}

function canManageClub(club, username) {
    const lowered = String(username || '').trim().toLowerCase();
    if (!lowered) return false;
    if (lowered === 'azha') return true;
    return isClubOwner(club, username) || isClubAdminUser(club, username);
}

function isClubVisibleToUser(club, username) {
    const normalized = normalizeClubRecord(club);
    if (!normalized.isPrivate) return true;
    if (String(username || '').trim().toLowerCase() === 'azha') return true;
    const lowered = String(username || '').trim().toLowerCase();
    return normalized.members.some((member) => sameUsername(member, lowered)) || isClubAdminUser(normalized, username);
}

app.get('/api/clubs', wrap(async (req, res) => {
    const { username } = req.query;
    const clubs = await storage.readClubs();
    
    const allClubs = (clubs.clubs || [])
        .map(normalizeClubRecord)
        .filter((club) => isClubVisibleToUser(club, String(username || '').trim()))
        .map((club) => ({
            ...club,
            isMember: club.members.some((member) => sameUsername(member, username)),
            isAdmin: isClubAdminUser(club, username),
            joinRequested: (club.joinRequests || []).some((request) => sameUsername(request.username, username))
        }));
    
    res.json(allClubs);
}));

app.post('/api/clubs', wrap(async (req, res) => {
    const { username, name, description, icon, joinType, isPrivate } = req.body;
    if (!String(username || '').trim()) {
        return res.status(400).json({ error: 'A username is required to create a club.' });
    }
    const clubs = await storage.readClubs();
    const cleanedName = String(name || '').trim();
    if (!cleanedName) {
        return res.status(400).json({ error: 'Club name is required.' });
    }
    const club = normalizeClubRecord({
        id: Date.now().toString(36),
        name: cleanedName,
        description: String(description || ''),
        icon: String(icon || ''),
        owner: username,
        admin: username,
        admins: [username],
        members: [username],
        messages: [],
        bannedUsers: [],
        joinType: String(joinType || 'request'),
        joinRequests: [],
        announcements: [],
        isPrivate: Boolean(isPrivate),
        createdAt: new Date().toISOString()
    });
    clubs.clubs.push(club);
    await storage.writeClubs(clubs);
    res.json({ message: 'Club created', club });
}));

app.post('/api/clubs/:id/join', wrap(async (req, res) => {
    const { username } = req.body;
    const { id } = req.params;
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    if (club.bannedUsers.includes(username)) return res.status(403).json({ error: 'You are banned' });
    if (club.members.includes(username)) return res.status(400).json({ error: 'Already in club' });
    
    if (club.joinType === 'open') {
        club.members.push(username);
        await storage.writeClubs(clubs);
        return res.json({ message: 'Joined club' });
    }
    
    // Request to join (joinType === 'request')
    if (!club.joinRequests) club.joinRequests = [];
    if (club.joinRequests.some(r => r.username === username)) {
        return res.status(400).json({ error: 'Join request already pending' });
    }
    
    club.joinRequests.push({
        username,
        requestedAt: new Date().toISOString()
    });
    
    await storage.writeClubs(clubs);
    res.json({ message: 'Join request sent' });
}));

app.post('/api/clubs/:id/leave', wrap(async (req, res) => {
    const { username } = req.body;
    const { id } = req.params;
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    if (sameUsername(getClubOwner(club), username)) {
        return res.status(403).json({ error: 'Transfer club ownership before leaving. You cannot leave as the club owner.' });
    }
    club.members = club.members.filter((member) => !sameUsername(member, username));
    club.admins = club.admins.filter((member) => !sameUsername(member, username));
    await storage.writeClubs(clubs);
    res.json({ message: 'Left club' });
}));

app.post('/api/clubs/:id/remove-member', wrap(async (req, res) => {
    const { username, targetUsername } = req.body;
    const { id } = req.params;
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    if (!canManageClub(club, username)) {
        return res.status(403).json({ error: 'Only the club owner or a club admin can remove members.' });
    }
    if (sameUsername(getClubOwner(club), targetUsername) && !sameUsername(username, 'AZHA')) {
        return res.status(403).json({ error: 'The club owner cannot be removed unless the CEO transfers ownership.' });
    }
    club.members = club.members.filter((member) => !sameUsername(member, targetUsername));
    club.admins = club.admins.filter((member) => !sameUsername(member, targetUsername));
    if (sameUsername(getClubOwner(club), targetUsername) && sameUsername(username, 'AZHA')) {
        club.owner = 'AZHA';
    }
    await storage.writeClubs(clubs);
    res.json({ message: 'Member removed from club' });
}));

app.post('/api/clubs/:id/make-admin', wrap(async (req, res) => {
    const { username, targetUsername } = req.body;
    const { id } = req.params;
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    if (!canManageClub(club, username)) {
        return res.status(403).json({ error: 'Only the club owner or a club admin can add admins.' });
    }
    if (!club.members.some((member) => sameUsername(member, targetUsername))) {
        return res.status(400).json({ error: 'User must be a member before becoming admin.' });
    }
    club.admins = Array.from(new Set([...(club.admins || []), targetUsername].filter(Boolean)));
    if (!club.owner) {
        club.owner = targetUsername;
    }
    await storage.writeClubs(clubs);
    res.json({ message: 'Club admin added', club: normalizeClubRecord(club) });
}));

app.post('/api/clubs/:id/revoke-admin', wrap(async (req, res) => {
    const { username, targetUsername } = req.body;
    const { id } = req.params;
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    if (!canManageClub(club, username)) {
        return res.status(403).json({ error: 'Only the club owner or the CEO can remove club admins.' });
    }
    if (sameUsername(getClubOwner(club), targetUsername)) {
        return res.status(403).json({ error: 'The club owner cannot be demoted from ownership.' });
    }
    club.admins = (club.admins || []).filter((member) => !sameUsername(member, targetUsername));
    await storage.writeClubs(clubs);
    res.json({ message: 'Club admin removed', club: normalizeClubRecord(club) });
}));

app.post('/api/clubs/:id/transfer-owner', wrap(async (req, res) => {
    const { username, targetUsername } = req.body;
    const { id } = req.params;
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    if (username !== 'AZHA' && !sameUsername(getClubOwner(club), username)) {
        return res.status(403).json({ error: 'Only the club owner or the CEO can transfer ownership.' });
    }
    const target = String(targetUsername || '').trim();
    if (!target) {
        return res.status(400).json({ error: 'Target username is required.' });
    }
    if (sameUsername(username, 'AZHA') && sameUsername(target, 'AZHA')) {
        club.owner = 'AZHA';
        club.admins = Array.from(new Set([...(club.admins || []), 'AZHA']));
        if (!club.members.some((member) => sameUsername(member, 'AZHA'))) {
            club.members.push('AZHA');
        }
        await storage.writeClubs(clubs);
        return res.json({ message: 'CEO ownership assigned to this club', club: normalizeClubRecord(club) });
    }
    if (!club.members.some((member) => sameUsername(member, target))) {
        return res.status(400).json({ error: 'Target must be a member of the club.' });
    }
    club.owner = target;
    club.admins = Array.from(new Set([...(club.admins || []), target].filter(Boolean)));
    await storage.writeClubs(clubs);
    res.json({ message: 'Club ownership transferred', club: normalizeClubRecord(club) });
}));

app.post('/api/clubs/:id/ban', wrap(async (req, res) => {
    const { username, targetUser } = req.body;
    const { id } = req.params;
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    if (String(targetUser || '').trim().toLowerCase() === 'azha' && String(username || '').trim().toLowerCase() !== 'azha') {
        return res.status(403).json({ error: 'Club admins cannot ban AZHA.' });
    }
    if (!canManageClub(club, username)) {
        return res.status(403).json({ error: 'Only the club owner or a club admin can ban members.' });
    }
    if (!club.bannedUsers.includes(targetUser)) {
        club.bannedUsers.push(targetUser);
    }
    club.members = club.members.filter((member) => !sameUsername(member, targetUser));
    club.admins = club.admins.filter((member) => !sameUsername(member, targetUser));
    if (sameUsername(getClubOwner(club), targetUser) && sameUsername(username, 'AZHA')) {
        club.owner = 'AZHA';
    }
    await storage.writeClubs(clubs);
    res.json({ message: 'User banned' });
}));

app.post('/api/clubs/:id/message', wrap(async (req, res) => {
    const { username, text } = req.body;
    const { id } = req.params;
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    if (!club.members.includes(username)) return res.status(403).json({ error: 'Not a member' });
    club.messages.push({
        id: Date.now().toString(36),
        username,
        text,
        timestamp: new Date().toISOString()
    });
    await storage.writeClubs(clubs);
    res.json({ message: 'Message sent' });
}));

// ============ CLUB JOIN REQUESTS ============
app.post('/api/clubs/:id/join-request/:username/accept', wrap(async (req, res) => {
    const { id, username } = req.params;
    const { actor } = req.body;
    
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    
    if (!canManageClub(club, actor)) {
        return res.status(403).json({ error: 'Only the club owner or a club admin can accept join requests' });
    }
    
    if (!club.joinRequests) club.joinRequests = [];
    const reqIndex = club.joinRequests.findIndex(r => r.username === username);
    if (reqIndex === -1) return res.status(404).json({ error: 'Join request not found' });
    
    club.joinRequests.splice(reqIndex, 1);
    if (!club.members.includes(username)) {
        club.members.push(username);
    }
    
    await storage.writeClubs(clubs);
    res.json({ message: 'Join request accepted' });
}));

app.post('/api/clubs/:id/join-request/:username/reject', wrap(async (req, res) => {
    const { id, username } = req.params;
    const { actor } = req.body;
    
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    
    if (!canManageClub(club, actor)) {
        return res.status(403).json({ error: 'Only the club owner or a club admin can reject join requests' });
    }
    
    if (!club.joinRequests) club.joinRequests = [];
    const reqIndex = club.joinRequests.findIndex(r => r.username === username);
    if (reqIndex === -1) return res.status(404).json({ error: 'Join request not found' });
    
    club.joinRequests.splice(reqIndex, 1);
    await storage.writeClubs(clubs);
    res.json({ message: 'Join request rejected' });
}));

// ============ CLUB SETTINGS & INVITATIONS ============
app.put('/api/clubs/:id/settings', wrap(async (req, res) => {
    const { id } = req.params;
    const { actor, joinType, isPrivate } = req.body;
    
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    
    if (!canManageClub(club, actor)) {
        return res.status(403).json({ error: 'Only the club owner, club admins, or the CEO can change club settings' });
    }
    
    if (joinType && ['request', 'open'].includes(joinType)) {
        club.joinType = joinType;
    }
    if (typeof isPrivate === 'boolean') {
        club.isPrivate = isPrivate;
    }
    
    await storage.writeClubs(clubs);
    res.json({ message: 'Club settings updated', club });
}));

app.post('/api/clubs/:id/invite', wrap(async (req, res) => {
    const { id } = req.params;
    const { actor, targetUsername } = req.body;
    
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    
    if (!canManageClub(club, actor)) {
        return res.status(403).json({ error: 'Only the club owner or a club admin can invite members' });
    }
    
    if (club.members.includes(targetUsername)) {
        return res.status(400).json({ error: 'Already a member' });
    }
    
    if (club.bannedUsers.includes(targetUsername)) {
        return res.status(403).json({ error: 'User is banned from this club' });
    }
    
    club.members.push(targetUsername);
    await storage.writeClubs(clubs);
    res.json({ message: 'Member invited and added', club });
}));

// ============ CLUB ANNOUNCEMENTS ============
app.get('/api/clubs/:id/announcements', wrap(async (req, res) => {
    const { id } = req.params;
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    res.json(club.announcements || []);
}));

app.post('/api/clubs/:id/announcements', wrap(async (req, res) => {
    const { id } = req.params;
    const { username, title, content, image } = req.body;
    
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    
    if (!canManageClub(club, username)) {
        return res.status(403).json({ error: 'Only the club owner, club admins, or the CEO can post announcements' });
    }
    
    if (!club.announcements) club.announcements = [];
    
    const announcement = {
        id: Date.now().toString(36),
        username,
        title: String(title || '').trim(),
        content: String(content || '').trim(),
        image: String(image || '').trim(),
        createdAt: new Date().toISOString(),
        replies: []
    };
    
    club.announcements.push(announcement);
    await storage.writeClubs(clubs);
    res.json({ message: 'Announcement posted', announcement });
}));

app.post('/api/clubs/:id/announcements/:announcementId/reply', wrap(async (req, res) => {
    const { id, announcementId } = req.params;
    const { username, text } = req.body;
    
    const clubs = await storage.readClubs();
    const club = clubs.clubs.find(c => c.id === id);
    if (!club) return res.status(404).json({ error: 'Club not found' });
    
    if (!club.members.includes(username)) {
        return res.status(403).json({ error: 'Only club members can reply' });
    }
    
    if (!club.announcements) club.announcements = [];
    const announcement = club.announcements.find(a => a.id === announcementId);
    if (!announcement) return res.status(404).json({ error: 'Announcement not found' });
    
    if (!announcement.replies) announcement.replies = [];
    
    const reply = {
        id: Date.now().toString(36),
        username,
        text: String(text || '').trim(),
        createdAt: new Date().toISOString()
    };
    
    announcement.replies.push(reply);
    await storage.writeClubs(clubs);
    res.json({ message: 'Reply posted', reply });
}));

// ============ TRADING & GIFTING ============
app.post('/api/trade/send', wrap(async (req, res) => {
    const { from, to, items, azha } = req.body;
    const trades = await storage.readTrades();
    const trade = {
        id: Date.now().toString(36),
        from,
        to,
        items: items || [],
        azha: Number(azha || 0),
        status: 'pending',
        createdAt: new Date().toISOString()
    };
    trades.trades.push(trade);
    await storage.writeTrades(trades);
    res.json({ message: 'Trade sent', trade });
}));

app.post('/api/trade/accept', wrap(async (req, res) => {
    const { tradeId, username } = req.body;
    const trades = await storage.readTrades();
    const trade = trades.trades.find(t => t.id === tradeId);
    if (!trade) return res.status(404).json({ error: 'Trade not found' });
    if (trade.to !== username) return res.status(403).json({ error: 'Not your trade' });
    trade.status = 'accepted';
    const balances = await storage.readBalances();
    balances[trade.from] = (Number(balances[trade.from] || 0) - trade.azha);
    balances[trade.to] = (Number(balances[trade.to] || 0) + trade.azha);
    await storage.writeTrades(trades);
    await storage.writeBalances(balances);
    res.json({ message: 'Trade accepted' });
}));

app.post('/api/gift/send', wrap(async (req, res) => {
    const { from, to, itemId, message } = req.body;
    const trades = await storage.readTrades();
    const gift = {
        id: Date.now().toString(36),
        from,
        to,
        itemId,
        message: String(message || ''),
        status: 'sent',
        createdAt: new Date().toISOString()
    };
    trades.gifts.push(gift);
    await storage.writeTrades(trades);
    res.json({ message: 'Gift sent', gift });
}));

// ============ NOTIFICATIONS ============
app.get('/api/notifications/:username', wrap(async (req, res) => {
    const { username } = req.params;
    const notifications = await storage.readNotifications();
    const userNotifications = notifications.notifications.filter(n => n.to === username);
    res.json(userNotifications.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)));
}));

app.post('/api/notifications', wrap(async (req, res) => {
    const { to, type, title, message, data } = req.body;
    const notifications = await storage.readNotifications();
    const notification = {
        id: Date.now().toString(36),
        to,
        type: String(type || ''),
        title: String(title || ''),
        message: String(message || ''),
        data: data || {},
        timestamp: new Date().toISOString(),
        read: false
    };
    notifications.notifications.push(notification);
    await storage.writeNotifications(notifications);
    res.json({ message: 'Notification created' });
}));

app.put('/api/notifications/:id/read', wrap(async (req, res) => {
    const { id } = req.params;
    const notifications = await storage.readNotifications();
    const notification = notifications.notifications.find(n => n.id === id);
    if (!notification) return res.status(404).json({ error: 'Notification not found' });
    notification.read = true;
    await storage.writeNotifications(notifications);
    res.json({ message: 'Notification marked as read' });
}));

// ============ CEO CONTROLS ============
app.post('/api/ceo/meetings/:roomCode/end', wrap(async (req, res) => {
    const { username } = req.body;
    const { roomCode } = req.params;
    if (username !== 'AZHA') return res.status(403).json({ error: 'Only CEO can end meetings' });
    const meetings = await readMeetingsWithFallback();
    const meeting = meetings.find(m => m.roomCode === roomCode);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    meeting.endedAt = new Date().toISOString();
    meeting.active = false;
    await writeMeetingsWithFallback(meetings);
    const room = meetingRooms.get(normalizeRoomCode(roomCode));
    if (room) {
        room.participants.forEach(participant => {
            participant.ws?.close();
        });
        meetingRooms.delete(normalizeRoomCode(roomCode));
    }
    res.json({ message: 'Meeting ended' });
}));

app.get('/api/ceo/meetings', wrap(async (req, res) => {
    const { username } = req.query;
    if (username !== 'AZHA') return res.status(403).json({ error: 'Only CEO can view all meetings' });
    const meetings = await readMeetingsWithFallback();
    res.json(meetings);
}));

app.get('/api/ceo/clubs', wrap(async (req, res) => {
    const { username } = req.query;
    if (username !== 'AZHA') return res.status(403).json({ error: 'Only CEO can view all clubs' });
    const clubs = await storage.readClubs();
    res.json(clubs.clubs);
}));

app.post('/api/ceo/join-invisible', wrap(async (req, res) => {
    const { username, roomCode } = req.body;
    if (username !== 'AZHA') return res.status(403).json({ error: 'Only CEO can join invisibly' });
    const meetings = await readMeetingsWithFallback();
    const meeting = meetings.find(m => m.roomCode === roomCode);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    res.json({ message: 'CEO joined invisibly', roomCode, joinToken: crypto.randomUUID() });
}));

// ============ RARITIES ============
app.get('/api/rarities', wrap(async (req, res) => {
    const rarities = await storage.readRarities();
    res.json(rarities.rarities);
}));

app.post('/api/rarities', wrap(async (req, res) => {
    const { username, name, color, dropRate } = req.body;
    if (username !== 'AZHA') return res.status(403).json({ error: 'Only CEO can create rarities' });
    const rarities = await storage.readRarities();
    const rarity = {
        id: Date.now().toString(36),
        name: String(name || ''),
        color: String(color || '#808080'),
        dropRate: Number(dropRate || 0)
    };
    rarities.rarities.push(rarity);
    await storage.writeRarities(rarities);
    res.json({ message: 'Rarity created', rarity });
}));

// ============ USER STATUS ============
app.post('/api/user/status', wrap(async (req, res) => {
    const { username, status } = req.body;
    if (!['online', 'offline', 'busy'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const accounts = await storage.readAccounts();
    const account = accounts[username];
    if (!account) return res.status(404).json({ error: 'User not found' });
    account.currentStatus = status;
    account.lastStatusChange = new Date().toISOString();
    await storage.writeAccounts(accounts);
    res.json({ message: 'Status updated' });
}));

// ============ MEETING HOST CONTROLS FIX ============
app.post('/api/meetings/:roomCode/host', wrap(async (req, res) => {
    const { username } = req.body;
    const { roomCode } = req.params;
    const meetings = await readMeetingsWithFallback();
    const meeting = meetings.find(m => m.roomCode === roomCode);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (meeting.host !== username && username !== 'AZHA') {
        return res.status(403).json({ error: 'Only host can perform this action' });
    }
    res.json({ message: 'Host access granted', isHost: true });
}));

app.post('/api/meetings', wrap(async (req, res) => {
    const { title, roomCode, startsAt, note, host, durationMinutes, recordingEnabled, hostControls } = req.body;
    if (!host || !startsAt) {
        return res.status(400).json({ error: 'Host and start time are required' });
    }

    const hostAccount = await findAccount(host);
    if (!hostAccount) {
        return res.status(400).json({ error: 'Host account does not exist' });
    }
    if (!membershipHasFeature(hostAccount, 'meetings')) {
        return res.status(403).json({ error: 'Meetings are locked. Upgrade to MAX.' });
    }

    const meetingStart = new Date(startsAt);
    if (Number.isNaN(meetingStart.getTime())) {
        return res.status(400).json({ error: 'Start time is invalid' });
    }

    const meetings = await readMeetingsWithFallback();
    const safeCode = normalizeRoomCode(roomCode) || createMeetingCode(hostAccount.username, title);
    if (meetings.some((meeting) => meeting.roomCode === safeCode)) {
        return res.status(400).json({ error: 'That room code is already being used' });
    }

    const meeting = normalizeMeetingRecord({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
        title: String(title || 'AZHA Meeting').trim() || 'AZHA Meeting',
        roomCode: safeCode,
        host: hostAccount.username,
        startsAt: meetingStart.toISOString(),
        note: String(note || '').trim(),
        createdAt: new Date().toISOString(),
        status: 'scheduled',
        durationMinutes: durationMinutes === null ? null : (durationMinutes ? Number(durationMinutes) : null),
        recordingEnabled: Boolean(recordingEnabled),
        hostControls: hostControls || undefined,
        recordings: []
    });

    meetings.push(meeting);
    await writeMeetingsWithFallback(meetings);
    res.json(meeting);
}));

app.delete('/api/meetings/:id', wrap(async (req, res) => {
    const actor = String(req.body.actor || '');
    const meetings = await readMeetings();
    const meetingIndex = meetings.findIndex((meeting) => meeting.id === req.params.id);
    if (meetingIndex === -1) {
        return res.status(404).json({ error: 'Meeting not found' });
    }

    const meeting = meetings[meetingIndex];
    const isCeo = actor === 'AZHA';
    if (meeting.host !== actor && !isCeo) {
        return res.status(403).json({ error: 'Not allowed to delete this meeting' });
    }

    meetings.splice(meetingIndex, 1);
    await writeMeetingsWithFallback(meetings);
    res.json({ message: 'Meeting deleted' });
}));

app.get('/api/meeting/:roomCode', wrap(async (req, res) => {
    const username = String(req.query.username || '').trim();
    const account = await findAccount(username);
    if (!account) {
        return res.status(404).json({ error: 'User not found' });
    }
    if (!membershipHasFeature(account, 'meetings')) {
        return res.status(403).json({ error: 'Meetings are locked. Upgrade to MAX.' });
    }
    const inputCode = String(req.params.roomCode || '').trim();
    const roomCode = normalizeRoomCode(inputCode);
    const room = meetingRooms.get(roomCode);
    const isRoomActive = activeRooms.has(roomCode);
    
    // Check if meeting exists in database OR has active connections
    const meetings = await readMeetingsWithFallback();
    const meetingExists = meetings.some((m) => normalizeRoomCode(m.roomCode) === roomCode);
    
    // A meeting exists if:
    // 1. It's scheduled in the database, OR
    // 2. It has active participants on this instance, OR
    // 3. It was recently created for on-demand joining
    const shouldExist = meetingExists || isRoomActive || room;
    
    if (!room && !isRoomActive && !meetingExists) {
        const validFormat = /^[a-z0-9-]+$/.test(roomCode) && roomCode.length > 0;
        if (validFormat) {
            const liveMeeting = normalizeMeetingRecord({
                id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
                title: `${account.username} AZHA Meeting`,
                roomCode,
                host: account.username,
                startsAt: new Date().toISOString(),
                note: '',
                createdAt: new Date().toISOString(),
                status: 'live'
            });
            meetings.push(liveMeeting);
            await writeMeetingsWithFallback(meetings);
            getMeetingRoom(roomCode);
            const participants = [];
            return res.json({
                roomCode,
                active: false,
                exists: true,
                participants,
                participantCount: 0,
                host: account.username,
                hostControls: liveMeeting.hostControls
            });
        }
        return res.json({ 
            roomCode, 
            active: false, 
            exists: false,
            participants: [],
            participantCount: 0 
        });
    }

    const participants = room ? Array.from(room.participants.keys()) : [];
    const existingMeeting = meetings.find((meeting) => normalizeRoomCode(meeting.roomCode) === roomCode);
    res.json({
        roomCode,
        active: Boolean(room || isRoomActive),
        exists: shouldExist,
        participants,
        participantCount: participants.length,
        host: existingMeeting?.host || '',
        hostControls: existingMeeting?.hostControls || null
    });
}));

// ============ ORGANIZATIONS SYSTEM ============
async function buildOrganizationResponse(organization, actor = '') {
    const accounts = await readAccounts();
    const balances = await readBalances();
    const orderedMembers = [
        organization.owner,
        ...(organization.admins || []).filter((username) => username !== organization.owner),
        ...(organization.members || []).filter((username) => username !== organization.owner && !(organization.admins || []).includes(username))
    ];
    const memberAccounts = orderedMembers
        .map((username) => accounts[username])
        .filter(Boolean)
        .map((account) => ({
            ...serializeAccount(account, balances[account.username]),
            organizationRole: getOrganizationRole(organization, account.username),
            canBeManagedByActor: canActorManageTargetInOrganization(organization, actor, account.username)
        }));
    return {
        ...organization,
        role: getOrganizationRole(organization, actor),
        canManage: isOrganizationManager(organization, actor),
        memberAccounts
    };
}

app.post('/api/organizations', wrap(async (req, res) => {
    const { username, name, description, kind, domain, logoText } = req.body;
    const account = await findAccount(username);
    if (!account) return res.status(404).json({ error: 'User not found' });
    if (isOrganizationManagedAccount(account)) {
        return res.status(403).json({ error: 'Organization-managed school and work accounts cannot create their own organizations.' });
    }
    
    const organizations = await readOrganizationsData();
    if (organizations.organizations.some((organization) => organization.owner === username)) {
        return res.status(400).json({ error: 'You already own an organization' });
    }
    
    const organization = normalizeOrganizationRecord({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        name: String(name || 'My Organization').trim(),
        description: String(description || '').trim(),
        kind: ['school', 'work'].includes(String(kind || '').toLowerCase()) ? String(kind).toLowerCase() : 'work',
        domain: String(domain || '').trim().toLowerCase(),
        logoText: String(logoText || name || 'AZHA').trim() || 'AZHA',
        owner: username,
        admins: [username],
        members: [username],
        banned: [],
        createdAt: new Date().toISOString()
    });
    
    organizations.organizations.push(organization);
    await writeOrganizationsData(organizations);
    
    res.json({ message: 'Organization created', organization: await buildOrganizationResponse(organization, username) });
}));

app.get('/api/organizations/:orgId', wrap(async (req, res) => {
    const { orgId } = req.params;
    const actor = String(req.query.username || '').trim();
    const { organization } = await findOrganizationById(orgId);
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    if (actor !== 'AZHA' && !organizationHasUser(organization, actor)) {
        return res.status(403).json({ error: 'You can only view your own organization.' });
    }
    res.json(await buildOrganizationResponse(organization, actor));
}));

app.get('/api/organizations', wrap(async (req, res) => {
    const username = String(req.query.username || '').trim();
    const organizations = await getOrganizationsForUser(username);
    res.json(await Promise.all(organizations.map((organization) => buildOrganizationResponse(organization, username))));
}));

app.post('/api/organizations/:orgId/create-member', wrap(async (req, res) => {
    const { orgId } = req.params;
    const { actor, newUsername, password, fullName, accountType, role } = req.body;
    
    if (!newUsername || !password || !fullName) {
        return res.status(400).json({ error: 'Username, password, and full name are required' });
    }
    
    const organizations = await readOrganizationsData();
    const organization = organizations.organizations.find((entry) => entry.id === orgId);
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    if (!isOrganizationManager(organization, actor)) {
        return res.status(403).json({ error: 'Only organization owners, organization admins, or the CEO can create organization accounts.' });
    }
    if (await findAccount(newUsername)) {
        return res.status(400).json({ error: 'Username already exists' });
    }
    
    const safeType = ['school', 'work'].includes(String(accountType || '').toLowerCase())
        ? String(accountType).toLowerCase()
        : organization.kind;
    const safeRole = String(role || 'member').toLowerCase() === 'admin' ? 'admin' : 'member';
    const accounts = await readAccounts();
    const balances = await readBalances();
    
    accounts[newUsername] = {
        username: newUsername,
        password: String(password),
        fullName: String(fullName || newUsername).trim(),
        profilePic: '',
        email: '',
        authProvider: 'local',
        isAdmin: false,
        warnings: 0,
        orgWarnings: 0,
        status: 'active',
        organizationId: organization.id,
        presenceStatus: 'offline',
        lastSeenAt: '',
        membership: normalizeMembershipRecord({}),
        storagePreference: normalizeStoragePreference({ mode: 'shared', status: 'shared' }),
        browserProfile: buildOrganizationManagedBrowserProfile(organization, safeType, {}, actor),
        createdAt: new Date().toISOString()
    };
    balances[newUsername] = 0;
    
    if (!organization.members.includes(newUsername)) {
        organization.members.push(newUsername);
    }
    if (safeRole === 'admin' && !organization.admins.includes(newUsername)) {
        organization.admins.push(newUsername);
    }
    organization.banned = (organization.banned || []).filter((entry) => entry !== newUsername);
    
    await Promise.all([writeAccounts(accounts), writeBalances(balances)]);
    await writeOrganizationsData(organizations);
    
    res.json({
        message: 'Organization account created.',
        organization: await buildOrganizationResponse(organization, actor),
        account: serializeAccount(accounts[newUsername], balances[newUsername])
    });
}));

app.post('/api/organizations/:orgId/members', wrap(async (req, res) => {
    const { orgId } = req.params;
    const { actor, targetUsername, action, accountType, role } = req.body;
    
    if (!actor) return res.status(400).json({ error: 'Actor required' });
    const organizations = await readOrganizationsData();
    const organization = organizations.organizations.find((entry) => entry.id === orgId);
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    if (!isOrganizationManager(organization, actor)) {
        return res.status(403).json({ error: 'Only organization owners, organization admins, or the CEO can manage this organization.' });
    }
    if (!targetUsername) {
        return res.status(400).json({ error: 'Choose a target user first.' });
    }
    if (!['add', 'remove', 'makeAdmin', 'revokeAdmin', 'warn', 'ban', 'unban'].includes(String(action || ''))) {
        return res.status(400).json({ error: 'Invalid action' });
    }
    
    const accounts = await readAccounts();
    const target = await findAccount(targetUsername);
    
    if (action === 'add') {
        if (!target) {
            return res.status(404).json({ error: 'User not found' });
        }
        if (target.username === 'AZHA') {
            return res.status(403).json({ error: 'AZHA cannot be added this way.' });
        }
        const targetOrganizations = await getOrganizationsForUser(target.username);
        if (targetOrganizations.some((entry) => entry.id !== organization.id && getOrganizationRole(entry, target.username) !== 'banned')) {
            return res.status(403).json({ error: 'That user already belongs to another organization.' });
        }
        if (!organization.members.includes(target.username)) {
            organization.members.push(target.username);
        }
        if (String(role || '').toLowerCase() === 'admin' && !organization.admins.includes(target.username)) {
            organization.admins.push(target.username);
        }
        organization.banned = (organization.banned || []).filter((entry) => entry !== target.username);
        const { key } = await findAccountKey(target.username);
        if (key) {
            accounts[key].organizationId = organization.id;
            accounts[key].browserProfile = buildOrganizationManagedBrowserProfile(organization, accountType || getAccountType(accounts[key]), accounts[key].browserProfile, actor);
            await writeAccounts(accounts);
        }
        await writeOrganizationsData(organizations);
        return res.json({ message: 'User added to organization.', organization: await buildOrganizationResponse(organization, actor) });
    }
    
    if (action === 'unban') {
        if (actor !== 'AZHA' && getOrganizationRole(organization, actor) !== 'owner') {
            return res.status(403).json({ error: 'Only the organization owner or the CEO can unban organization users.' });
        }
        organization.banned = (organization.banned || []).filter((entry) => entry !== targetUsername);
        await writeOrganizationsData(organizations);
        return res.json({ message: 'User unbanned.', organization: await buildOrganizationResponse(organization, actor) });
    }
    
    if (!target || !canActorManageTargetInOrganization(organization, actor, target.username)) {
        return res.status(403).json({ error: 'You can only manage normal users inside your own organization.' });
    }
    
    const { key } = await findAccountKey(target.username);
    if (!key) {
        return res.status(404).json({ error: 'User not found' });
    }
    
    if (action === 'makeAdmin') {
        if (!organization.admins.includes(target.username)) {
            organization.admins.push(target.username);
        }
        await writeOrganizationsData(organizations);
        return res.json({ message: 'Organization user promoted to admin.', organization: await buildOrganizationResponse(organization, actor) });
    }
    
    if (action === 'revokeAdmin') {
        if (actor !== 'AZHA' && getOrganizationRole(organization, actor) !== 'owner') {
            return res.status(403).json({ error: 'Only the organization owner or the CEO can remove organization admins.' });
        }
        organization.admins = organization.admins.filter((entry) => entry !== target.username && entry !== organization.owner);
        await writeOrganizationsData(organizations);
        return res.json({ message: 'Organization admin removed.', organization: await buildOrganizationResponse(organization, actor) });
    }
    
    if (action === 'warn') {
        accounts[key].orgWarnings = Number(accounts[key].orgWarnings || 0) + 1;
        await writeAccounts(accounts);
        return res.json({ message: 'Warning added.', organization: await buildOrganizationResponse(organization, actor) });
    }
    
    if (action === 'ban') {
        if (!organization.banned.includes(target.username)) {
            organization.banned.push(target.username);
        }
        organization.members = organization.members.filter((entry) => entry !== target.username);
        organization.admins = organization.admins.filter((entry) => entry !== target.username);
        accounts[key].organizationId = '';
        accounts[key].browserProfile = clearOrganizationManagedBrowserProfile(accounts[key].browserProfile);
        await Promise.all([writeAccounts(accounts), writeOrganizationsData(organizations)]);
        return res.json({ message: 'User banned from organization.', organization: await buildOrganizationResponse(organization, actor) });
    }
    
    if (action === 'remove') {
        organization.members = organization.members.filter((entry) => entry !== target.username);
        organization.admins = organization.admins.filter((entry) => entry !== target.username);
        accounts[key].organizationId = '';
        accounts[key].browserProfile = clearOrganizationManagedBrowserProfile(accounts[key].browserProfile);
        await Promise.all([writeAccounts(accounts), writeOrganizationsData(organizations)]);
        return res.json({ message: 'User removed from organization.', organization: await buildOrganizationResponse(organization, actor) });
    }
    
    return res.status(400).json({ error: 'Invalid action' });
}));

app.post('/api/organizations/:orgId/browser/:targetUser', wrap(async (req, res) => {
    const { orgId, targetUser } = req.params;
    const { actor, blockedDomains, allowedDomains, strictMode, studentSafeMode, managedBookmarks } = req.body;
    
    const organizations = await readOrganizationsData();
    const organization = organizations.organizations.find((entry) => entry.id === orgId);
    if (!organization) return res.status(404).json({ error: 'Organization not found' });
    if (!canActorManageTargetInOrganization(organization, actor, targetUser)) {
        return res.status(403).json({ error: 'You can only manage browser settings for normal users in your own organization.' });
    }
    
    const { accounts, key } = await findAccountKey(targetUser);
    if (!key) return res.status(404).json({ error: 'User not found' });
    
    const currentProfile = normalizeBrowserProfile(accounts[key].browserProfile);
    accounts[key].organizationId = organization.id;
    accounts[key].browserProfile = normalizeBrowserProfile({
        ...currentProfile,
        organization: {
            ...buildOrganizationManagedBrowserProfile(organization, getAccountType(accounts[key]), currentProfile, actor).organization,
            managedBookmarks: Array.isArray(managedBookmarks)
                ? managedBookmarks
                : currentProfile.organization.managedBookmarks
        },
        controls: {
            blockedDomains: Array.isArray(blockedDomains) ? blockedDomains : currentProfile.controls.blockedDomains,
            allowedDomains: Array.isArray(allowedDomains) ? allowedDomains : currentProfile.controls.allowedDomains,
            strictMode: typeof strictMode === 'boolean' ? strictMode : currentProfile.controls.strictMode,
            studentSafeMode: typeof studentSafeMode === 'boolean' ? studentSafeMode : currentProfile.controls.studentSafeMode
        },
        updatedAt: new Date().toISOString()
    });
    
    await writeAccounts(accounts);
    
    res.json({
        message: 'Organization browser settings updated.',
        browserProfile: accounts[key].browserProfile,
        organization: await buildOrganizationResponse(organization, actor)
    });
}));

app.get('/', (req, res) => {
    if (shouldServeLegacyBrowser(req)) {
        return res.sendFile(path.join(__dirname, 'Legacy.html'));
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', (req, res) => {
    if (shouldServeLegacyBrowser(req)) {
        return res.sendFile(path.join(__dirname, 'Legacy.html'));
    }
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/manifest.json', (req, res) => {
    res.sendFile(path.join(__dirname, 'manifest.json'));
});

app.get('/sw.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'sw.js'));
});

app.get('/api/download/all-files.zip', (req, res) => {
    res.json({ 
        message: 'To download all files as a zip, clone the repository from GitHub or download individual files from the DownloadFile page.',
        info: 'Zip downloads are available when running locally with: npm install && npm start'
    });
});

// System state endpoints (CEO only)
app.get('/api/system/status', wrap(async (req, res) => {
    const state = await storage.readSystemState();
    res.json({
        isShutdown: Boolean(state.isShutdown),
        isMaintenanceMode: Boolean(state.isMaintenanceMode),
        shutdownMessage: String(state.shutdownMessage || ''),
        maintenanceMessage: String(state.maintenanceMessage || ''),
        shutdownBy: String(state.shutdownBy || ''),
        shutdownAt: String(state.shutdownAt || '')
    });
}));

app.post('/api/admin/system/toggle-shutdown', wrap(async (req, res) => {
    const actor = String(req.body.actor || '').trim();
    
    // Only CEO (AZHA) can control system shutdown
    if (actor !== 'AZHA') {
        return res.status(403).json({ error: 'Only the CEO (AZHA) can control system shutdown.' });
    }

    const currentState = await storage.readSystemState();
    const nextState = {
        ...currentState,
        isShutdown: !currentState.isShutdown,
        shutdownBy: currentState.isShutdown ? '' : actor,
        shutdownAt: currentState.isShutdown ? '' : new Date().toISOString(),
        shutdownMessage: String(req.body.message || currentState.shutdownMessage || 'System is currently undergoing maintenance. You can still log in and sign up.')
    };

    await storage.writeSystemState(nextState);

    const action = nextState.isShutdown ? 'shut down' : 'brought back online';
    res.json({
        message: `System has been ${action}.`,
        state: {
            isShutdown: nextState.isShutdown,
            shutdownMessage: nextState.shutdownMessage,
            shutdownBy: nextState.shutdownBy,
            shutdownAt: nextState.shutdownAt
        }
    });
}));

app.post('/api/admin/system/toggle-maintenance', wrap(async (req, res) => {
    const actor = String(req.body.actor || '').trim();
    
    // Only CEO (AZHA) can control maintenance mode
    if (actor !== 'AZHA') {
        return res.status(403).json({ error: 'Only the CEO (AZHA) can control maintenance mode.' });
    }

    const currentState = await storage.readSystemState();
    const nextState = {
        ...currentState,
        isMaintenanceMode: !currentState.isMaintenanceMode,
        maintenanceMessage: String(req.body.message || currentState.maintenanceMessage || 'We\'re performing scheduled maintenance. The system will be back soon.')
    };

    await storage.writeSystemState(nextState);

    const action = nextState.isMaintenanceMode ? 'enabled' : 'disabled';
    res.json({
        message: `Maintenance mode has been ${action}.`,
        state: {
            isMaintenanceMode: nextState.isMaintenanceMode,
            maintenanceMessage: nextState.maintenanceMessage
        }
    });
}));

app.use((req, res) => {
    const staticPath = path.join(__dirname, req.path);
    if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
        return res.sendFile(staticPath);
    }

    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API route not found' });
    }

    if (shouldServeLegacyBrowser(req)) {
        return res.sendFile(path.join(__dirname, 'Legacy.html'));
    }

    return res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((err, req, res, next) => {
    console.error(err.stack || err);
    const message = err && err.message ? String(err.message) : 'Something broke on the server';
    if ((req.path || '').startsWith('/api/')) {
        return res.status(500).json({ error: message });
    }
    res.status(500).json({ error: 'Something broke on the server' });
});

if (require.main === module) {
    const server = http.createServer(app);
    const wss = new WebSocket.Server({ server });

    wss.on('connection', (ws) => {
        let userInfo = null;
        let registeredUsername = null;

        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);

                // Handle user registration for messaging
                if (message.type === 'register-user') {
                    registeredUsername = message.username;
                    userInfo = { username: message.username, type: 'messaging' };
                    connectedUsers.set(message.username, ws);
                    console.log(`User ${message.username} connected for messaging`);
                    return;
                }

                // Handle direct messaging (for internal communication)
                if (message.type === 'send-chat-message') {
                    const targetClient = connectedUsers.get(message.to);
                    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
                        targetClient.send(JSON.stringify({
                            type: 'chat-message-received',
                            from: message.from,
                            to: message.to,
                            text: message.text,
                            timestamp: new Date().toISOString(),
                            id: message.id,
                            replyTo: message.replyTo,
                            forwardedFrom: message.forwardedFrom
                        }));
                    }
                    return;
                }

                // Meeting signaling (existing functionality)
                if (message.type === 'participant-update') {
                    const room = getMeetingRoom(message.room);
                    userInfo = { username: message.username, room: message.room };
                    room.participants.set(message.username, ws);

                    // Broadcast to all participants in the room
                    room.participants.forEach((client, username) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify({
                                type: 'participant-joined',
                                room: message.room,
                                username: message.username,
                                participants: Array.from(room.participants.keys())
                            }));
                        }
                    });
                } else if (message.type === 'offer' || message.type === 'answer' || message.type === 'ice-candidate') {
                    // Forward signaling messages to specific peer
                    const room = getMeetingRoom(message.room);
                    const targetClient = room.participants.get(message.to);
                    if (targetClient && targetClient.readyState === WebSocket.OPEN) {
                        targetClient.send(JSON.stringify({
                            type: message.type,
                            from: message.from,
                            data: message.data
                        }));
                    }
                } else if (message.room) {
                    const room = getMeetingRoom(message.room);
                    room.participants.forEach((client) => {
                        if (client.readyState === WebSocket.OPEN) {
                            client.send(JSON.stringify(message));
                        }
                    });
                }
            } catch (error) {
                console.error('WebSocket message error:', error);
            }
        });

        ws.on('close', () => {
            // Remove user from connected list
            if (registeredUsername) {
                connectedUsers.delete(registeredUsername);
                console.log(`User ${registeredUsername} disconnected from messaging`);
            }

            // Handle meeting cleanup (existing functionality)
            if (userInfo && userInfo.room) {
                const room = getMeetingRoom(userInfo.room);
                room.participants.delete(userInfo.username);

                // Notify others
                room.participants.forEach((client) => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({
                            type: 'participant-left',
                            room: userInfo.room,
                            username: userInfo.username,
                            participants: Array.from(room.participants.keys())
                        }));
                    }
                });

                // Clean up empty rooms
                if (room.participants.size === 0) {
                    meetingRooms.delete(userInfo.room);
                    activeRooms.delete(userInfo.room);
                }
            }
        });
    });

    server.listen(port, () => {
        console.log(`Server running at http://localhost:${port}`);
        console.log(`Storage mode: ${storage.getMode()}`);
        console.log(`WebSocket signaling enabled for AZHA Meetings`);
    });
}

module.exports = app;
