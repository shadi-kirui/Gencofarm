/**
 * Prefetch only the collections needed for the first dashboard screen.
 *
 * This is the SINGLE ENTRY POINT for initial data fetching.
 * Call this once after the user profile is loaded and verified
 * (from AuthContext.tsx). Other pages fetch on demand through the
 * same shared cache so unused pages do not spend function/database credits.
 *
 * Uses Promise.allSettled so one failure doesn't block the others.
 */

import {
  fetchCollection,
  fetchCollectionByProgrammes,
} from "@/lib/firebase";

// ---------------------------------------------------------------------------
// Collections that don't need programme filtering (global / stable data)
// ---------------------------------------------------------------------------
const GLOBAL_COLLECTIONS = [
] as const;

// ---------------------------------------------------------------------------
// Collections scoped to the user's accessible programmes and needed by the
// dashboard overview. Page-specific collections are fetched lazily by pages.
// These are pre-warmed on login so the dashboard renders instantly and the
// first navigation to each page is a cache hit (no extra Cloud Function call).
// ---------------------------------------------------------------------------
const PROGRAMME_SCOPED_COLLECTIONS = [
  "BoreholeStorage",
  "HayStorage",
  "farmers",
  "offtakes",
  "capacityBuilding",
  "AnimalHealthActivities",
  "Recent Activities",
] as const;

/**
 * Fire-and-forget prefetch of the initial dashboard collections.
 *
 * @param accessibleProgrammes - The programmes the logged-in user can access
 *   (from resolveAccessibleProgrammes). If empty, per-programme prefetches
 *   are skipped but global collections are still fetched.
 */
export const prefetchCommonData = async (
  accessibleProgrammes: readonly string[] = [],
): Promise<void> => {
  // Phase 1: Global collections (no programme filter)
  await Promise.allSettled(
    GLOBAL_COLLECTIONS.map((path) => fetchCollection(path)),
  );

  // Phase 2: Programme-scoped collections
  if (accessibleProgrammes.length > 0) {
    await Promise.allSettled(
      PROGRAMME_SCOPED_COLLECTIONS.map((path) =>
        fetchCollectionByProgrammes(path, [...accessibleProgrammes]),
      ),
    );
  }

  console.log(
    `[Genco Prefetch] Dashboard data pre-warmed into cache ` +
    `(${GLOBAL_COLLECTIONS.length} global + ${PROGRAMME_SCOPED_COLLECTIONS.length} programme-scoped)`,
  );
};
