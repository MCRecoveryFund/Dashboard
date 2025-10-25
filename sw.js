// ✅ Service Worker для кэширования ресурсов
const CACHE_NAME = 'mc-recovery-fund-v1';
const API_CACHE_NAME = 'mc-recovery-api-v1';
const CACHE_DURATION = 30000; // 30 секунд для API кэша

// Статические ресурсы для кэширования
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/logo-mc-recovery.webp',
  '/Montserrat-Bold.woff2',
  '/favicon.ico'
];

// Установка SW
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Активация SW
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== API_CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Обработка fetch запросов
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API запросы к Hyperliquid - Network First с коротким кэшем
  if (url.origin === 'https://api.hyperliquid.xyz') {
    event.respondWith(
      caches.open(API_CACHE_NAME).then(async (cache) => {
        try {
          const response = await fetch(request);
          if (response.ok) {
            // Клонируем и сохраняем в кэш
            cache.put(request, response.clone());
          }
          return response;
        } catch (error) {
          // Если сеть недоступна, возвращаем из кэша
          const cached = await cache.match(request);
          if (cached) {
            return cached;
          }
          throw error;
        }
      })
    );
    return;
  }

  // CSV файлы - Cache First
  if (request.url.endsWith('.csv')) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) {
          return cached;
        }
        return fetch(request).then((response) => {
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, response.clone());
            return response;
          });
        });
      })
    );
    return;
  }

  // Статические ресурсы - Cache First
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }
      
      return fetch(request).then((response) => {
        // Кэшируем только успешные GET запросы
        if (request.method === 'GET' && response.ok) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return response;
      });
    })
  );
});
