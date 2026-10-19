/* KeepIt Habit & Reminder Tracker — Service Worker (sw.js)
 * Handles background & system notifications, notification action buttons
 * (Complete / Snooze 5m), badge counts, and offline PWA caching.
 */

const CACHE_NAME = 'keepit-pwa-v2';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './seven_am_sunlight.mp4'
];

let swReminders = [];
let swFiredKeys = new Set();
let swCheckTimer = null;

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) return caches.delete(key);
          })
        )
      )
    ])
  );
  startSwReminderTicker();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});

function updateAppBadgeCount() {
  if ('setAppBadge' in self.navigator) {
    const now = Date.now();
    const dueCount = swReminders.filter((r) => !r.completed && r.alertAt && r.alertAt <= now).length;
    if (dueCount > 0) {
      self.navigator.setAppBadge(dueCount).catch(() => {});
    } else if ('clearAppBadge' in self.navigator) {
      self.navigator.clearAppBadge().catch(() => {});
    }
  }
}

function startSwReminderTicker() {
  if (swCheckTimer) clearInterval(swCheckTimer);
  swCheckTimer = setInterval(() => {
    checkSwScheduledReminders();
  }, 10000);
}

async function checkSwScheduledReminders() {
  const now = Date.now();
  if (!Array.isArray(swReminders) || !swReminders.length) return;

  // Check if any client window is currently focused/visible; even if backgrounded, SW shows OS notification
  for (const item of swReminders) {
    if (!item || item.completed) continue;

    // 1. Check Early Alert
    if (item.earlyAlertAt && now >= item.earlyAlertAt && now - item.earlyAlertAt < 3600000) {
      const earlyKey = `${item.id}:early:${item.earlyAlertAt}`;
      if (!item.notifiedEarly && !swFiredKeys.has(earlyKey)) {
        swFiredKeys.add(earlyKey);
        await showKeepItNotification({
          title: `Upcoming: ${item.title}`,
          body: `${item.earlyAlert || 'Early reminder'} (${item.date || 'Scheduled'})`,
          tag: earlyKey,
          reminderId: item.id,
          isEarly: true
        });
      }
    }

    // 2. Check Main Alert
    if (item.alertAt && now >= item.alertAt && now - item.alertAt < 86400000) {
      const mainKey = `${item.id}:main:${item.alertAt}`;
      if (!item.notifiedMain && !swFiredKeys.has(mainKey)) {
        swFiredKeys.add(mainKey);
        const subText =
          item.checklist && item.checklist.length
            ? ' • ' + item.checklist.map((c) => c.text || c).join(', ')
            : '';
        await showKeepItNotification({
          title: item.title || 'KeepIt Reminder',
          body: `${item.date || 'Due now'}${subText}`,
          tag: mainKey,
          reminderId: item.id,
          isEarly: false
        });
      }
    }
  }
  updateAppBadgeCount();
}

async function showKeepItNotification(payload) {
  const { title, body, tag, reminderId, isEarly } = payload;
  const options = {
    body: body || 'Tap to view your reminder in KeepIt',
    icon: './icon.svg',
    badge: './icon.svg',
    tag: tag || `keepit-${reminderId || Date.now()}`,
    renotify: true,
    requireInteraction: true,
    vibrate: [220, 100, 220, 100, 300],
    data: {
      reminderId: reminderId || null,
      url: './#reminder'
    },
    actions: reminderId
      ? [
          { action: 'complete', title: '✓ Complete' },
          { action: 'dismiss', title: '✕ Dismiss' }
        ]
      : []
  };

  try {
    await self.registration.showNotification(title || 'KeepIt Reminder', options);
  } catch (err) {
    // Fallback without actions if browser restricts action buttons
    delete options.actions;
    try {
      await self.registration.showNotification(title || 'KeepIt Reminder', options);
    } catch (_) {}
  }
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SYNC_REMINDERS') {
    swReminders = Array.isArray(data.reminders) ? data.reminders : [];
    startSwReminderTicker();
    updateAppBadgeCount();
  } else if (data.type === 'SHOW_NOTIFICATION') {
    if (data.payload && data.payload.tag) {
      swFiredKeys.add(data.payload.tag);
    }
    showKeepItNotification(data.payload || {});
  } else if (data.type === 'CLOSE_REMINDER_NOTIFICATION') {
    const rmId = data.reminderId;
    if (self.registration && typeof self.registration.getNotifications === 'function') {
      self.registration.getNotifications().then((list) => {
        list.forEach((n) => {
          if (!rmId || (n.tag && String(n.tag).startsWith(String(rmId))) || (n.data && n.data.reminderId === rmId)) {
            n.close();
          }
        });
      }).catch(() => {});
    }
  }
});

self.addEventListener('push', (event) => {
  let payload = { title: 'KeepIt Reminder', body: 'You have a due reminder!' };
  if (event.data) {
    try {
      payload = Object.assign(payload, event.data.json());
    } catch (_) {
      payload.body = event.data.text();
    }
  }
  event.waitUntil(showKeepItNotification(payload));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const action = event.action || 'open';
  const reminderId = event.notification.data && event.notification.data.reminderId;
  const targetUrl = (event.notification.data && event.notification.data.url) || './#reminder';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (reminderId) {
          client.postMessage({
            type: 'REMINDER_NOTIFICATION_ACTION',
            action: action,
            reminderId: reminderId
          });
        }
        if ('focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        const actionHash = reminderId ? `#reminder&rmAction=${encodeURIComponent(action)}&rmId=${encodeURIComponent(reminderId)}` : targetUrl;
        return self.clients.openWindow(actionHash);
      }
    })
  );
});

self.addEventListener('notificationclose', (event) => {
  const reminderId = event.notification.data && event.notification.data.reminderId;
  if (!reminderId) return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        client.postMessage({
          type: 'REMINDER_NOTIFICATION_ACTION',
          action: 'dismiss',
          reminderId: reminderId
        });
      }
    })
  );
});
