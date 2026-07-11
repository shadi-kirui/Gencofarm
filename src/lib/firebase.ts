/**
 * Genco Firebase Client — HTTP-only data access layer.
 *
 * The React app NEVER reads/writes Firebase RTDB directly.
 * All operations go through Firebase Cloud Functions via HTTP.
 *
 * Only `firebase/auth` is used client-side (for sign-in & ID tokens).
 */

import { initializeApp, getApps, getApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getDownloadURL, getStorage, ref as storageRef, uploadBytes } from "firebase/storage";
import {
  cacheKey,
  installStorageQuotaGuard,
  readCachedValue,
  readCachedValueTiered,
  reclaimStorageForCriticalWrites,
  removeCachedValue,
  removeCachedValuesByPrefix,
  removeMemoryCache,
  invalidateMemoryCacheByPrefix,
  writeCachedValue,
  writeCachedValueTiered,
} from "@/lib/data-cache";
import { getProgrammeQueryValues } from "@/lib/programme-access";

// --- Types ---

export type DatabaseRecord<T> = T & { id: string };

/** Fake snapshot for onValue callback compatibility */
interface FakeSnapshot {
  exists: () => boolean;
  val: () => Record<string, any> | null;
  key: string | null;
  forEach: (callback: (snapshot: FakeSnapshot) => boolean | void) => boolean;
}

// --- Config (Auth only — NO database URL needed on client) ---

// Validate required env vars early — missing vars cause cryptic "auth/invalid-credential" errors
const requiredEnvVars = [
  "VITE_API_KEY",
  "VITE_AUTH_DOMAIN",
  "VITE_PROJECT_ID",
  "VITE_APP_ID",
] as const;

const missingVars = requiredEnvVars.filter(
  (key) => !import.meta.env[key] || import.meta.env[key]?.startsWith("your_")
);

if (missingVars.length > 0) {
  console.error(
    `[Genco] FATAL: Missing Firebase environment variables: ${missingVars.join(", ")}\n` +
    `Copy .env.example to .env and fill in your Firebase project credentials.\n` +
    `Get them from: Firebase Console → Project Settings → General → Your apps → Web app`
  );
}

if (import.meta.env.VITE_PROJECT_ID && import.meta.env.VITE_PROJECT_ID !== "genco-export") {
  console.error(
    `[Genco] FATAL: VITE_PROJECT_ID is "${import.meta.env.VITE_PROJECT_ID}" but must be "genco-export".\n` +
    `User accounts are registered in the genco-export Firebase project — using a different project causes auth/invalid-credential errors.`
  );
}

const firebaseConfig = {
  apiKey: import.meta.env.VITE_API_KEY,
  authDomain: import.meta.env.VITE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_PROJECT_ID,
  // databaseURL removed — client never accesses RTDB directly
  storageBucket: import.meta.env.VITE_STORAGE_BUCKET,
  appId: import.meta.env.VITE_APP_ID,
};

// --- Auth-only Initialization ---

installStorageQuotaGuard();
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
export const auth = getAuth(app);
const storage = getStorage(app);

reclaimStorageForCriticalWrites();

const secondaryApp = initializeApp(firebaseConfig, "Secondary");
export const secondaryAuth = getAuth(secondaryApp);

// Analytics removed — not needed for dashboard, saves bundle size

import {
  buildCloudFunctionUrl,
} from "@/lib/cloud-functions";
import { queryClient } from "@/lib/query-client";

// --- HTTP Helpers ---

const getIdToken = async (): Promise<string> => {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Not authenticated");
  return token;
};

const apiGet = async <T = any>(endpoint: string, params?: Record<string, string>, extraHeaders?: Record<string, string>): Promise<T> => {
  const token = await getIdToken();
  const url = new URL(buildCloudFunctionUrl(endpoint));
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(url.toString(), { headers });
  if (res.status === 304) throw new Error("NOT_MODIFIED");
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
};

const apiPost = async <T = any>(endpoint: string, body: any): Promise<T> => {
  const token = await getIdToken();
  const res = await fetch(buildCloudFunctionUrl(endpoint), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }
  return res.json();
};

const apiDelete = async (endpoint: string, params: Record<string, string>): Promise<void> => {
  const token = await getIdToken();
  const url = new URL(buildCloudFunctionUrl(endpoint));
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }
};

// --- Server data proxy (with version-based 304 support) ---

interface ServerDataResponse {
  version: number;
  count: number;
  data: any[];
  error?: string;
}

interface BatchDataResponse {
  results: Record<string, ServerDataResponse>;
}

export type CollectionFetchOptions = {
  ttlMs?: number;
  fetchAll?: boolean;
  noDateFilter?: boolean;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
  fields?: readonly string[];
  /**
   * Optional background refresh interval in milliseconds.
   * If omitted (default), the subscription does a ONE-SHOT fetch and
   * never polls — the page gets fresh data on next mount instead.
   * Use this ONLY for pages that genuinely need live updates.
   */
  refreshIntervalMs?: number;
};

type CollectionFetchConfig = Required<Pick<CollectionFetchOptions, "fetchAll" | "noDateFilter">> &
  Omit<CollectionFetchOptions, "fetchAll" | "noDateFilter">;

