/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Genco — Bulk User Creation Script
 *
 * Creates Firebase Auth users AND writes their profiles to RTDB /users node.
 * Supports both production Firebase and Firebase emulator.
 *
 * USAGE:
 *   1. Edit `users.json` (same directory) with your user list
 *   2. Run:  cd functions && node ../scripts/bulk-create-users.js
 *      OR:   set GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account-key.json
 *            node scripts/bulk-create-users.js
 *   3. For emulator: node scripts/bulk-create-users.js --emulator
 *      (Make sure 'firebase emulators:start' is running in another terminal)
 *
 * Each user object in users.json:
 * {
 *   "email": "user@example.com",
 *   "password": "their-password",        ← REQUIRED for new Auth users
 *   "name": "Full Name",
 *   "phoneNumber": "0712345678",
 *   "role": "Admin" | "Field Officer" | "Manager",
 *   "allowedProgrammes": { "KPMD": true, "RANGE": true },
 *   "status": "active" | "inactive",
 *   "userAttribute": "KPMD"              ← optional, for field-level access
 * }
 *
 * The script will:
 *   • Create the user in Firebase Authentication (email + password)
 *   • Write the profile (with uid auto-populated) to RTDB /users/{uid}
 *   • Skip users whose email already exists in Auth (updates their RTDB profile)
 *   • Produce a summary report → users-report.json
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// Prefer functions/node_modules — root may resolve a newer firebase-admin with a different API.
const admin = require(path.join(__dirname, "../functions/node_modules/firebase-admin"));

const DATABASE_URL = "https://genco-export-default-rtdb.firebaseio.com";
const USE_EMULATOR = process.argv.includes("--emulator");
const EMULATOR_AUTH_URL = "http://localhost:9099";
const EMULATOR_DB_URL = "http://localhost:9000";

// ─── Init Firebase Admin ──────────────────────────────────────────────────────
// Option 1: Place service-account-key.json in scripts/ or functions/
// Option 2: Set GOOGLE_APPLICATION_CREDENTIALS env var
// Option 3: Use `firebase login` (gcloud CLI default credentials)
// Option 4: Use Firebase Emulator (--emulator flag)

if (USE_EMULATOR) {
  console.log("[init] Using Firebase Emulator mode");
  console.log(`       Auth emulator: ${EMULATOR_AUTH_URL}`);
  console.log(`       Database emulator: ${EMULATOR_DB_URL}`);
  admin.initializeApp({
    projectId: "demo-project",
  });
  admin.auth().useEmulator(EMULATOR_AUTH_URL);
  admin.database().useEmulator("localhost", 9000);
} else {
  const serviceAccountCandidates = [
    path.resolve(__dirname, "service-account-key.json"),
    path.resolve(__dirname, "../functions/service-account-key.json"),
  ];
  const serviceAccountPath = serviceAccountCandidates.find((candidate) => fs.existsSync(candidate));

  if (serviceAccountPath) {
    const cred = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(cred),
      databaseURL: DATABASE_URL,
    });
    console.log(`[init] Using service account key from ${serviceAccountPath}`);
  } else {
    admin.initializeApp({ databaseURL: DATABASE_URL });
    console.log("[init] Using default Firebase credentials (gcloud CLI / env)");
    console.log("       If this fails, download a service account key from:");
    console.log("       Firebase Console → Project Settings → Service Accounts → Generate New Key");
    console.log("       Then save it as: functions/service-account-key.json\n");
  }
}

const db = admin.database();
const auth = admin.auth();

// ─── Load users.json ──────────────────────────────────────────────────────────
const usersFile = path.resolve(__dirname, "users.json");
if (!fs.existsSync(usersFile)) {
  console.error("\n[ERROR] users.json not found at: " + usersFile);
  console.error("Create it next to this script. Example:\n");
  console.error(JSON.stringify([
    {
      email: "admin@genco.com",
      password: "ChangeMe123!",
      name: "Admin User",
      phoneNumber: "0712345678",
      role: "Admin",
      allowedProgrammes: { KPMD: true, RANGE: true, "KPMD 2": true },
      status: "active"
    }
  ], null, 2));
  process.exit(1);
}

