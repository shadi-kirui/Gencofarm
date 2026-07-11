/**
 * Genco Export — Firebase Cloud Functions (HTTP triggers)
 *
 * All data access goes through these functions.
 * Client NEVER reads/writes RTDB directly.
 *
 * Features:
 *  - LRU memory cache for frequently accessed collections
 *  - 304 Not Modified support (version-based)
 *  - Programme filtering at server level
 *  - Write endpoints (create, update, delete)
 *  - Pagination support
 *  - Robust CORS handling with error catching
 */
import * as functions from "firebase-functions";
/**
 * GET /api/data — Cached collection read
 *
 * Query params:
 *   path          (required)  — RTDB collection path
 *   programme     (optional)  — filter by programme field
 *   sinceVersion  (optional)  — returns 304 if version unchanged
 *   page          (optional)  — page number (1-based), default 1
 *   limit         (optional)  — items per page, default all
 *   orderBy       (optional)  — field to order by
 *
 * Note: `minInstances`, memory, and timeout are set globally via
 * `setGlobalOptions` at the top of this file. That keeps this container
 * warm so the in-memory LRU + user access caches survive between requests.
 */
export declare const data: functions.https.HttpsFunction;
export declare const batchData: functions.https.HttpsFunction;
/**
 * GET /api/record — Read a single record by path
 *
 * Query params:
 *   path  (required) — Full RTDB path to the record (e.g. "requisitions/abc123")
 */
export declare const record: functions.https.HttpsFunction;
/**
 * POST /api/query — Run a filtered query (replaces onValue/query/orderByChild/equalTo)
 *
 * Body:
 *   path        (required) — Collection path
 *   filters     (optional) — [{ field, operator, value }]
 *   programmes  (optional) — string[] — shorthand for programme OR filter
 *   orderBy     (optional) — string — field to order by
 */
export declare const queryEndpoint: functions.https.HttpsFunction;
/**
 * GET /api/auth-verify — Verify ID token and return user info
 */
export declare const authVerify: functions.https.HttpsFunction;
/**
 * POST /api/create — Push a new record to a collection
 */
export declare const create: functions.https.HttpsFunction;
/**
 * POST /api/update — Update an existing record
 */
export declare const update: functions.https.HttpsFunction;
/**
 * POST /api/set — Overwrite a record (set)
 */
export declare const setRecord: functions.https.HttpsFunction;
/**
 * DELETE /api/delete — Remove a record
 */
export declare const remove: functions.https.HttpsFunction;
/**
 * POST /api/batch-delete — Remove multiple records
 */
export declare const batchDelete: functions.https.HttpsFunction;
/**
 * GET /api/cache-stats — Debug: view cache status
 */
export declare const cacheStats: functions.https.HttpsFunction;
/**
 * GET /api/health — Health check (no auth required)
 */
export declare const health: functions.https.HttpsFunction;
/**
 * GET /api/userProfile?uid=<uid>
 * Returns the user profile for the authenticated user.
 */
export declare const userProfile: functions.https.HttpsFunction;
/**
 * POST /api/updateLastLogin
 * Updates lastLogin timestamp for authenticated user.
 */
export declare const updateLastLogin: functions.https.HttpsFunction;