const normalizeFetchOptions = (options?: number | CollectionFetchOptions): CollectionFetchConfig => {
  if (typeof options === "number") {
    return { ttlMs: options, fetchAll: true, noDateFilter: true };
  }

  // IMPORTANT: noDateFilter defaults to TRUE.
  // Pages already perform their own client-side date filtering (see
  // applyFiltersAndDedupe in the page components). If the server applied
  // a date range by default (previous behaviour), collections like
  // `farmers`, `offtakes`, `capacityBuilding` would silently return
  // ONLY the current month's records, making every page appear empty
  // outside the current month. Defaulting to "no date filter" ensures
  // pages receive the full collection and filter to the user's selected
  // range on the client.
  return {
    ...options,
    fetchAll: options?.fetchAll ?? true,
    noDateFilter: options?.noDateFilter ?? true,
  };
};

const getFetchScopeSuffix = (options: CollectionFetchConfig): string => {
  const parts: string[] = [];
  if (!options.fetchAll) parts.push(`page:${options.page ?? 1}`, `limit:${options.limit ?? 100}`);
  if (!options.noDateFilter) parts.push(`date:${options.startDate || "current"}:${options.endDate || "current"}`);
  if (options.fields?.length) parts.push(`fields:${options.fields.join(",")}`);
  return parts.join("|");
};

const fetchFromServer = async (
  collectionPath: string,
  programme?: string,
  options: CollectionFetchConfig = normalizeFetchOptions(),
): Promise<ServerDataResponse | null> => {
  try {
    const params: Record<string, string> = {
      path: collectionPath,
      fetchAll: String(options.fetchAll),
    };
    if (options.noDateFilter) params.noDateFilter = "true";
    if (options.startDate) params.startDate = options.startDate;
    if (options.endDate) params.endDate = options.endDate;
    if (options.page) params.page = String(options.page);
    if (options.limit) params.limit = String(options.limit);
    if (options.fields?.length) params.fields = options.fields.join(",");
    if (programme) params.programme = programme;

    const result = await apiGet<ServerDataResponse>("/api/data", params);
    return result;
  } catch (err) {
    if (err instanceof Error && err.message === "NOT_MODIFIED") return null;
    console.error(`Server fetch failed for ${collectionPath}:`, err);
    return null;
  }
};

// --- Client-side Cache ---

const TTL_ACTIVE = 30 * 60 * 1000;   // 30 minutes for live/transactional data
const TTL_STABLE = 6 * 60 * 60 * 1000;   // 6 hours for rarely-changing data
const SERVER_CACHE_TTL_MS = 3 * 60 * 1000;

// IMPORTANT: Polling has been REMOVED by default.
// Previously the client re-fetched every open tab every 2 minutes
// (subscribeCollectionByProgramme) and every 30 seconds (onValue),
// which compounded across 15 isolated Cloud Function containers and
// burned through Firebase credits even when the user was idle.
//
// Data is now cache-first. Pages get fresh data on:
//   - initial mount (one-shot fetch)
//   - manual refresh (invalidateCollectionCache + re-fetch)
//   - explicit refetch by the page when the user changes filters
//
// If a page truly needs background refresh, it can opt in by passing
// { refreshIntervalMs: <ms> } in the options.
const SUBSCRIPTION_POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 min fallback (rarely used)
const VISIBILITY_REFRESH_DEBOUNCE_MS = 60 * 1000; // don't refresh on rapid tab switches

/** Collections that rarely change — use longer TTL */
const STABLE_COLLECTIONS = ["users", "programmes", "fieldTeam", "prices"];

/** Pick TTL based on collection path */
const getTtlForPath = (path: string): number =>
  STABLE_COLLECTIONS.some((c) => path.includes(c)) ? TTL_STABLE : TTL_ACTIVE;
const inFlightRequests = new Map<string, Promise<DatabaseRecord<any>[]>>();

const buildCacheKey = (path: string, scope = "all") =>
  cacheKey("collection", auth.currentUser?.uid || "anon", path, scope);

const getEffectiveTtl = (path: string, options?: number | CollectionFetchOptions): number => {
  const ttlMs = typeof options === "number" ? options : options?.ttlMs;
  return typeof ttlMs === "number" && ttlMs > 0 ? ttlMs : getTtlForPath(path);
};

const withFetchScope = (scope: string, options: CollectionFetchConfig): string => {
  const suffix = getFetchScopeSuffix(options);
  return suffix ? `${scope}:${suffix}` : scope;
};

const shouldFetchAllDatesByDefault = (path: string): boolean =>
  STABLE_COLLECTIONS.some((collection) => path.split("/")[0] === collection);

const normalizeCollectionFetchOptions = (
  path: string,
  options?: number | CollectionFetchOptions,
): CollectionFetchConfig => {
  const normalized = normalizeFetchOptions(options);
  if (options === undefined && shouldFetchAllDatesByDefault(path)) {
    return { ...normalized, noDateFilter: true };
  }
  return normalized;
};

const getCollectionQueryKey = (path: string, scope: string) =>
  ["collection", auth.currentUser?.uid || "anon", path, scope] as const;

const readQueryCollectionCache = <T = Record<string, any>>(
  path: string,
  scope: string,
): DatabaseRecord<T>[] | undefined =>
  queryClient.getQueryData<DatabaseRecord<T>[]>(getCollectionQueryKey(path, scope));