let users;
try {
  users = JSON.parse(fs.readFileSync(usersFile, "utf-8"));
} catch (err) {
  console.error("[ERROR] Failed to parse users.json:", err.message);
  process.exit(1);
}

if (!Array.isArray(users) || users.length === 0) {
  console.error("[ERROR] users.json must be a non-empty array of user objects.");
  process.exit(1);
}

// ─── Validate each user object ────────────────────────────────────────────────
const required = ["email", "password", "name", "role"];
const validRoles = ["Admin", "Manager", "Field Officer", "Veterinary Officer", "Data Entry"];

for (let i = 0; i < users.length; i++) {
  const u = users[i];
  const missing = required.filter((f) => !u[f] || String(u[f]).trim() === "");
  if (missing.length > 0) {
    console.error(`[ERROR] User at index ${i} (${u.email || "no email"}): missing fields: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (!validRoles.includes(u.role)) {
    console.warn(`[WARN] User "${u.email}" has role "${u.role}" — expected one of: ${validRoles.join(", ")}`);
  }
}

// ─── Helper: Make HTTP request to emulator ────────────────────────────────────
function makeHttpRequest(url, method = "GET", body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === "https:";
    const client = isHttps ? https : http;

    const options = {
      method,
      headers: { "Content-Type": "application/json" },
    };

    const req = client.request(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = data ? JSON.parse(data) : null;
          resolve({ status: res.statusCode, data: parsed, headers: res.headers });
        } catch (err) {
          resolve({ status: res.statusCode, data, headers: res.headers });
        }
      });
    });

    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─── Helper: Create user in Auth emulator ─────────────────────────────────────
async function createUserInAuthEmulator(email, password, displayName) {
  const signUpUrl = `${EMULATOR_AUTH_URL}/v1/accounts:signUp?key=AIzaSyDyWJRlfVwEUtJ0dMfY8VKMuMj1v9z2c0I`;

  const body = {
    email,
    password,
    displayName,
    returnSecureToken: true,
  };

  try {
    const response = await makeHttpRequest(signUpUrl, "POST", body);
    if (response.status !== 200) {
      throw new Error(`Auth emulator error: ${response.status} - ${JSON.stringify(response.data)}`);
    }
    return response.data.localId;
  } catch (err) {
    if (err.message.includes("EMAIL_EXISTS")) {
      return null;
    }
    throw err;
  }
}

// ─── Helper: Get user by email in Auth emulator ───────────────────────────────
async function getUserInAuthEmulator(email) {
  const lookupUrl = `${EMULATOR_AUTH_URL}/v1/accounts:lookup?key=AIzaSyDyWJRlfVwEUtJ0dMfY8VKMuMj1v9z2c0I`;

  const body = { email: [email] };

  try {
    const response = await makeHttpRequest(lookupUrl, "POST", body);
    if (response.status === 200 && response.data.users && response.data.users.length > 0) {
      return response.data.users[0].localId;
    }
    return null;
  } catch (err) {
    throw err;
  }
}

// ─── Helper: Write to emulator database ────────────────────────────────────────
async function writeToEmulatorDatabase(path, data) {
  const writeUrl = `${EMULATOR_DB_URL}/${path}.json`;

  const response = await makeHttpRequest(writeUrl, "PUT", data);
  if (response.status !== 200) {
    throw new Error(`Database emulator error: ${response.status} - ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

// ─── Create user function (supports both production and emulator) ───────────────
const results = {
  created: [],
  updated: [],
  skipped: [],
  failed: [],
};

async function createUser(userRecord) {
  const { email, password, name, phoneNumber, role, allowedProgrammes, status, userAttribute } = userRecord;

  let uid;
  let wasCreated = false;

  if (USE_EMULATOR) {
    // ─ Emulator path ──────────────────────────────────────────────────────────
    try {
      // Try to create the user
      uid = await createUserInAuthEmulator(email, password, name);

      if (!uid) {
        // User exists, fetch existing
        uid = await getUserInAuthEmulator(email);
        if (!uid) {
          return { status: "skipped", email, reason: "exists but could not fetch", error: "unknown" };
        }
        console.log(`  [SKIP-AUTH] ${email} — already exists, fetching existing user...`);
      } else {
        wasCreated = true;
      }
    } catch (err) {
      throw err;
    }
  } else {
    // ─ Production path ────────────────────────────────────────────────────────
    const auth = admin.auth();

    try {
      const userAuth = await auth.createUser({
        email,
        password,
        displayName: name,
        emailVerified: false,
        disabled: status === "inactive",
      });
      uid = userAuth.uid;
      wasCreated = true;
    } catch (err) {
      if (err.code === "auth/email-already-exists") {
        console.log(`  [SKIP-AUTH] ${email} — already exists, fetching existing user...`);
        try {
          const userAuth = await auth.getUserByEmail(email);
          uid = userAuth.uid;
        } catch (fetchErr) {
          return { status: "skipped", email, reason: "exists but could not fetch", error: fetchErr.message };
        }
      } else {
        throw err;
      }
    }
  }

  // 2. Build the RTDB profile (matching the exact schema the app expects)
  const now = Date.now();
  const profile = {
    uid,
    email,
    name,
    phoneNumber: phoneNumber || "",
    role,
    status: status || "active",
    allowedProgrammes: allowedProgrammes || { KPMD: true, RANGE: true, "KPMD 2": true },
    accessControl: {
      customAttribute: userAttribute || null,
    },
    createdAt: now,
    updatedAt: now,
    lastLogin: null,
  };

  // 3. Write to RTDB under /users/{uid}
  if (USE_EMULATOR) {
    await writeToEmulatorDatabase(`users/${uid}`, profile);
  } else {
    const db = admin.database();
    await db.ref(`users/${uid}`).set(profile);
  }

  if (wasCreated) {
    console.log(`  [CREATED]  ${email} → uid: ${uid}, role: ${role}`);
    return { status: "created", email, uid, role, name };
  } else {
    console.log(`  [UPDATED]  ${email} → uid: ${uid}, role: ${role} (RTDB profile updated)`);
    return { status: "updated", email, uid, role, name };
  }
}

async function main() {
  const modeText = USE_EMULATOR ? "Firebase Emulator" : "Production Firebase";
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  Genco — Bulk User Creation (${modeText})`);
  console.log(`  Processing ${users.length} user(s) from users.json`);
  console.log(`═══════════════════════════════════════════════════════\n`);

  for (let i = 0; i < users.length; i++) {
    const user = users[i];
    console.log(`[${i + 1}/${users.length}] Processing: ${user.email}`);

    try {
      const result = await createUser(user);
      if (result.status === "created") results.created.push(result);
      else if (result.status === "updated") results.updated.push(result);
      else results.skipped.push(result);
    } catch (err) {
      const msg = err.code || err.message;
      console.error(`  [FAILED]  ${user.email} → ${msg}`);
      results.failed.push({ email: user.email, error: msg });
    }

    // Small delay to avoid rate limiting
    if (i < users.length - 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`═══════════════════════════════════════════════════════`);
  console.log(`  Created:  ${results.created.length}`);
  console.log(`  Updated:  ${results.updated.length}`);
  console.log(`  Skipped:  ${results.skipped.length}`);
  console.log(`  Failed:   ${results.failed.length}`);
  console.log(`  Total:    ${users.length}`);
  console.log(`═══════════════════════════════════════════════════════`);

  if (results.created.length > 0) {
    console.log("\n  Created users:");
    results.created.forEach((u) => {
      console.log(`    + ${u.email}  (uid: ${u.uid}, role: ${u.role})`);
    });
  }

  if (results.updated.length > 0) {
    console.log("\n  Updated profiles:");
    results.updated.forEach((u) => {
      console.log(`    ~ ${u.email}  (uid: ${u.uid}, role: ${u.role})`);
    });
  }

  if (results.failed.length > 0) {
    console.log("\n  Failed:");
    results.failed.forEach((u) => {
      console.log(`    x ${u.email}  →  ${u.error}`);
    });
  }

  // Save report
  const reportPath = path.resolve(__dirname, "users-report.json");
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`\n  Report saved to: ${reportPath}\n`);

  process.exit(results.failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});