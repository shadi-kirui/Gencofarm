/**
 * useRTDBOnce — One-Time Fetch Hook (get() instead of onValue())
 *
 * Fetches data from RTDB ONCE using `get()` — no persistent listener, no
 * WebSocket, no idle bandwidth consumption.
 *
 * Use this for collections that change rarely:
 *   - `hrStaffDirectory`
 *   - `prices`
 *   - `fieldTeam`
 *   - Reference/lookup data of any kind
 *
 * BANDWIDTH COMPARISON:
 *   - `onValue()`: Opens WebSocket → keeps it open forever. Heartbeat frames
 *     alone consume ~1 KB/min = ~1.4 MB/day PER listener.
 *   - `get()`: Opens HTTPS request → downloads snapshot → immediately closes.
 *     Zero idle cost. Only consumes bandwidth for the actual data bytes.
 *
 * For a dashboard with 5 rarely-changing collections, switching from
 * `onValue` to `get` saves ~7 MB/day in heartbeat traffic alone.
 *
 * @example
 * ```tsx
 * // In a component:
 * const { records, loading, error, refetch } = useRTDBOnce("prices");
 *
 * // With query options:
 * const { records } = useRTDBOnce("hrStaffDirectory", {
 *   limit: 200,
 * });
 *
 * // With filter:
 * const { records } = useRTDBOnce("fieldTeam", {
 *   orderBy: "programme",
 *   equalTo: "KPMD",
 * });
 * ```
 */

import { useCallback, useEffect, useState } from "react";
import { get, query, ref, orderByChild, equalTo, limitToLast, limitToFirst, type Query, type QueryConstraint } from "firebase/database";
import { db } from "@/lib/firebase";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RTDBOnceOptions {
  orderBy?: string;
  equalTo?: string | number | boolean | null;
  limit?: number;
  limitFirst?: boolean;
}

export interface RTDBOnceResult<T = any> {
  /** Array of database records with `id` field attached. */
  records: Array<T & { id: string }>;
  /** Whether the fetch is in progress. */
  loading: boolean;
  /** Any error from the fetch. */
  error: Error | null;
  /** Manually re-fetch the data. */
  refetch: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildOnceQuery = (
  path: string,
  options?: RTDBOnceOptions,
): Query => {
  const baseRef = ref(db, path);
  const constraints: QueryConstraint[] = [];

  if (options?.orderBy) {
    constraints.push(orderByChild(options.orderBy));
  }
  if (options?.equalTo !== undefined && options?.equalTo !== null) {
    constraints.push(equalTo(options.equalTo));
  }

  // Default limit of 50 for safety
  const limit = options?.limit ?? 50;
  if (options?.limitFirst) {
    constraints.push(limitToFirst(limit));
  } else {
    constraints.push(limitToLast(limit));
  }

  return constraints.length > 0 ? query(baseRef, ...constraints) : baseRef;
};

const toRecords = <T = any>(
  rawData: Record<string, any> | null,
): Array<T & { id: string }> => {
  if (!rawData || typeof rawData !== "object") return [];
  return Object.entries(rawData).map(([id, value]) => ({
    ...(value as T),
    id,
  }));
};

// ---------------------------------------------------------------------------
// Static Helper (non-hook, for use outside React)
// ---------------------------------------------------------------------------

/**
 * Fetch data from RTDB once — callable outside of React components.
 *
 * ```ts
 * const prices = await fetchOnce<{ price: number }>("prices");
 * ```
 */
export async function fetchOnce<T = any>(
  path: string,
  options?: RTDBOnceOptions,
): Promise<Array<T & { id: string }>> {
  const firebaseQuery = buildOnceQuery(path, options);
  const snapshot = await get(firebaseQuery);
  const rawData = snapshot.val() as Record<string, any> | null;
  return toRecords<T>(rawData);
}

// ---------------------------------------------------------------------------
// React Hook
// ---------------------------------------------------------------------------

/**
 * React hook wrapper around `fetchOnce`. Fetches on mount and provides
 * a `refetch` function for manual re-fetching.
 *
 * Includes an in-memory dedup map so multiple components calling
 * `useRTDBOnce("prices")` within the same render cycle share
 * a single `get()` call.
 */
type PendingRecord = { id: string } & Record<string, any>;
const pendingFetches = new Map<string, Promise<Array<PendingRecord>>>();

export function useRTDBOnce<T = any>(
  path: string,
  options?: RTDBOnceOptions,
): RTDBOnceResult<T> {
  const [records, setRecords] = useState<Array<T & { id: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

  const doFetch = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const firebaseQuery = buildOnceQuery(path, options);

      // Dedup: if another component already started fetching this exact
      // query, piggyback on the same Promise to avoid duplicate HTTPS requests.
      const queryKey = `${path}:${JSON.stringify(options ?? {})}`;

      let data: Array<T & { id: string }>;

      if (pendingFetches.has(queryKey)) {
        data = (await pendingFetches.get(queryKey)) as Array<T & { id: string }>;
      } else {
        const fetchPromise = (async () => {
          const snapshot = await get(firebaseQuery);
          const rawData = snapshot.val() as Record<string, any> | null;
          const result = toRecords<T>(rawData);
          return result;
        })();
        pendingFetches.set(queryKey, fetchPromise);
        try {
          data = (await fetchPromise) as Array<T & { id: string }>;
        } finally {
          pendingFetches.delete(queryKey);
        }
      }

      if (data) {
        setRecords(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error(`[useRTDBOnce] Fetch error at "${path}":`, err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, fetchKey]);

  useEffect(() => {
    doFetch();
  }, [doFetch]);

  const refetch = useCallback(() => {
    setFetchKey((k) => k + 1);
  }, []);

  return { records, loading, error, refetch };
}