const serverResponseToRecords = <T = Record<string, any>>(
  response: ServerDataResponse,
): DatabaseRecord<T>[] =>
  (response.data || []).map((item: any) => ({
    id: item.id,
    ...item,
  })) as DatabaseRecord<T>[];

export type BatchCollectionRequest = {
  key?: string;
  path: string;
  programme?: string;
  programmes?: readonly string[];
  options?: CollectionFetchOptions;
};

const normalizeProgrammeValue = (value: unknown): string =>
  String(value ?? "").trim().toUpperCase();

const getRecordProgramme = (record: Record<string, any>): string =>
  normalizeProgrammeValue(record.programme ?? record.Programme);

const filterRecordsByProgramme = <T = Record<string, any>>(
  records: DatabaseRecord<T>[],
  programme: string,
): DatabaseRecord<T>[] => {
  const normalized = normalizeProgrammeValue(programme);
  return records.filter((record) => getRecordProgramme(record as Record<string, any>) === normalized);
};

const filterRecordsByProgrammes = <T = Record<string, any>>(
  records: DatabaseRecord<T>[],
  programmes: readonly string[],
): DatabaseRecord<T>[] => {
  const allowed = new Set(programmes.map(normalizeProgrammeValue).filter(Boolean));
  if (allowed.size === 0) return [];
  return records.filter((record) => allowed.has(getRecordProgramme(record as Record<string, any>)));
};

const writeProgrammeBreakoutCaches = <T = Record<string, any>>(
  path: string,
  records: DatabaseRecord<T>[],
): void => {
  const recordsByProgramme = new Map<string, DatabaseRecord<T>[]>();

  records.forEach((record) => {
    const programme = getRecordProgramme(record as Record<string, any>);
    if (!programme) return;
    const programmeRecords = recordsByProgramme.get(programme) || [];
    programmeRecords.push(record);
    recordsByProgramme.set(programme, programmeRecords);
  });

  recordsByProgramme.forEach((programmeRecords, programme) => {
    writeCachedValueTiered(buildCacheKey(path, `programme:${programme}`), programmeRecords);
  });
};

const writeCollectionCache = <T = Record<string, any>>(
  path: string,
  scope: string,
  records: DatabaseRecord<T>[],
  options: { writeProgrammeBreakouts?: boolean; writeAll?: boolean } = {},
): void => {
  writeCachedValueTiered(buildCacheKey(path, scope), records);
  queryClient.setQueryData(getCollectionQueryKey(path, scope), records);

  if (options.writeAll) {
    writeCachedValueTiered(buildCacheKey(path), records);
    queryClient.setQueryData(getCollectionQueryKey(path, "all"), records);
  }

  if (options.writeProgrammeBreakouts) {
    writeProgrammeBreakoutCaches(path, records);
  }
};

// --- Public API: Collection Fetchers (replace direct RTDB reads) ---

/** Track cache hits for debugging */
const _cacheDebug = {
  hits: 0,
  misses: 0,
};

export const fetchCollectionsBatch = async <T = Record<string, any>>(
  requests: readonly BatchCollectionRequest[],
): Promise<Record<string, DatabaseRecord<T>[]>> => {
  const normalizedRequests = requests
    .map((request, index) => {
      const fetchOptions = normalizeCollectionFetchOptions(request.path, request.options);
      const programmes = request.programmes
        ? Array.from(new Set(request.programmes.map((p) => p.trim().toUpperCase()).filter(Boolean)))
        : undefined;
      const programme = request.programme?.trim().toUpperCase();
      const scopeBase = programmes?.length
        ? `programmes:${programmes.join("|")}`
        : programme
          ? `programme:${programme}`
          : "all";
      const scope = withFetchScope(scopeBase, fetchOptions);
      return {
        key: request.key || `${request.path}:${index}`,
        path: request.path,
        programme,
        programmes,
        options: fetchOptions,
        scope,
      };
    })
    .filter((request) => request.path);

  if (normalizedRequests.length === 0) return {};

  const cachedResults: Record<string, DatabaseRecord<T>[]> = {};
  const missingRequests = normalizedRequests.filter((request) => {
    const effectiveTtl = getEffectiveTtl(request.path, request.options);
    const cacheName = buildCacheKey(request.path, request.scope);
    const cached = readCachedValueTiered<DatabaseRecord<T>[]>(cacheName, effectiveTtl) ||
      readQueryCollectionCache<T>(request.path, request.scope);
    if (cached) {
      cachedResults[request.key] = cached;
      return false;
    }
    return true;
  });

  if (missingRequests.length === 0) return cachedResults;

  const batchKey = [
    "batch-collections",
    auth.currentUser?.uid || "anon",
    missingRequests.map(({ key, path, programme, programmes, options }) => ({
      key,
      path,
      programme,
      programmes,
      options,
    })),
  ] as const;

  const fallbackToIndividualReads = async (): Promise<Record<string, DatabaseRecord<T>[]>> => {
    const settled = await Promise.allSettled(
      missingRequests.map(async (request) => {
        if (request.programmes?.length) {
          return [request.key, await fetchCollectionByProgrammes<T>(request.path, request.programmes, request.options)] as const;
        }
        if (request.programme) {
          return [request.key, await fetchCollectionByProgramme<T>(request.path, request.programme, request.options)] as const;
        }
        return [request.key, await fetchCollection<T>(request.path, request.options)] as const;
      }),
    );

    const results: Record<string, DatabaseRecord<T>[]> = {};
    settled.forEach((result, index) => {
      const request = missingRequests[index];
      if (result.status === "fulfilled") {
        results[result.value[0]] = result.value[1];
      } else {
        console.error(`Batch fallback failed for ${request.path}:`, result.reason);
        results[request.key] = [];
      }
    });
    return results;
  };

  const fetchedResults = await queryClient.fetchQuery({
    queryKey: batchKey,
    staleTime: TTL_ACTIVE,
    gcTime: TTL_STABLE,
    queryFn: async () => {
      try {
        const response = await apiPost<BatchDataResponse>("/api/batch-data", {
          requests: missingRequests.map(({ key, path, programme, programmes, options }) => ({
            key,
            path,
            programme,
            programmes,
            options,
          })),
        });

        const hasItemErrors = missingRequests.some((request) => response.results?.[request.key]?.error);
        if (hasItemErrors) {
          console.error("Batch data returned item errors; falling back to individual reads:", response.results);
          return fallbackToIndividualReads();
        }

        const results: Record<string, DatabaseRecord<T>[]> = {};
        missingRequests.forEach((request) => {
          const serverResult = response.results?.[request.key];
          const records = serverResult ? serverResponseToRecords<T>(serverResult) : [];
          writeCollectionCache(request.path, request.scope, records, {
            writeProgrammeBreakouts: request.options.fetchAll && request.options.noDateFilter,
            writeAll: request.scope === "all" && request.options.fetchAll && request.options.noDateFilter,
          });
          results[request.key] = records;
        });
        return results;
      } catch (error) {
        console.error("Batch data endpoint failed; falling back to individual reads:", error);
        return fallbackToIndividualReads();
      }
    },
  });

  return { ...cachedResults, ...fetchedResults };
};

