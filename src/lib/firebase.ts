/**
 * Genco Firebase Client — Direct RTDB SDK Access (Optimized)
 *
 * Initializes the Firebase Web SDK (v9+ modular syntax) directly in the React
 * frontend. All data operations go through the SDK — NO Cloud Function proxy.
 *
 * Optimized to strictly prevent bandwidth credit-burning using server-side 
 * queries, dynamic date partitioning, and local multi-tier caching.
 *
 * Project ID: genco-export
 */

import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import {
  getDatabase,
  ref,
  push,
  set,
  update,
  remove,
  get,
  onValue,
  off,
  query,
  orderByChild,
  orderByKey,
  orderByValue,
  equalTo,
  limitToLast,
  limitToFirst,
  startAt,
  endAt,
  startAfter,
  endBefore,
  child,
  goOffline,
  goOnline,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onChildMoved,
  onDisconnect,
  runTransaction,
  serverTimestamp,
  type Database,
  type DataSnapshot,
  type Unsubscribe,
  type Query,
  type QueryConstraint,
  type ThenableReference,
} from "firebase/database";
import {
  getStorage,
  ref as storageRef,
  uploadBytes,
  getDownloadURL,
} from "firebase/storage";
import {
  cacheKey,
  removeCachedValue,
  removeCachedValuesByPrefix,
  removeMemoryCache,
  invalidateMemoryCacheByPrefix,
  readCachedValueTiered,
  writeCachedValueTiered,
} from "@/lib/data-cache";
import { queryClient } from "@/lib/query-client";

// ---------------------------------------------------------------------------
// Firebase Configuration
// ---------------------------------------------------------------------------

export const firebaseConfig = {
  apiKey: "AIzaSyByxq4hy59lWbJbZuI-syFol7WlGBCA8K8",
  authDomain: "genco-export.firebaseapp.com",
  databaseURL: "https://genco-export-default-rtdb.firebaseio.com",
  projectId: "genco-export",
  storageBucket: "genco-export.firebasestorage.app",
  messagingSenderId: "259197826990",
  appId: "1:259197826990:web:1c74e09f015475d363fa3f",
  measurementId: "G-1DKPB78XWJ",
};

// ---------------------------------------------------------------------------
// App & Service Initialization (singleton-safe)
// ---------------------------------------------------------------------------

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

export const auth = getAuth(app);
export const db = getDatabase(app);
export default app;

// Secondary app for admin user creation (doesn't log out the admin)
const secondaryApp =
  getApps().find((a) => a.name === "Secondary") ??
  initializeApp(firebaseConfig, "Secondary");
export const secondaryAuth = getAuth(secondaryApp);

// Storage instance
const storage = getStorage(app);

// ---------------------------------------------------------------------------
// Re-export standard SDK functions
// ---------------------------------------------------------------------------

export {
  ref,
  push,
  set,
  update,
  remove,
  get,
  onValue,
  off,
  query,
  orderByChild,
  orderByKey,
  orderByValue,
  equalTo,
  limitToLast,
  limitToFirst,
  startAt,
  endAt,
  startAfter,
  endBefore,
  child,
  goOffline,
  goOnline,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onChildMoved,
  onDisconnect,
  runTransaction,
  serverTimestamp,
  type Database,
  type DataSnapshot,
  type Unsubscribe,
  type Query,
  type QueryConstraint,
  type ThenableReference,
};

export {
  getDownloadURL,
  getStorage,
  uploadBytes,
  ref as storageRef,
};

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export type DatabaseRecord<T> = T & { id: string };

export type CollectionFetchOptions = {
  ttlMs?: number;
  noDateFilter?: boolean; // Set to true to clear date filter and fetch everything
  startDate?: string;     // Format: YYYY-MM-DD
  endDate?: string;       // Format: YYYY-MM-DD
  page?: number;
  limit?: number;
  fields?: readonly string[];
};

