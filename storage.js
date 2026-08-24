const fs = require('fs/promises');
const path = require('path');

const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const MESSAGES_FILE = path.join(__dirname, 'messages.json');
const BALANCES_FILE = path.join(__dirname, 'balances.json');
const MEETINGS_FILE = path.join(__dirname, 'meetings.json');
const FRIENDS_FILE = path.join(__dirname, 'friends.json');
const CHATS_FILE = path.join(__dirname, 'chats.json');
const ITEMS_FILE = path.join(__dirname, 'items.json');
const ANNOUNCEMENTS_FILE = path.join(__dirname, 'announcements.json');
const CLUBS_FILE = path.join(__dirname, 'clubs.json');
const TRADES_FILE = path.join(__dirname, 'trades.json');
const NOTIFICATIONS_FILE = path.join(__dirname, 'notifications.json');
const RARITIES_FILE = path.join(__dirname, 'rarities.json');
const ORGANIZATIONS_FILE = path.join(__dirname, 'organizations.json');
const SYSTEM_STATE_FILE = path.join(__dirname, 'system-state.json');

const defaultAccounts = {
    AZHA: {
        username: 'AZHA',
        password: 'AZ MOH',
        fullName: 'AZHAFUDDiN MOHAMMED',
        profilePic: '',
        isAdmin: true,
        warnings: 0,
        status: 'active'
    },
    'Vivvan Dash': {
        username: 'Vivvan Dash',
        password: 'dashpro',
        fullName: 'Vivvan Dash',
        profilePic: '',
        isAdmin: false,
        warnings: 0,
        status: 'active'
    },
    Alyanuddin: {
        username: 'Alyanuddin',
        password: 'alyanpro',
        fullName: 'Alyanuddin Mohammed',
        profilePic: '',
        isAdmin: false,
        warnings: 0,
        status: 'active'
    },
    Hacker: {
        username: 'Hacker',
        password: 'Hacker',
        fullName: 'Hacker',
        profilePic: '',
        isAdmin: false,
        warnings: 0,
        status: 'active'
    },
    Umar: {
        username: 'Umar',
        password: 'Umar',
        fullName: 'Umar Suhail',
        profilePic: '',
        isAdmin: false,
        warnings: 0,
        status: 'active'
    },
    Suleman: {
        username: 'Suleman',
        password: 'Suleman',
        fullName: 'Suleman Ahsan',
        profilePic: '',
        isAdmin: false,
        warnings: 0,
        status: 'active'
    }
};

const defaultMessages = [];
const defaultBalances = { AZHA: 'INF' };
const defaultMeetings = [];
const defaultFriends = { requests: [], friendships: [] };
const defaultChats = [];
const defaultItems = { items: [], scheduled: [] };
const defaultAnnouncements = { announcements: [], pending: [] };
const defaultClubs = { clubs: [] };
const defaultTrades = { trades: [], gifts: [] };
const defaultNotifications = { notifications: [] };
const defaultRarities = { 
    rarities: [
        { id: 'common', name: 'Common', color: '#8B8B8B', dropRate: 0.70 },
        { id: 'uncommon', name: 'Uncommon', color: '#50C878', dropRate: 0.20 },
        { id: 'rare', name: 'Rare', color: '#3498DB', dropRate: 0.07 },
        { id: 'epic', name: 'Epic', color: '#9B59B6', dropRate: 0.02 },
        { id: 'legendary', name: 'Legendary', color: '#FFD700', dropRate: 0.01 }
    ]
};
const defaultOrganizations = { organizations: [] };
const defaultSystemState = {
    isShutdown: false,
    shutdownMessage: 'System is currently undergoing maintenance. You can still log in and sign up.',
    shutdownBy: '',
    shutdownAt: '',
    isMaintenanceMode: false,
    maintenanceMessage: 'We\'re performing scheduled maintenance. The system will be back soon.'
};

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function mergeAccounts(accounts = {}) {
    return {
        ...clone(defaultAccounts),
        ...accounts
    };
}

function mergeBalances(balances = {}, accounts = {}) {
    const merged = { ...clone(defaultBalances), ...balances };
    Object.values(accounts).forEach((account) => {
        if (account.username !== 'AZHA' && !Object.prototype.hasOwnProperty.call(merged, account.username)) {
            merged[account.username] = 0;
        }
    });
    return merged;
}