/**
 * Fetch a full collection via Cloud Functions (cache-first).
 * Replaces the old direct `get(ref(db, path))` pattern.
 */
export const fetchCollection = async <T = Record<string, any>>(
  path: string,
  options?: number | CollectionFetchOptions,
): Promise<DatabaseRecord<T>[]> => {
  const fetchOptions = normalizeCollectionFetchOptions(path, options);
  const effectiveTtl = getEffectiveTtl(path, options);
  const scope = withFetchScope("all", fetchOptions);
  const cacheName = buildCacheKey(path, scope);
  const cached = readCachedValueTiered<DatabaseRecord<T>[]>(cacheName, effectiveTtl);
  if (cached) {
    _cacheDebug.hits++;
    console.log(`[Genco Cache HIT] ${path} (${_cacheDebug.hits} total hits)`);
    return cached;
  }

  const queryCached = readQueryCollectionCache<T>(path, scope);
  if (queryCached) {
    writeCollectionCache(path, scope, queryCached);
    _cacheDebug.hits++;
    console.log(`[Genco Query Cache HIT] ${path} (${_cacheDebug.hits} total hits)`);
    return queryCached;
  }

  _cacheDebug.misses++;
  console.log(`[Genco Cache MISS] ${path} — fetching from server (${_cacheDebug.misses} total misses)`);

  const inFlight = inFlightRequests.get(cacheName);
  if (inFlight) return inFlight as Promise<DatabaseRecord<T>[]>;

  const request = queryClient.fetchQuery({
    queryKey: getCollectionQueryKey(path, scope),
    staleTime: effectiveTtl,
    gcTime: Math.max(effectiveTtl * 2, TTL_STABLE),
    queryFn: async () => {
    // Go through Cloud Functions
    const serverResult = await fetchFromServer(path, undefined, fetchOptions);
    if (serverResult) {
      const records = serverResponseToRecords<T>(serverResult);
      writeCollectionCache(path, scope, records, {
        writeProgrammeBreakouts: fetchOptions.fetchAll && fetchOptions.noDateFilter,
      });
      console.log(`[Genco Cache WRITE] ${path} → ${records.length} records (memory + localStorage)`);
      return records;
    }
    throw new Error(`Failed to fetch collection: ${path}`);
    },
  });

  inFlightRequests.set(cacheName, request);
  try {
    return await request;
  } finally {
    inFlightRequests.delete(cacheName);
  }
};

/**
 * Fetch collection filtered by programme via Cloud Functions.
 */
