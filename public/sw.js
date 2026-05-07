const CACHE_NAME = 'sqrz-v1'

self.addEventListener('install', (event) => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim())
})

self.addEventListener('fetch', (event) => {
  // Network first, cache fallback
  event.respondWith(
    fetch(event.request).catch(() =>
      caches.match(event.request)
    )
  )
})

self.addEventListener('push', (event) => {
  let payload = {}

  try {
    payload = event.data ? event.data.json() : {}
  } catch (error) {
    payload = {
      title: 'SQRZ',
      body: event.data ? event.data.text() : 'You have a new notification.',
      targetUrl: '/',
    }
  }

  const title = payload.title || 'SQRZ'
  const options = {
    body: payload.body || 'You have a new notification.',
    icon: '/sqrz-logo.png',
    badge: '/sqrz-logo.png',
    tag: payload.tag || 'sqrz-notification',
    data: {
      targetUrl: payload.targetUrl || '/',
    },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const targetUrl = event.notification?.data?.targetUrl || '/'

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          const clientUrl = new URL(client.url)
          const desiredUrl = new URL(targetUrl, self.location.origin)

          if (clientUrl.pathname === desiredUrl.pathname && clientUrl.search === desiredUrl.search) {
            return client.focus()
          }
        }
      }

      if (clients.openWindow) {
        return clients.openWindow(targetUrl)
      }

      return undefined
    })
  )
})
