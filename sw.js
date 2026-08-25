const CACHE_NAME = 'azha-launchpad-v12';
const PAGES_TO_CACHE = [
    '/',
    '/index.html',
    '/Admin.html',
    '/CEOPanel.html',
    '/Chat.html',
    '/Shop.html',
    '/Friends.html',
    '/Clubs.html',
    '/Message.html',
    '/Profile.html',
    '/Meetings.html',
    '/Browser.html',
    '/games.html',
    '/contact.html',
    '/Download.html',
    '/DownloadFile.html',
    '/Getin.html',
    '/OrganizationAdmin.html'
];
const urlsToCache = [
    '/manifest.json',
    '/AZHA.PNG',
    'azha-logo.png',
    'channels4profile.png',
    'icon-512.png',
    'profile-bg.jpg',
    'website-video.mp4',
    'minecraft.gif',
    'roblox.gif',
    'fortnite.gif',
    'among-us.gif',
    '/storage.js',
    '/accounts.js',
    '/app.js',
    '/app.css',
    '/jsconfig.json',
    '/sw.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache)));
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
        )
    );
    self.clients.claim();
});

self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;
    const requestUrl = new URL(event.request.url);
    if (requestUrl.origin !== self.location.origin) {
        return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
        // For API GET requests, use cache with network fallback
        if (event.request.method === 'GET') {
            event.respondWith(
                fetch(event.request)
                    .then((response) => {
                        if (response && response.status === 200) {
                            const responseToCache = response.clone();
                            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
                        }
                        return response;
                    })
                    .catch(async () => {
                        const cached = await caches.match(event.request);
                        if (cached) return cached;
                        // Return empty array for list endpoints when offline
                        return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
                    })
            );
            return;
        }
        // For POST/PUT/DELETE, attempt network first
        event.respondWith(
            fetch(event.request).catch(() => new Response(
                JSON.stringify({ error: 'Offline - unable to complete this action' }),
                { status: 503, headers: { 'Content-Type': 'application/json' } }
            ))
        );
        return;
    }

    const isLivePage =
        event.request.mode === 'navigate' ||
        event.request.destination === 'document' ||
        event.request.destination === 'script' ||
        event.request.destination === 'style' ||
        requestUrl.pathname.endsWith('.html') ||
        requestUrl.pathname.endsWith('.js') ||
        requestUrl.pathname.endsWith('.css');

    if (isLivePage) {
        event.respondWith(
            fetch(new Request(event.request, { cache: 'no-store' }))
                .then((response) => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        const responseToCache = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
                    }
                    return response;
                })
                .catch(async () => {
                    const cached = await caches.match(event.request);
                    return cached || caches.match('/index.html');
                })
        );
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cached) => {
            const networkFetch = fetch(event.request)
                .then((response) => {
                    if (response && response.status === 200 && response.type === 'basic') {
                        const responseToCache = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
                    }
                    return response;
                })
                .catch(() => cached || caches.match('/index.html'));
            return cached || networkFetch;
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification?.data?.url || '/Message.html';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            const existing = clientList.find((client) => client.url.includes(targetUrl) || client.url.includes('/Message.html') || client.url.includes('/Meetings.html'));
            if (existing) {
                return existing.focus().then(() => {
                    if ('navigate' in existing) {
                        return existing.navigate(targetUrl);
                    }
                    return existing;
                });
            }
            return clients.openWindow(targetUrl);
        })
    );
});

self.addEventListener('push', (event) => {
    let payload = {};
    try {
        payload = event.data ? event.data.json() : {};
    } catch (error) {
        payload = {
            title: 'AZHA Launchpad',
            body: event.data ? event.data.text() : 'You have a new update.',
            url: '/Message.html'
        };
    }

    const title = payload.title || 'AZHA Launchpad';
    const options = {
        body: payload.body || 'You have a new message.',
        icon: '/AZHA.PNG',
        badge: '/AZHA_64x64.png',
        tag: payload.tag || 'notification',
        data: { url: payload.url || '/Message.html' },
        requireInteraction: payload.requireInteraction !== false
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

// Background sync for notifications when app is closed
self.addEventListener('sync', (event) => {
    if (event.tag === 'check-notifications') {
        event.waitUntil(
            fetch('/api/notifications')
                .then(response => response.json())
                .then(notifications => {
                    // Send notifications for unread items
                    notifications.forEach(notif => {
                        if (!notif.read) {
                            self.registration.showNotification(notif.title, {
                                body: notif.message,
                                icon: '/AZHA.PNG',
                                data: { url: '/Message.html' }
                            });
                        }
                    });
                })
                .catch(err => console.log('Sync check failed:', err))
        );
    }
});