export type BatchCollectionRequest = {
  key?: string;
  path: string;
  programme?: string;
  programmes?: readonly string[];
  options?: CollectionFetchOptions;
};

// ---------------------------------------------------------------------------
// Optimized Internal Helpers
// ---------------------------------------------------------------------------

const normalizeProgrammeValue = (value: unknown): string =>
  String(value ?? "").trim().toUpperCase();

const getRecordProgramme = (record: Record<string, any>): string =>
  normalizeProgrammeValue(record.programme ?? record.Programme);

/** Dynamic Current Calendar Month Boundaries (Returns ISO local YYYY-MM-DD) */
export const getCurrentMonthRange = (): { startDate: string; endDate: string } => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth(); // 0-indexed

  const startOfCurrentMonth = new Date(year, month, 1);
  const endOfCurrentMonth = new Date(year, month + 1, 0);

  const formatDate = (date: Date) => {
    const d = date.getDate().toString().padStart(2, "0");
    const m = (date.getMonth() + 1).toString().padStart(2, "0");
    const y = date.getFullYear();
    return `${y}-${m}-${d}`;
  };

  return {
    startDate: formatDate(startOfCurrentMonth),
    endDate: formatDate(endOfCurrentMonth),
  };
};

/** Parse database snapshot to clean typescript-compatible record structures */
const toRecords = <T = any>(
  rawData: Record<string, any> | null,
): DatabaseRecord<T>[] => {
  if (!rawData || typeof rawData !== "object") return [];
  return Object.entries(rawData).map(([id, value]) => ({
    ...(value as T),
    id,
  }));
};

// In-flight request deduplication map to prevent multiple identical queries hitting RTDB at once
const inFlightGets = new Map<string, Promise<DatabaseRecord<any>[]>>();

// ---------------------------------------------------------------------------
// fetchCollection — Direct SDK, Server-Filtered & Cache-Backed
// ---------------------------------------------------------------------------

/**
 * Fetch records at a given path using a server-side query.
 * By default, loads ONLY the current month's data to avoid credit burning.
 */
export const fetchCollection = async <T = Record<string, any>>(
  path: string,
  options?: number | CollectionFetchOptions,
): Promise<DatabaseRecord<T>[]> => {
  const opts = typeof options === "number" ? { ttlMs: options } : options || {};
  const { ttlMs, noDateFilter, startDate, endDate } = opts;

  // 1. Calculate and extract date query constraints
  let start = startDate;
  let end = endDate;

  if (!noDateFilter && !start && !end) {
    const defaultRange = getCurrentMonthRange();
    start = defaultRange.startDate;
    end = defaultRange.endDate;
  }

  // 2. Build partition-aware cache-key to prevent cross-contamination
  const cacheKeySuffix = !noDateFilter ? `?start=${start}&end=${end}` : "?all=true";
  const cacheName = cacheKey("collection", `${path}${cacheKeySuffix}`);

  // 3. Resolve Tiered Local Cache (Fast, Zero Network Cost)
  if (ttlMs) {
    const cached = readCachedValueTiered<DatabaseRecord<T>[]>(cacheName, ttlMs);
    if (cached) return cached;
  }

  // 4. De-duplicate concurrent in-flight requests
  if (inFlightGets.has(cacheName)) {
    return inFlightGets.get(cacheName)! as Promise<DatabaseRecord<T>[]>;
  }

  // 5. Query construction and execution
  const fetchPromise = (async () => {
    try {
      let dbQuery: Query = ref(db, path);

      if (!noDateFilter && start && end) {
        // Enforces server-side indexing on the "date" field
        dbQuery = query(
          ref(db, path),
          orderByChild("date"),
          startAt(start),
          endAt(end)
        );
      }

      const snapshot = await get(dbQuery);
      const rawData = snapshot.val() as Record<string, any> | null;
      const records = toRecords<T>(rawData);

      if (ttlMs) {
        writeCachedValueTiered(cacheName, records);
      }

      return records;
    } finally {
      inFlightGets.delete(cacheName);
    }
  })();

  inFlightGets.set(cacheName, fetchPromise);
  return fetchPromise;
};

