/**
 * Genco Direct SDK — Client-Side Read/Write Operations
 *
 * This file demonstrates exactly how the React application performs
 * CRUD operations directly through the Firebase Web SDK (v9+ modular syntax)
 * WITHOUT going through Cloud Functions.
 *
 * All operations work within the existing RTDB security rules —
 * NO RULES WERE MODIFIED.
 *
 * Imports use the new `firebase.ts` which exports `auth` and `db`.
 */

import {
  getDatabase,
  ref,
  push,
  set,
  update,
  get,
  query,
  orderByChild,
  equalTo,
  limitToLast,
  remove,
  serverTimestamp,
  type Database,
} from "firebase/database";
import { auth, db } from "@/lib/firebase";

// Re-export for convenience
export { auth, db };

// ---------------------------------------------------------------------------
// Type Helpers
// ---------------------------------------------------------------------------

/** A database record with its Firebase push-key attached. */
export type DbRecord<T> = T & { id: string };

// ---------------------------------------------------------------------------
// TASK 4.1: CREATE — New Requisition
// ---------------------------------------------------------------------------

/**
 * Create a new requisition record in the `requisitions` node.
 *
 * Uses `push()` to auto-generate a unique key, then `set()` to write
 * the data. The existing write rules on `requisitions` will apply —
 * if the authenticated user has write access, the operation succeeds.
 *
 * @example
 * ```ts
 * const newId = await createRequisition({
 *   item: "Fertilizer (DAP)",
 *   quantity: 50,
 *   unit: "bags",
 *   requestedBy: "John Doe",
 *   status: "pending",
 *   programme: "KPMD",
 *   createdAt: Date.now(),
 * });
 * console.log("Created requisition:", newId);
 * ```
 */
export async function createRequisition(
  data: {
    item: string;
    quantity: number;
    unit: string;
    requestedBy: string;
    status: string;
    programme: string;
    [key: string]: any;
  },
): Promise<string> {
  // Guard: ensure user is authenticated
  const user = auth.currentUser;
  if (!user) {
    throw new Error("User must be authenticated to create a requisition.");
  }

  // Reference to the `requisitions` node
  const requisitionsRef = ref(db, "requisitions");

  // push() generates a unique, chronological key
  const newRequisitionRef = push(requisitionsRef);

  // Build the record payload
  const record = {
    ...data,
    createdBy: user.uid,
    createdByEmail: user.email ?? null,
    createdAt: Date.now(), // Client-side timestamp (ms since epoch)
    // Note: serverTimestamp() is only for Firestore. For RTDB,
    // use `Date.now()` on the client or use a Cloud Function
    // with `admin.database.ServerValue.TIMESTAMP` for server time.
  };

  // set() writes the complete record at the push-key location
  await set(newRequisitionRef, record);

  // Return the auto-generated key so the caller can reference it
  return newRequisitionRef.key as string;
}

// ---------------------------------------------------------------------------
// TASK 4.2: UPDATE — Update a Farmer Record
// ---------------------------------------------------------------------------

/**
 * Update specific fields on an existing farmer record.
 *
 * Uses `update()` which performs a partial merge — only the specified
 * fields are modified, all other fields remain untouched. This is
 * bandwidth-efficient because only the changed bytes are sent.
 *
 * @example
 * ```ts
 * await updateFarmer("farmer_abc123", {
 *   phoneNumber: "+254712345678",
 *   village: "Machakos Town",
 * });
 * ```
 *
 * @param farmerId - The Firebase key of the farmer record to update.
 * @param fields - An object containing only the fields to update.
 */
export async function updateFarmer(
  farmerId: string,
  fields: {
    name?: string;
    phoneNumber?: string;
    village?: string;
    programme?: string;
    status?: string;
    [key: string]: any;
  },
): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("User must be authenticated to update a farmer.");
  }

  // Reference to the specific farmer record
  const farmerRef = ref(db, `farmers/${farmerId}`);

  // Add audit trail fields
  const updatePayload = {
    ...fields,
    updatedAt: Date.now(),
    updatedBy: user.uid,
  };

  // update() performs a shallow merge — only the specified keys change.
  // The existing security rules on `farmers/$farmerId` apply.
  await update(farmerRef, updatePayload);
}

