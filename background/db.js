const DB_NAME = "jjogae-community";
const DB_VERSION = 1;
const EVENT_STORE = "events";

let dbPromise;

function openDatabase() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      const events = db.createObjectStore(EVENT_STORE, { keyPath: "id" });
      events.createIndex("timestamp", "timestamp");
      events.createIndex("type", "type");
      events.createIndex("source", "source");
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  return dbPromise;
}

export async function putEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return 0;
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(EVENT_STORE, "readwrite");
    const store = transaction.objectStore(EVENT_STORE);
    let written = 0;

    for (const event of events) {
      if (!event?.id || !event?.type || !event?.timestamp) continue;
      store.put(event);
      written += 1;
    }

    transaction.oncomplete = () => resolve(written);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function getEvents({ limit = 10000, from = null, to = null } = {}) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(EVENT_STORE, "readonly");
    const index = transaction.objectStore(EVENT_STORE).index("timestamp");
    let range;
    if (from != null && to != null) {
      range = IDBKeyRange.bound(String(from), String(to));
    } else if (from != null) {
      range = IDBKeyRange.lowerBound(String(from));
    } else if (to != null) {
      range = IDBKeyRange.upperBound(String(to));
    }
    const request = index.openCursor(range, "prev");
    const result = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length >= limit) {
        resolve(result);
        return;
      }
      result.push(cursor.value);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteEventsByIds(ids) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length) return 0;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(EVENT_STORE, "readwrite");
    const store = transaction.objectStore(EVENT_STORE);
    for (const id of uniqueIds) store.delete(id);
    transaction.oncomplete = () => resolve(uniqueIds.length);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function deleteEventsByType(type) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(EVENT_STORE, "readwrite");
    const index = transaction.objectStore(EVENT_STORE).index("type");
    const request = index.openCursor(IDBKeyRange.only(type));
    let deleted = 0;
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      deleted += 1;
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(deleted);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function clearEvents() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(EVENT_STORE, "readwrite");
    transaction.objectStore(EVENT_STORE).clear();
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}
