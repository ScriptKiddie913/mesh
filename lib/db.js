const DB_NAME = "meshchat-db";
const DB_VERSION = 1;
const STORE_MESSAGES = "messages";
const STORE_KV = "kv";

let dbPromise;

function openDb() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_MESSAGES)) {
        const store = db.createObjectStore(STORE_MESSAGES, { keyPath: "id" });
        store.createIndex("by_ts", "ts");
      }

      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV, { keyPath: "key" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
  });

  return dbPromise;
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);

    let output;
    try {
      output = fn(store);
    } catch (error) {
      reject(error);
      return;
    }

    tx.oncomplete = () => resolve(output);
    tx.onerror = () => reject(tx.error || new Error("Transaction failed"));
  });
}

export async function kvSet(key, value) {
  return withStore(STORE_KV, "readwrite", (store) => {
    store.put({ key, value });
  });
}

export async function kvGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_KV, "readonly");
    const store = tx.objectStore(STORE_KV);
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result ? request.result.value : null);
    request.onerror = () => reject(request.error || new Error("kvGet failed"));
  });
}

export async function saveMessage(message) {
  return withStore(STORE_MESSAGES, "readwrite", (store) => {
    store.put(message);
  });
}

export async function loadRecentMessages(limit = 200) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_MESSAGES, "readonly");
    const store = tx.objectStore(STORE_MESSAGES);
    const index = store.index("by_ts");
    const request = index.openCursor(null, "prev");
    const out = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || out.length >= limit) {
        resolve(out.reverse());
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };

    request.onerror = () => reject(request.error || new Error("loadRecentMessages failed"));
  });
}