// ---------------------------------------------------------------------------
// TASK 4.3: READ WITH FILTER — AnimalHealthActivities by Programme
// ---------------------------------------------------------------------------

/**
 * Read `AnimalHealthActivities` filtered by `programme === "KPMD"`.
 *
 * This demonstrates client-side query construction with pagination:
 *   1. `ref(db, path)` — base reference
 *   2. `query()` with `orderByChild("programme")` — index on the programme field
 *   3. `equalTo("KPMD")` — filter to only KPMD records
 *   4. `limitToLast(50)` — enforce pagination, never fetch unbounded data
 *
 * BANDWIDTH NOTE:
 *   - This uses `get()` (one-time fetch) instead of `onValue()` (persistent
 *     listener) because animal health records are typically viewed, not
 *     watched in real-time. This saves ~1.4 MB/day per unused listener.
 *   - If you DO need real-time updates, use the `useRTDBCollection` hook
 *     from `RTDBCacheContext` instead.
 *
 * @example
 * ```ts
 * const activities = await readAnimalHealthByProgramme("KPMD", 50);
 * console.log(`Found ${activities.length} KPMD animal health activities`);
 *
 * // Or use in a React component via the hook:
 * // const { records, loading, error } = useRTDBCollection({
 * //   path: "AnimalHealthActivities",
 * //   orderBy: "programme",
 * //   equalTo: "KPMD",
 * //   limit: 50,
 * // });
 * ```
 *
 * @param programme - The programme to filter by (e.g. "KPMD", "RANGE", "KPMD 2")
 * @param limit - Maximum records to fetch (default: 50)
 * @returns Array of matching records with `id` field
 */
export async function readAnimalHealthByProgramme(
  programme: string,
  limit: number = 50,
): Promise<DbRecord<Record<string, any>>[]> {
  // Build the query: base ref → orderByChild → equalTo → limitToLast
  const baseRef = ref(db, "AnimalHealthActivities");

  const filteredQuery = query(
    baseRef,
    orderByChild("programme"),
    equalTo(programme),
    limitToLast(limit),
  );

  // get() fetches once and disconnects — no WebSocket, no idle bandwidth
  const snapshot = await get(filteredQuery);
  const rawData = snapshot.val() as Record<string, any> | null;

  if (!rawData || typeof rawData !== "object") {
    return [];
  }

  // Transform { "-NxAbc123": { programme: "KPMD", ... }, ... }
  // into    [ { id: "-NxAbc123", programme: "KPMD", ... }, ... ]
  return Object.entries(rawData).map(([id, value]) => ({
    ...(value as Record<string, any>),
    id,
  }));
}

// ---------------------------------------------------------------------------
// TASK 4.4: EMAIL — Send via Cloud Function
// ---------------------------------------------------------------------------

/**
 * Client-side helper to call the `sendEmail` Cloud Function.
 *
 * @example
 * ```ts
 * await sendEmail(
 *   "farmers@importer.co.ke",
 *   "Order Confirmation #1234",
 *   "Dear Farmer, your order has been confirmed...",
 * );
 * ```
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  options?: {
    bodyType?: "plain" | "html";
    cc?: string | string[];
    bcc?: string | string[];
    replyTo?: string;
  },
): Promise<{ success: boolean; message: string }> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("User must be authenticated to send emails.");
  }

  const idToken = await user.getIdToken();

  const response = await fetch(
    "https://us-central1-genco-export.cloudfunctions.net/sendEmail",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        to,
        subject,
        body,
        ...options,
      }),
    },
  );

  const result = await response.json();

  if (!response.ok) {
    throw new Error(result.error || "Failed to send email.");
  }

  return result;
}

// ---------------------------------------------------------------------------
// BONUS: DELETE — Remove a Record
// ---------------------------------------------------------------------------

/**
 * Delete a record at a given path. Demonstrates the `remove()` operation.
 *
 * @example
 * ```ts
 * await deleteRecord("requisitions", "push-key-here");
 * ```
 */
export async function deleteRecord(
  collectionPath: string,
  recordId: string,
): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error("User must be authenticated to delete records.");
  }

  const recordRef = ref(db, `${collectionPath}/${recordId}`);
  await remove(recordRef);
}