export const fetchCollectionByProgramme = async <T = Record<string, any>>(
  path: string,
  programme: string,
  options?: number | CollectionFetchOptions,
): Promise<DatabaseRecord<T>[]> => {
  const normalized = programme.trim().toUpperCase();
  if (!normalized) return [];

  const fetchOptions = normalizeCollectionFetchOptions(path, options);
  const effectiveTtl = getEffectiveTtl(path, options);
  const scope = withFetchScope(`programme:${normalized}`, fetchOptions);
  const cacheName = buildCacheKey(path, scope);
  const cached = readCachedValueTiered<DatabaseRecord<T>[]>(cacheName, effectiveTtl);
  if (cached) {
    _cacheDebug.hits++;
    console.log(`[Genco Cache HIT] ${path}?programme=${normalized} (${_cacheDebug.hits} total hits)`);
    return cached;
  }

  const queryCached = readQueryCollectionCache<T>(path, scope);
  if (queryCached) {
    writeCollectionCache(path, scope, queryCached);
    _cacheDebug.hits++;
    console.log(`[Genco Query Cache HIT] ${path}?programme=${normalized} (${_cacheDebug.hits} total hits)`);
    return queryCached;
  }

  const canUseFullCollectionCache = fetchOptions.fetchAll && fetchOptions.noDateFilter;
  const allCached = canUseFullCollectionCache
    ? readCachedValueTiered<DatabaseRecord<T>[]>(buildCacheKey(path), effectiveTtl)
    : null;
  if (allCached) {
    const records = filterRecordsByProgramme(allCached, normalized);
    writeCollectionCache(path, `programme:${normalized}`, records);
    _cacheDebug.hits++;
    console.log(`[Genco Cache HIT] ${path}?programme=${normalized} from all-programme cache`);
    return records;
  }

  _cacheDebug.misses++;
  console.log(`[Genco Cache MISS] ${path}?programme=${normalized} — fetching from server`);

  const inFlight = inFlightRequests.get(cacheName);
  if (inFlight) return inFlight as Promise<DatabaseRecord<T>[]>;

  const request = queryClient.fetchQuery({
    queryKey: getCollectionQueryKey(path, scope),
    staleTime: effectiveTtl,
    gcTime: Math.max(effectiveTtl * 2, TTL_STABLE),
    queryFn: async () => {
    const serverResult = await fetchFromServer(path, normalized, fetchOptions);
    if (serverResult) {
      const records = serverResponseToRecords<T>(serverResult);
      writeCollectionCache(path, scope, records);
      console.log(`[Genco Cache WRITE] ${path}?programme=${normalized} → ${records.length} records`);
      return records;
    }
    throw new Error(`Failed to fetch programme collection: ${path}`);
    },
  });

  inFlightRequests.set(cacheName, request);
  try {
    return await request;
  } finally {
    inFlightRequests.delete(cacheName);
  }
};

/**
 * Fetch collection filtered by multiple programmes via Cloud Functions.
 */
export const fetchCollectionByProgrammes = async <T = Record<string, any>>(
  path: string,
  programmes: readonly string[],
  options?: number | CollectionFetchOptions,
): Promise<DatabaseRecord<T>[]> => {
  const fetchOptions = normalizeCollectionFetchOptions(path, options);
  const normalized = Array.from(
    new Set(programmes.map((p) => p.trim().toUpperCase()).filter(Boolean)),
  );
  if (normalized.length === 0) return [];
  if (normalized.length === 1) return fetchCollectionByProgramme<T>(path, normalized[0], fetchOptions);

  const effectiveTtl = getEffectiveTtl(path, options);
  const scope = withFetchScope(`programmes:${normalized.join("|")}`, fetchOptions);
  const cacheName = buildCacheKey(path, scope);
  const cached = readCachedValueTiered<DatabaseRecord<T>[]>(cacheName, effectiveTtl);
  if (cached) return cached;

  const queryCached = readQueryCollectionCache<T>(path, scope);
  if (queryCached) {
    writeCollectionCache(path, scope, queryCached);
    return queryCached;
  }

  const canUseFullCollectionCache = fetchOptions.fetchAll && fetchOptions.noDateFilter;
  const allCached = canUseFullCollectionCache
    ? readCachedValueTiered<DatabaseRecord<T>[]>(buildCacheKey(path), effectiveTtl)
    : null;
  if (allCached) {
    const records = filterRecordsByProgrammes(allCached, normalized);
    writeCollectionCache(path, `programmes:${normalized.join("|")}`, records, {
      writeProgrammeBreakouts: true,
    });
    return records;
  }

  const inFlight = inFlightRequests.get(cacheName);
  if (inFlight) return inFlight as Promise<DatabaseRecord<T>[]>;

  const request = queryClient.fetchQuery({
    queryKey: getCollectionQueryKey(path, scope),
    staleTime: effectiveTtl,
    gcTime: Math.max(effectiveTtl * 2, TTL_STABLE),
    queryFn: async () => {
    // Fetch all (no programme filter) — server returns everything, we can let it handle it
    // or fetch per programme and merge
    const allProgrammes = ["KPMD", "RANGE", "KPMD 2"];
    const isAll = allProgrammes.every((p) => normalized.includes(p));

    if (isAll) {
      const serverResult = await fetchFromServer(path, undefined, fetchOptions);
      if (serverResult) {
        const records = serverResponseToRecords<T>(serverResult);
        writeCollectionCache(path, scope, records, {
          writeAll: canUseFullCollectionCache,
          writeProgrammeBreakouts: canUseFullCollectionCache,
        });
        return records;
      }
    }

    const results = await Promise.allSettled(
      normalized.map((p) => fetchCollectionByProgramme<T>(path, p, fetchOptions)),
    );
    const merged = new Map<string, DatabaseRecord<T>>();
    results.forEach((result, index) => {
      if (result.status === "fulfilled") {
        result.value.forEach((record) => merged.set(record.id, record));
        return;
      }
      console.error(`Failed to fetch ${path} for programme ${normalized[index]}:`, result.reason);
    });
    const records = Array.from(merged.values());
    writeCollectionCache(path, scope, records, {
      writeProgrammeBreakouts: canUseFullCollectionCache,
    });
    return records;
    },
  });

  inFlightRequests.set(cacheName, request);
  try {
    return await request;
  } finally {
    inFlightRequests.delete(cacheName);
  }
};

