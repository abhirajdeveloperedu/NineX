// NineX - Service Worker (v1 with auto-update logic)

// 1. Update the version number every time you deploy changes
// Bump this to force clients to download fresh assets
const CACHE_NAME = 'ninex-cache-v1';
const urlsToCache = [
    '/',
    '/index.html',
    '/assets/css/styles.css',
    '/assets/js/app.js',
    '/config/config.js'
];

// Install the new service worker and cache new assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('Opened cache');
                return cache.addAll(urlsToCache);
            })
            .then(() => self.skipWaiting())
    );
});

// 2. Add this new event listener to clean up old caches
self.addEventListener('activate', event => {
    const cacheWhitelist = [CACHE_NAME];
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheWhitelist.indexOf(cacheName) === -1) {
                        console.log('Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

// Serve content from cache first, then network
// Use network-first for HTML and core JS/CSS so updates are picked up immediately
self.addEventListener('fetch', event => {
    const req = event.request;
    const accept = req.headers.get('accept') || '';
    const url = new URL(req.url);

    // Never cache API calls or non-GET requests
    if (req.method !== 'GET' || url.pathname.startsWith('/api/')) {
        event.respondWith(fetch(req));
        return;
    }

    const isHTML = req.mode === 'navigate' || accept.includes('text/html');
    const isCoreAsset = /\.(?:js|css)$/.test(url.pathname) || url.pathname.endsWith('/assets/js/app.js') || url.pathname.endsWith('/config/config.js');

    if (isHTML || isCoreAsset) {
        event.respondWith(
            fetch(req)
                .then(networkRes => {
                    const resClone = networkRes.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(req, resClone));
                    return networkRes;
                })
                .catch(() => caches.match(req))
        );
        return;
    }

    // For other GET assets, use cache-first with network fallback and then cache
    event.respondWith(
        caches.match(req).then(cached => {
            if (cached) return cached;
            return fetch(req).then(networkRes => {
                const resClone = networkRes.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(req, resClone));
                return networkRes;
            });
        })
    );
});