// ---------------------------------------------------------------------------
// fetchCollectionByProgramme — Client-side Programme Filter
// ---------------------------------------------------------------------------

export const fetchCollectionByProgramme = async <T = Record<string, any>>(
  path: string,
  programme: string,
  options?: number | CollectionFetchOptions,
): Promise<DatabaseRecord<T>[]> => {
  const normalized = normalizeProgrammeValue(programme);
  if (!normalized) return [];

  // Resolves the server-side date filtered collection, minimizing bandwidth
  const filteredRecords = await fetchCollection<T>(path, options);

  return filteredRecords.filter(
    (record) => getRecordProgramme(record as Record<string, any>) === normalized,
  );
};

// ---------------------------------------------------------------------------
// fetchCollectionByProgrammes — Multi-programme client-side filter
// ---------------------------------------------------------------------------

export const fetchCollectionByProgrammes = async <T = Record<string, any>>(
  path: string,
  programmes: readonly string[],
  options?: number | CollectionFetchOptions,
): Promise<DatabaseRecord<T>[]> => {
  const normalizedSet = new Set(
    programmes.map((p) => normalizeProgrammeValue(p)).filter(Boolean),
  );
  if (normalizedSet.size === 0) return [];

  const filteredRecords = await fetchCollection<T>(path, options);

  return filteredRecords.filter((record) =>
    normalizedSet.has(getRecordProgramme(record as Record<string, any>)),
  );
};

// ---------------------------------------------------------------------------
// fetchCollectionsBatch — Parallel query processor
// ---------------------------------------------------------------------------

export const fetchCollectionsBatch = async <T = Record<string, any>>(
  requests: readonly BatchCollectionRequest[],
): Promise<Record<string, DatabaseRecord<T>[]>> => {
  const results = await Promise.all(
    requests.map(async (req) => {
      let records: DatabaseRecord<T>[];

      if (req.programmes) {
        records = await fetchCollectionByProgrammes<T>(
          req.path,
          req.programmes,
          req.options,
        );
      } else if (req.programme) {
        records = await fetchCollectionByProgramme<T>(
          req.path,
          req.programme,
          req.options,
        );
      } else {
        records = await fetchCollection<T>(req.path, req.options);
      }

      return [req.key ?? req.path, records] as const;
    }),
  );

  return Object.fromEntries(results) as Record<string, DatabaseRecord<T>[]>;
};

// ---------------------------------------------------------------------------
// subscribeCollectionByProgramme — True Real-time Client Websocket
// ---------------------------------------------------------------------------

/**
 * Creates a native real-time listener using Firebase WebSockets (`onValue`).
 * Server queries restrict data limits to the current month by default.
 */
export const subscribeCollectionByProgramme = <T = Record<string, any>>(
  path: string,
  programme: string,
  onRecords: (records: Record<string, T>) => void,
  onError?: (error: Error) => void,
  options?: number | CollectionFetchOptions,
): (() => void) => {
  const normalized = programme.trim().toUpperCase();
  if (!normalized) {
    onRecords({});
    return () => {};
  }

  const opts = typeof options === "number" ? {} : options || {};
  const { noDateFilter, startDate, endDate } = opts;

  let start = startDate;
  let end = endDate;

  if (!noDateFilter && !start && !end) {
    const defaultRange = getCurrentMonthRange();
    start = defaultRange.startDate;
    end = defaultRange.endDate;
  }

  // Construct server-side query to prevent pipeline data-flooding
  let dbQuery: Query = ref(db, path);
  if (!noDateFilter && start && end) {
    dbQuery = query(
      ref(db, path),
      orderByChild("date"),
      startAt(start),
      endAt(end)
    );
  }

  // Bind real-time listener (updates push instantly only when matching mutations happen)
  const unsubscribe = onValue(
    dbQuery,
    (snapshot) => {
      const rawData = snapshot.val() as Record<string, any> | null;
      let records = toRecords<T>(rawData);

      // Client-side secondary evaluation for Programme assignment
      records = records.filter(
        (record) => getRecordProgramme(record as Record<string, any>) === normalized,
      );

      const map: Record<string, T> = {};
      records.forEach((r) => {
        map[r.id] = r as unknown as T;
      });

      onRecords(map);
    },
    (err) => {
      if (onError) onError(err);
    }
  );

  return unsubscribe;
};

