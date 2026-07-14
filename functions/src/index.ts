/**
 * Genco Export — Firebase Cloud Functions
 *
 * After migrating the React app to direct RTDB SDK access, most HTTP proxy
 * functions are no longer needed. This file now contains ONLY:
 *   1. Firebase Admin initialization (required for auth token verification)
 *   2. The sendEmail function (HTTP v2, for email sending)
 *
 * All data reads/writes now happen directly from the client SDK.
 */

import * as admin from "firebase-admin";

// ---------------------------------------------------------------------------
// Admin SDK Initialization (singleton)
// ---------------------------------------------------------------------------

const app = admin.initializeApp();

/**
 * Helper to get the admin database instance.
 * Used by functions that need admin-level RTDB access.
 */
export const getDb = (): admin.database.Database => admin.database();

// Re-export the sendEmail function from its own module
export { sendEmail } from "./send-email";