// --- Public API: Subscription (one-shot + optional refresh, replaces onValue) ---

const activePollers = new Map<string, { interval: ReturnType<typeof setInterval> | null; active: boolean }>();
const lastVisibilityRefresh = new Map<string, number>();

/**
 * One-shot subscribe: replaces the old `onValue()` realtime listener.
 *
 * By default this does a SINGLE cache-first fetch and returns — no polling.
 * This is the fix for the credit-burning 2-minute polling loop: every
 * open tab previously re-fetched on a 2-minute cadence, compounding
 * across 15 isolated Cloud Function containers.
 *
 * Optional background refresh:
 *   - pass `refreshIntervalMs` in options to enable interval polling
 *   - if a tab visibility change happens > VISIBILITY_REFRESH_DEBOUNCE_MS
 *     after the last refresh, a single re-fetch is triggered
 */
export const subscribeCollectionByProgramme = <T = Record<string, any>>(
  path: string,
  programme: string,
  onRecords: (records: Record<string, T>) => void,
  onError?: (error: Error) => void,
  options?: number | CollectionFetchOptions,
): (() => void) => {
  const pollerKey = `sub:${path}:${programme}:${JSON.stringify(options || {})}`;
  const normalized = programme.trim().toUpperCase();
  if (!normalized) {
    onRecords({});
    return () => {};
  }

  // Extract explicit refresh interval if the caller genuinely needs polling.
  const refreshIntervalMs =
    typeof options === "object" && options?.refreshIntervalMs && options.refreshIntervalMs > 0
      ? options.refreshIntervalMs
      : null;

  let active = true;
  const fetchOnce = async () => {
    if (!active) return;
    try {
      const records = await fetchCollectionByProgramme<T>(path, normalized, options);
      if (!active) return;
      const map: Record<string, T> = {};
      records.forEach((r) => { map[r.id] = r as unknown as T; });
      onRecords(map);
    } catch (err) {
      if (active && onError) onError(err instanceof Error ? err : new Error(String(err)));
    }
  };

  // Initial fetch — one-shot, cache-first
  fetchOnce();

  // Optional interval refresh (only if the caller explicitly opted in)
  let interval: ReturnType<typeof setInterval> | null = null;
  if (refreshIntervalMs) {
    interval = setInterval(() => {
      if (!active) return;
      if (typeof document !== "undefined" && document.hidden) return; // skip when tab hidden
      fetchOnce();
    }, refreshIntervalMs);
  }

  // Optional visibility-based refresh: when the user comes back to the tab,
  // refresh once (debounced) so they see fresh data without burning credits
  // while they were away.
  const onVisibilityChange = () => {
    if (!active) return;
    if (typeof document === "undefined" || !document.visibilityState || document.visibilityState !== "visible") return;
    const now = Date.now();
    const last = lastVisibilityRefresh.get(pollerKey) || 0;
    if (now - last < VISIBILITY_REFRESH_DEBOUNCE_MS) return;
    lastVisibilityRefresh.set(pollerKey, now);
    fetchOnce();
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibilityChange);
  }

  activePollers.set(pollerKey, { interval, active: true });

  return () => {
    active = false;
    if (interval) clearInterval(interval);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibilityChange);
    }
    activePollers.delete(pollerKey);
  };
};

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
    subscribeCollectionByProgramme<T>(path, p, (records) => {
      // Merge into parent callback
      mergedByProgramme.current.set(p, records);
      const all: Record<string, T> = {};
      mergedByProgramme.current.forEach((v) => Object.assign(all, v));
      onRecords(all);
    }, onError, options),
  );

  return () => {
    unsubs.forEach((u) => u());
  };
};

// --- Public API: Cache Invalidation ---

export const invalidateCollectionCache = (path: string): void => {
  // Clear client cache (both tiers)
  const prefixes = [
    buildCacheKey(path),
    buildCacheKey(path, "programme:"),
    buildCacheKey(path, "programmes:"),
  ];
  prefixes.forEach((prefix) => {
    inFlightRequests.forEach((_, key) => { if (key.startsWith(prefix)) inFlightRequests.delete(key); });
    removeCachedValue(prefix);
    removeCachedValuesByPrefix(prefix);
    removeMemoryCache(prefix);
  });
  // Also clear by prefix in memory cache for broader invalidation
  invalidateMemoryCacheByPrefix(buildCacheKey(path));
  queryClient.invalidateQueries({
    queryKey: ["collection", auth.currentUser?.uid || "anon", path],
    refetchType: "none",
  });
};

const getCollectionCachePathsForWrite = (path: string): string[] => {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return [];

  const paths = new Set<string>();
  if (segments.length === 1) {
    paths.add(segments[0]);
  } else {
    paths.add(segments.slice(0, -1).join("/"));
    paths.add(segments[0]);
  }

  return Array.from(paths);
};

const invalidateWriteCaches = (path: string): void => {
  getCollectionCachePathsForWrite(path).forEach(invalidateCollectionCache);
};