// ---------------------------------------------------------------------------
// subscribeCollectionByProgrammes — Merged Multi-Channel WebSockets
// ---------------------------------------------------------------------------

export const subscribeCollectionByProgrammes = <T = Record<string, any>>(
  path: string,
  programmes: readonly string[],
  onRecords: (records: Record<string, T>) => void,
  onError?: (error: Error) => void,
  options?: number | CollectionFetchOptions,
): (() => void) => {
  const normalized = Array.from(
    new Set(programmes.map((p) => p.trim().toUpperCase()).filter(Boolean)),
  );
  if (normalized.length === 0) {
    onRecords({});
    return () => {};
  }

  const mergedByProgramme = { current: new Map<string, Record<string, T>>() };

  const unsubs = normalized.map((p) =>
    subscribeCollectionByProgramme<T>(
      path,
      p,
      (records) => {
        mergedByProgramme.current.set(p, records);
        const all: Record<string, T> = {};
        mergedByProgramme.current.forEach((v) => Object.assign(all, v));
        onRecords(all);
      },
      onError,
      options,
    ),
  );

  return () => {
    unsubs.forEach((u) => u());
  };
};

// ---------------------------------------------------------------------------
// Cache Invalidation
// ---------------------------------------------------------------------------

export const invalidateCollectionCache = (path: string): void => {
  const prefixes = [
    cacheKey("collection", path),
    cacheKey("collection", path, "programme:"),
    cacheKey("collection", path, "programmes:"),
  ];

  for (const prefix of prefixes) {
    removeCachedValue(prefix);
    removeCachedValuesByPrefix(prefix);
    removeMemoryCache(prefix);
  }

  invalidateMemoryCacheByPrefix(cacheKey("collection", path));

  queryClient.invalidateQueries({
    queryKey: ["collection", auth.currentUser?.uid || "anon", path],
    refetchType: "none",
  });
};

// ---------------------------------------------------------------------------
// Storage Utilities
// ---------------------------------------------------------------------------

export const uploadFileToStorage = async (
  path: string,
  file: File,
): Promise<string> => {
  const targetRef = storageRef(storage, path);
  await uploadBytes(targetRef, file, {
    contentType: file.type || "application/octet-stream",
  });
  return getDownloadURL(targetRef);
};

// ---------------------------------------------------------------------------
// Profiles & Administrative Touches
// ---------------------------------------------------------------------------

export const getUserProfile = async (
  uid: string,
): Promise<{ id: string; [key: string]: any } | null> => {
  const directSnap = await get(ref(db, `users/${uid}`));
  if (directSnap.exists()) {
    return { id: uid, ...(directSnap.val() as Record<string, any>) };
  }

  const q = query(ref(db, "users"), orderByChild("uid"), equalTo(uid));
  const querySnap = await get(q);

  if (!querySnap.exists()) return null;

  let recordId: string | null = null;
  let data: Record<string, any> | null = null;

  querySnap.forEach((child) => {
    recordId = child.key;
    data = child.val() as Record<string, any>;
    return true;
  });

  if (!recordId || !data) return null;

  return { id: recordId, ...data };
};

export const touchLastLogin = async (recordId: string): Promise<void> => {
  await update(ref(db, `users/${recordId}`), {
    lastLogin: Date.now(),
  });
};