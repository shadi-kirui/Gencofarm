// ─── Tier 1: In-Memory Cache (fastest, lives for the browser session) ─────────
const memoryCache = new Map<string, { value: unknown; timestamp: number }>();

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const STORAGE_PROBE_KEY = "__genco_storage_probe__";
const APP_CACHE_KEY_PREFIXES = [
  "admin-page:",
  "analysis:",
  "collection:",
  "farmers_cache_",
  "dashboard-notifications-seen:",
  "lookups:",
  "overview-summary-",
  "sales-metrics-inputs-",
];
const FIREBASE_WEBSOCKET_FAILURE_KEY = "firebase:previous_websocket_failure";
const STORAGE_GUARD_INSTALLED_KEY = "__gencoStorageQuotaGuardInstalled__";

type CacheEnvelope<T> = {
  value: T;
  timestamp: number;
};

const getStorage = (): Storage | null => {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const isQuotaExceededError = (error: unknown): boolean =>
  error instanceof DOMException &&
  (error.name === "QuotaExceededError" ||
    error.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    error.code === 22 ||
    error.code === 1014);

const removeAppCacheEntries = (storage: Storage): void => {
  const keysToRemove: string[] = [];

  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && APP_CACHE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      keysToRemove.push(key);
    }
  }

  keysToRemove.forEach((key) => storage.removeItem(key));
};

export const reclaimStorageForCriticalWrites = (): void => {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.setItem(STORAGE_PROBE_KEY, "1");
    storage.removeItem(STORAGE_PROBE_KEY);
  } catch (error) {
    if (isQuotaExceededError(error)) {
      removeAppCacheEntries(storage);
    }
  }
};

export const installStorageQuotaGuard = (): void => {
  if (typeof window === "undefined" || typeof Storage === "undefined") return;

  const storagePrototype = Storage.prototype as Storage & Record<string, unknown>;
  if (storagePrototype[STORAGE_GUARD_INSTALLED_KEY]) return;

  const originalSetItem = Storage.prototype.setItem;

  Storage.prototype.setItem = function setItemWithQuotaRecovery(key: string, value: string): void {
    try {
      originalSetItem.call(this, key, value);
      return;
    } catch (error) {
      if (!isQuotaExceededError(error)) {
        throw error;
      }

      removeAppCacheEntries(this);

      try {
        originalSetItem.call(this, key, value);
        return;
      } catch (retryError) {
        if (key === FIREBASE_WEBSOCKET_FAILURE_KEY && isQuotaExceededError(retryError)) {
          return;
        }

        throw retryError;
      }
    }
  };

  storagePrototype[STORAGE_GUARD_INSTALLED_KEY] = true;
};

const isEnvelope = <T>(value: unknown): value is CacheEnvelope<T> => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Partial<CacheEnvelope<T>>;
  return typeof item.timestamp === "number" && "value" in item;
};

export const cacheKey = (...parts: Array<string | number | null | undefined>) =>
  parts
    .filter((part) => part !== null && part !== undefined && part !== "")
    .map((part) => String(part))
    .join(":");

export const readCachedValue = <T>(
  key: string,
  ttlMs = DEFAULT_CACHE_TTL_MS
): T | null => {
  const storage = getStorage();
  if (!storage) return null;

  try {
    const raw = storage.getItem(key);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as CacheEnvelope<T> | T;

    // Backward-compatible support for older caches that stored raw JSON values.
    if (!isEnvelope<T>(parsed)) {
      return parsed as T;
    }

    if (Date.now() - parsed.timestamp > ttlMs) {
      storage.removeItem(key);
      return null;
    }

    return parsed.value;
  } catch {
    return null;
  }
};

export const writeCachedValue = <T>(key: string, value: T): void => {
  const storage = getStorage();
  if (!storage) return;

  try {
    const payload: CacheEnvelope<T> = {
      value,
      timestamp: Date.now(),
    };
    storage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    if (isQuotaExceededError(error)) {
      removeAppCacheEntries(storage);
    }
    // Ignore write failures (quota/private mode), app still works without cache.
  }
};

export const removeCachedValue = (key: string): void => {
  const storage = getStorage();
  if (!storage) return;

  try {
    storage.removeItem(key);
  } catch {
    // Ignore cache cleanup failures.
  }
};

export const removeCachedValuesByPrefix = (prefix: string): void => {
  const storage = getStorage();
  if (!storage) return;

  try {
    const keysToRemove: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) {
        keysToRemove.push(key);
      }
    }
    keysToRemove.forEach((key) => storage.removeItem(key));
  } catch {
    // Ignore cache cleanup failures.
  }
};

export { DEFAULT_CACHE_TTL_MS };

// ─── Two-Tier Cache API ───────────────────────────────────────────────────────

/**
 * Read from in-memory cache (Tier 1).
 * Returns null if not found or expired.
 */
export const readMemoryCache = <T>(
  key: string,
  ttlMs = DEFAULT_CACHE_TTL_MS,
): T | null => {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttlMs) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value as T;
};

/**
 * Write to in-memory cache (Tier 1).
 */
export const writeMemoryCache = <T>(key: string, value: T): void => {
  memoryCache.set(key, { value, timestamp: Date.now() });
};

/**
 * Invalidate in-memory cache entry.
 */
export const removeMemoryCache = (key: string): void => {
  memoryCache.delete(key);
};

/**
 * Invalidate all in-memory cache entries matching a prefix.
 */
export const invalidateMemoryCacheByPrefix = (prefix: string): void => {
  for (const key of [...memoryCache.keys()]) {
    if (key.startsWith(prefix)) memoryCache.delete(key);
  }
};

/**
 * Tiered read: check memory first, then fall back to localStorage.
 * If found in localStorage, promote to memory for faster next access.
 */
export const readCachedValueTiered = <T>(
  key: string,
  ttlMs = DEFAULT_CACHE_TTL_MS,
): T | null => {
  // Tier 1: In-memory (instant, zero I/O)
  const mem = readMemoryCache<T>(key, ttlMs);
  if (mem !== null) return mem;

  // Tier 2: localStorage (zero network cost)
  const stored = readCachedValue<T>(key, ttlMs);
  if (stored !== null) {
    writeMemoryCache(key, stored); // promote to memory
  }
  return stored;
};

/**
 * Tiered write: write to both memory and localStorage.
 */
export const writeCachedValueTiered = <T>(key: string, value: T): void => {
  writeMemoryCache(key, value);   // always write to memory
  writeCachedValue(key, value);   // persist to localStorage
};