const invalidateUpdateCaches = (path: string, data: any): void => {
  invalidateWriteCaches(path);

  const normalizedPath = path.trim().replace(/^\/+|\/+$/g, "");
  if (normalizedPath || !data || typeof data !== "object" || Array.isArray(data)) {
    return;
  }

  Object.keys(data).forEach((updatePath) => {
    invalidateWriteCaches(updatePath);
  });
};

// --- RTDB-compatible wrapper exports ---
// These let pages keep their existing code patterns (ref, set, push, update, remove, get, onValue)
// but route all operations through Cloud Functions HTTP endpoints.

/** Dummy db — not used for direct access, kept for API compatibility */
export const db = null as unknown as any;

/**
 * ref() — Returns a path string (NOT an RTDB Reference).
 * Usage: ref(db, "requisitions/abc123") → "requisitions/abc123"
 */
export const ref = (_db: any, pathOrRef = "/"): string => pathOrRef;

export const uploadFileToStorage = async (path: string, file: File): Promise<string> => {
  const targetRef = storageRef(storage, path);
  await uploadBytes(targetRef, file, {
    contentType: file.type || "application/octet-stream",
  });
  return getDownloadURL(targetRef);
};

/**
 * set() — Overwrite a record via Cloud Functions.
 */
export const set = async (pathOrRef: string | { _path: string }, data: any): Promise<void> => {
  const path = typeof pathOrRef === "string" ? pathOrRef : (pathOrRef as any)._path;
  await apiPost("/api/set", { path, data });
  invalidateWriteCaches(path);
};

/**
 * update() — Merge data into a record via Cloud Functions.
 */
export const update = async (pathOrRef: string | { _path: string }, data: any): Promise<void> => {
  const path = typeof pathOrRef === "string" ? pathOrRef : (pathOrRef as any)._path;
  await apiPost("/api/update", { path, data });
  invalidateUpdateCaches(path, data);
};

/**
 * push() — Create a new child record via Cloud Functions.
 * If data is provided, creates the record in one call.
 * Returns an object with `.key` (the new record ID).
 */
export const push = async (
  pathOrRef: string | { _path: string },
  data?: any,
): Promise<{ key: string }> => {
  const path = typeof pathOrRef === "string" ? pathOrRef : (pathOrRef as any)._path;
  const result = await apiPost<{ id: string }>("/api/create", { path, data: data || null });
  invalidateWriteCaches(path);
  return { key: result.id };
};

/**
 * remove() — Delete a record via Cloud Functions.
 */
export const remove = async (pathOrRef: string | { _path: string }): Promise<void> => {
  const path = typeof pathOrRef === "string" ? pathOrRef : (pathOrRef as any)._path;
  await apiDelete("/api/delete", { path });
  invalidateWriteCaches(path);
};

/**
 * get() — Read a single record via Cloud Functions.
 * Returns a fake snapshot with .exists(), .val(), .key
 */
const createFakeSnapshot = (
  value: Record<string, any> | null,
  key: string | null,
): FakeSnapshot => ({
  exists: () => value !== null && value !== undefined,
  val: () => value,
  key,
  forEach: (callback) => {
    if (!value || typeof value !== "object") return false;
    for (const [childKey, childValue] of Object.entries(value)) {
      const shouldCancel = callback(
        createFakeSnapshot(childValue as Record<string, any>, childKey),
      );
      if (shouldCancel === true) return true;
    }
    return false;
  },
});

const recordsToSnapshotMap = (records: DatabaseRecord<Record<string, any>>[]) => {
  const obj: Record<string, any> = {};
  records.forEach((record) => {
    const { id, ...rest } = record;
    if (id) obj[id] = rest;
  });
  return obj;
};

const normalizeComparableValue = (value: unknown): string =>
  String(value ?? "").trim().toUpperCase();

const applyQueryFilters = <T extends Record<string, any>>(
  records: DatabaseRecord<T>[],
  filters: QueryDescriptor["filters"],
): DatabaseRecord<T>[] => {
  if (filters.length === 0) return records;

  return records.filter((record) =>
    filters.every((filter) => {
      const value = record[filter.field];

      if (filter.range === "startAt") {
        return value >= filter.value;
      }

      if (filter.range === "endAt") {
        return value <= filter.value;
      }

      if (filter.operator === "==") {
        return normalizeComparableValue(value) === normalizeComparableValue(filter.value);
      }

      return true;
    }),
  );
};

const fetchQueryRecords = async (
  descriptor: QueryDescriptor,
): Promise<DatabaseRecord<Record<string, any>>[]> => {
  const equalityFilter = descriptor.filters.find(
    (filter) =>
      filter.operator === "==" &&
      ["programme", "Programme"].includes(filter.field),
  );

  const canUseProgrammeEndpoint =
    equalityFilter &&
    descriptor.filters.every(
      (filter) =>
        filter === equalityFilter ||
        filter.range === "startAt" ||
        filter.range === "endAt",
    );

  const records = canUseProgrammeEndpoint
    ? await fetchCollectionByProgramme<Record<string, any>>(
        descriptor.path,
        String(equalityFilter.value),
      )
    : await fetchCollection<Record<string, any>>(descriptor.path);

  return applyQueryFilters(records, descriptor.filters);
};