async function safeWriteJson(filePath, value) {
    try {
        await fs.writeFile(filePath, JSON.stringify(value, null, 2));
        return true;
    } catch (error) {
        if (error.code === 'EROFS' || error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'ENOENT') {
            return false;
        }
        throw error;
    }
}

function createFileStore() {
    async function readJson(filePath, fallbackValue) {
        try {
            const raw = await fs.readFile(filePath, 'utf8');
            try {
                return JSON.parse(raw);
            } catch (parseError) {
                console.warn(`Storage JSON parse failed for ${filePath}, using fallback.`);
                return clone(fallbackValue);
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            // File doesn't exist, so create it with the fallback value
            await safeWriteJson(filePath, fallbackValue);
            return clone(fallbackValue);
        }
    }

    async function writeJson(filePath, value) {
        const written = await safeWriteJson(filePath, value);
        if (!written) {
            console.warn(`Storage write skipped for read-only filesystem: ${filePath}`);
        }
    }

    return {
        async readAccounts() {
            return mergeAccounts(await readJson(ACCOUNTS_FILE, defaultAccounts));
        },
        async writeAccounts(accounts) {
            await writeJson(ACCOUNTS_FILE, accounts);
        },
        async readMessages() {
            return readJson(MESSAGES_FILE, defaultMessages);
        },
        async writeMessages(messages) {
            await writeJson(MESSAGES_FILE, messages);
        },
        async readBalances() {
            const accounts = mergeAccounts(await readJson(ACCOUNTS_FILE, defaultAccounts));
            return mergeBalances(await readJson(BALANCES_FILE, defaultBalances), accounts);
        },
        async writeBalances(balances) {
            await writeJson(BALANCES_FILE, balances);
        },
        async readMeetings() {
            return readJson(MEETINGS_FILE, defaultMeetings);
        },
        async writeMeetings(meetings) {
            await writeJson(MEETINGS_FILE, meetings);
        },
        async readFriends() {
            return readJson(FRIENDS_FILE, defaultFriends);
        },
        async writeFriends(friends) {
            await writeJson(FRIENDS_FILE, friends);
        },
        async readChats() {
            return readJson(CHATS_FILE, defaultChats);
        },
        async writeChats(chats) {
            await writeJson(CHATS_FILE, chats);
        },
        async readItems() {
            return readJson(ITEMS_FILE, defaultItems);
        },
        async writeItems(items) {
            await writeJson(ITEMS_FILE, items);
        },
        async readAnnouncements() {
            return readJson(ANNOUNCEMENTS_FILE, defaultAnnouncements);
        },
        async writeAnnouncements(announcements) {
            await writeJson(ANNOUNCEMENTS_FILE, announcements);
        },
        async readClubs() {
            return readJson(CLUBS_FILE, defaultClubs);
        },
        async writeClubs(clubs) {
            await writeJson(CLUBS_FILE, clubs);
        },
        async readTrades() {
            return readJson(TRADES_FILE, defaultTrades);
        },
        async writeTrades(trades) {
            await writeJson(TRADES_FILE, trades);
        },
        async readNotifications() {
            return readJson(NOTIFICATIONS_FILE, defaultNotifications);
        },
        async writeNotifications(notifications) {
            await writeJson(NOTIFICATIONS_FILE, notifications);
        },
        async readRarities() {
            return readJson(RARITIES_FILE, defaultRarities);
        },
        async writeRarities(rarities) {
            await writeJson(RARITIES_FILE, rarities);
        },
        async readOrganizations() {
            return readJson(ORGANIZATIONS_FILE, defaultOrganizations);
        },
        async writeOrganizations(organizations) {
            await writeJson(ORGANIZATIONS_FILE, organizations);
        },
        async readSystemState() {
            return readJson(SYSTEM_STATE_FILE, defaultSystemState);
        },
        async writeSystemState(state) {
            await writeJson(SYSTEM_STATE_FILE, state);
        },
        getMode() {
            return 'file';
        }
    };
}

function createUpstashStore() {
    const rawBaseUrl = String(process.env.UPSTASH_REDIS_REST_URL || '').trim();
    const baseUrl = rawBaseUrl
        ? (rawBaseUrl.startsWith('http://') || rawBaseUrl.startsWith('https://') ? rawBaseUrl : `https://${rawBaseUrl}`).replace(/\/+$/, '')
        : '';
    const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || '').trim();
    const prefix = process.env.UPSTASH_KEY_PREFIX || 'coder-azhaf';

    async function request(command, ...args) {
        if (!baseUrl) {
            throw new Error('UPSTASH_REDIS_REST_URL is missing or empty');
        }
        if (!token) {
            throw new Error('UPSTASH_REDIS_REST_TOKEN is missing or empty');
        }
        const response = await fetch(`${baseUrl}/${command}/${args.map((value) => encodeURIComponent(value)).join('/')}`, {
            headers: {
                Authorization: `Bearer ${token}`
            }
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Upstash ${command} failed: ${response.status} ${text}`);
        }

        const data = await response.json();
        return data.result;
    }

    async function readKey(key, fallbackValue) {
        const raw = await request('get', `${prefix}:${key}`);
        if (!raw) {
            return clone(fallbackValue);
        }
        try {
            return JSON.parse(raw);
        } catch (parseError) {
            console.warn(`Upstash JSON parse failed for ${key}, using fallback.`);
            return clone(fallbackValue);
        }
    }

    async function writeKey(key, value) {
        await request('set', `${prefix}:${key}`, JSON.stringify(value));
    }

    return {
        async readAccounts() {
            return mergeAccounts(await readKey('accounts', defaultAccounts));
        },
        async writeAccounts(accounts) {
            await writeKey('accounts', accounts);
        },
        async readMessages() {
            return readKey('messages', defaultMessages);
        },
        async writeMessages(messages) {
            await writeKey('messages', messages);
        },
        async readBalances() {
            const accounts = mergeAccounts(await readKey('accounts', defaultAccounts));
            return mergeBalances(await readKey('balances', defaultBalances), accounts);
        },
        async writeBalances(balances) {
            await writeKey('balances', balances);
        },
        async readMeetings() {
            return readKey('meetings', defaultMeetings);
        },
        async writeMeetings(meetings) {
            await writeKey('meetings', meetings);
        },
        async readFriends() {
            return readKey('friends', defaultFriends);
        },
        async writeFriends(friends) {
            await writeKey('friends', friends);
        },
        async readChats() {
            return readKey('chats', defaultChats);
        },
        async writeChats(chats) {
            await writeKey('chats', chats);
        },
        async readItems() {
            return readKey('items', defaultItems);
        },
        async writeItems(items) {
            await writeKey('items', items);
        },
        async readAnnouncements() {
            return readKey('announcements', defaultAnnouncements);
        },
        async writeAnnouncements(announcements) {
            await writeKey('announcements', announcements);
        },
        async readClubs() {
            return readKey('clubs', defaultClubs);
        },
        async writeClubs(clubs) {
            await writeKey('clubs', clubs);
        },
        async readTrades() {
            return readKey('trades', defaultTrades);
        },
        async writeTrades(trades) {
            await writeKey('trades', trades);
        },
        async readNotifications() {
            return readKey('notifications', defaultNotifications);
        },
        async writeNotifications(notifications) {
            await writeKey('notifications', notifications);
        },
        async readRarities() {
            return readKey('rarities', defaultRarities);
        },
        async writeRarities(rarities) {
            await writeKey('rarities', rarities);
        },
        async readOrganizations() {
            return readKey('organizations', defaultOrganizations);
        },
        async writeOrganizations(organizations) {
            await writeKey('organizations', organizations);
        },        async readSystemState() {
            return readKey('system-state', defaultSystemState);
        },
        async writeSystemState(state) {
            await writeKey('system-state', state);
        },        getMode() {
            return 'upstash';
        }
    };
}

function createStorage() {
    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        return createUpstashStore();
    }
    return createFileStore();
}

module.exports = {
    createStorage,
    defaultAccounts,
    defaultMessages,
    defaultBalances,
    defaultMeetings,
    defaultFriends,
    defaultChats,
    defaultItems,
    defaultAnnouncements,
    defaultClubs,
    defaultTrades,
    defaultNotifications,
    defaultRarities,
    defaultOrganizations,
    defaultSystemState
};