export const get = async (pathOrRef: string | { _path: string } | QueryDescriptor): Promise<FakeSnapshot> => {
  if (typeof pathOrRef === "object" && (pathOrRef as QueryDescriptor)._type === "query") {
    const records = await fetchQueryRecords(pathOrRef as QueryDescriptor);
    const obj = recordsToSnapshotMap(records);
    return createFakeSnapshot(Object.keys(obj).length > 0 ? obj : null, (pathOrRef as QueryDescriptor).path);
  }

  const path = typeof pathOrRef === "string" ? pathOrRef : (pathOrRef as any)._path;
  try {
    const data = await apiGet<Record<string, any>>("/api/record", { path });
    return createFakeSnapshot(data, path.includes("/") ? path.split("/").pop() || null : path);
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) {
      return createFakeSnapshot(null, path.includes("/") ? path.split("/").pop() || null : path);
    }
    throw err;
  }
};

// --- Query helpers (for compatibility with onValue pattern) ---

type QueryDescriptor = {
  _type: "query";
  path: string;
  filters: Array<{ field: string; operator?: string; value: any; range?: string }>;
};

/**
 * query() — Build a query descriptor (no actual DB query).
 * Works with onValue() below to poll the server.
 */
export const query = (pathOrRef: string | QueryDescriptor, ...filters: any[]): QueryDescriptor => {
  if (typeof pathOrRef === "object" && (pathOrRef as QueryDescriptor)._type === "query") {
    return pathOrRef;
  }

  let activeField = "programme";
  const descriptors: QueryDescriptor["filters"] = [];

  filters.forEach((filter) => {
    if (filter?.field) {
      activeField = filter.field;
    }

    if (Object.prototype.hasOwnProperty.call(filter || {}, "value")) {
      descriptors.push({
        field: filter.field || activeField,
        operator: filter.operator,
        value: filter.value,
        range: filter.range,
      });
    }
  });

  return {
    _type: "query",
    path: pathOrRef as string,
    filters: descriptors,
  };
};

/**
 * orderByChild() — Returns a filter descriptor for query().
 */
export const orderByChild = (field: string) => ({ _queryFilter: true, field });

/**
 * equalTo() — Returns a filter descriptor for query().
 */
export const equalTo = (value: any) => ({ _queryFilter: true, value, operator: "==" });

/**
 * onValue() — One-shot replacement for Firebase onValue().
 *
 * IMPORTANT: This used to poll the Cloud Functions endpoint every 30 seconds.
 * That 30-second polling, combined with the 2-minute subscribeCollectionByProgramme
 * polling and 15 isolated Cloud Function containers, caused constant
 * re-downloads even when the user was idle on a page.
 *
 * Now it does ONE cache-first fetch by default. Pass `{ onlyOnce: true }`
 * for an explicit one-shot, or pass `{ refreshIntervalMs: <ms> }` to opt
 * back into polling for pages that genuinely need live updates.
 */
export const onValue = (
  queryOrRef: string | QueryDescriptor,
  callback: (snapshot: FakeSnapshot) => void,
  errorCallback?: (error: Error) => void,
  options?: { onlyOnce?: boolean; refreshIntervalMs?: number },
): (() => void) => {
  let path: string;
  let filters: Array<{ field: string; value: any }> = [];

  if (typeof queryOrRef === "string") {
    path = queryOrRef;
  } else {
    const q = queryOrRef as QueryDescriptor;
    path = q.path;
    filters = q.filters.map((f) => ({ field: f.field, value: f.value }));
  }

  let active = true;
  const fetchOnce = async (deactivateAfter = false) => {
    if (!active) return;
    try {
      const records = typeof queryOrRef === "string"
        ? await fetchCollection<Record<string, any>>(path)
        : await fetchQueryRecords({ _type: "query", path, filters });
      if (!active) return;
      const obj = recordsToSnapshotMap(records);
      callback(createFakeSnapshot(Object.keys(obj).length > 0 ? obj : null, path));
      if (deactivateAfter) active = false;
    } catch (err) {
      if (active && errorCallback) {
        errorCallback(err instanceof Error ? err : new Error(String(err)));
      }
      if (deactivateAfter) active = false;
    }
  };

  // ONE-SHOT by default — no polling.
  fetchOnce(options?.onlyOnce);
  if (options?.onlyOnce) {
    return () => { active = false; };
  }

  // Opt-in background refresh only.
  let interval: ReturnType<typeof setInterval> | null = null;
  if (options?.refreshIntervalMs && options.refreshIntervalMs > 0) {
    interval = setInterval(() => {
      if (!active) return;
      if (typeof document !== "undefined" && document.hidden) return;
      fetchOnce();
    }, options.refreshIntervalMs);
  }

  return () => {
    active = false;
    if (interval) clearInterval(interval);
  };
};

// --- Server Timestamp placeholder ---
export const serverTimestamp = () => ({ ".sv": "timestamp" });

// --- Additional query helpers (no-ops, for API compatibility) ---
export const startAt = (value: any) => ({ _queryFilter: true, value, range: "startAt" });
export const endAt = (value: any) => ({ _queryFilter: true, value, range: "endAt" });
export const limitToFirst = (count: number) => ({ _queryFilter: true, value: count, range: "limitToFirst" });
export const limitToLast = (count: number) => ({ _queryFilter: true, value: count, range: "limitToLast" });

// --- Type placeholder (for Database type annotations) ---
export type Database = any;
