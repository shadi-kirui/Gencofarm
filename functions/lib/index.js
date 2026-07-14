"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateLastLogin = exports.userProfile = exports.health = exports.cacheStats = exports.batchDelete = exports.remove = exports.setRecord = exports.update = exports.create = exports.authVerify = exports.queryEndpoint = exports.record = exports.batchData = exports.data = void 0;
const admin = __importStar(require("firebase-admin"));
const functions = __importStar(require("firebase-functions"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ─── CORS (manual — never drops headers even on thrown errors) ──────────────
const ALLOWED_ORIGINS = [
    "http://localhost:8080",
    "http://127.0.0.1:8080",
    "https://gencofarm.com",
    "https://www.gencofarm.com",
];
const corsHeaders = (req) => {
    const origin = req.headers.origin || "";
    const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        "Access-Control-Allow-Origin": allowed,
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Requested-With, If-None-Match",
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Max-Age": "86400",
    };
};
/** Wraps any handler so CORS headers are ALWAYS set, even on errors. */
const withCors = (handler) => async (req, res) => {
    // Handle preflight
    if (req.method === "OPTIONS") {
        res.set(corsHeaders(req)).status(204).send("");
        return;
    }
    // Set CORS headers on every response
    res.set(corsHeaders(req));
    try {
        await handler(req, res);
    }
    catch (err) {
        console.error("Unhandled function error:", err);
        if (!res.headersSent) {
            res.status(500).json({ error: err?.message || "Internal server error" });
        }
    }
};
// ─── Lazy Admin Init ────────────────────────────────────────────────────────
let _initialized = false;
const ensureAdmin = () => {
    if (_initialized)
        return;
    try {
        const saPath = path.join(__dirname, "service-account-key.json");
        if (fs.existsSync(saPath)) {
            admin.initializeApp({
                credential: admin.credential.cert(require(saPath)),
                databaseURL: "https://genco-export-default-rtdb.firebaseio.com",
            });
        }
        else {
            admin.initializeApp({
                databaseURL: "https://genco-export-default-rtdb.firebaseio.com",
            });
        }
        _initialized = true;
    }
    catch (err) {
        console.error("Firebase admin init failed:", err);
        throw new Error("Server initialization failed");
    }
};
// ─── Auth ───────────────────────────────────────────────────────────────────
const verifyUser = async (authHeader) => {
    if (!authHeader?.startsWith("Bearer "))
        return null;
    ensureAdmin();
    try {
        return await admin.auth().verifyIdToken(authHeader.slice(7));
    }
    catch {
        return null;
    }
};
// ─── LRU Memory Cache ───────────────────────────────────────────────────────
const CACHE_MAX_ENTRIES = 200;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
class MemoryCache {
    store = new Map();
    accessOrder = new Set();
    get(key) {
        const entry = this.store.get(key);
        if (!entry)
            return null;
        if (Date.now() - entry.ts > CACHE_TTL_MS) {
            this.store.delete(key);
            this.accessOrder.delete(key);
            return null;
        }
        // LRU: move to most-recently-used
        this.accessOrder.delete(key);
        this.accessOrder.add(key);
        return entry;
    }
    set(key, data, version) {
        // Evict oldest if at capacity
        if (this.store.size >= CACHE_MAX_ENTRIES && !this.store.has(key)) {
            const oldest = this.accessOrder.values().next().value;
            if (oldest) {
                this.store.delete(oldest);
                this.accessOrder.delete(oldest);
            }
        }
        this.store.set(key, { data, version, ts: Date.now() });
        this.accessOrder.delete(key);
        this.accessOrder.add(key);
    }
    delete(key) {
        this.store.delete(key);
        this.accessOrder.delete(key);
    }
    invalidateByPrefix(prefix) {
        for (const key of [...this.store.keys()]) {
            if (key.startsWith(prefix)) {
                this.store.delete(key);
                this.accessOrder.delete(key);
            }
        }
    }
    get size() {
        return this.store.size;
    }
}
const cache = new MemoryCache();
// ─── Utility: ETag generation ──────────────────────────────────────────────
const generateEtag = (data) => {
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
    }
    return `"${Math.abs(hash).toString(36)}"`;
};
// ─── Utility: Snapshot to records ───────────────────────────────────────────
const snapToRecords = (snap) => {
    if (!snap.exists())
        return [];
    const v = snap.val();
    if (typeof v !== "object" || v === null)
        return [];
    return Object.entries(v).map(([id, val]) => ({ id, ...val }));
};
// ─── Utility: Version hash ──────────────────────────────────────────────────
const computeVersion = (records) => {
    let h = 0;
    for (const r of records) {
        const json = JSON.stringify(r);
        for (let i = 0; i < json.length; i++) {
            h = ((h << 5) - h + json.charCodeAt(i)) | 0;
        }
    }
    return Math.abs(h);
};
// ─── Utility: Programme filter on server ────────────────────────────────────
const filterByProgramme = (records, programme) => {
    if (!programme || ["ALL", "ALL PROGRAMMES"].includes(programme.trim().toUpperCase()))
        return records;
    const upper = programme.trim().toUpperCase();
    return records.filter((r) => {
        const p1 = String(r.programme || "").trim().toUpperCase();
        const p2 = String(r.Programme || "").trim().toUpperCase();
        return p1 === upper || p2 === upper;
    });
};
const filterByProgrammes = (records, programmes) => {
    const allowed = new Set((programmes || []).map(normalizeProgrammeAccessValue).filter(Boolean));
    if (allowed.size === 0)
        return records;
    return records.filter((record) => allowed.has(normalizeProgrammeAccessValue(record.programme ?? record.Programme)));
};
const PROGRAMME_SCOPED_COLLECTIONS = new Set([
    "Recent Activities",
    "AnimalHealthActivities",
    "BoreholeStorage",
    "HayStorage",
    "Onboarding",
    "farmers",
    "fodderFarmers",
    "capacityBuilding",
    "offtakes",
    "orders",
    "requisitions",
    "activities",
    "boreholes",
    "training",
]);
const normalizeAccessToken = (value) => String(value ?? "").trim().toLowerCase().replace(/[-_]+/g, " ").replace(/\s+/g, " ");
const normalizeProgrammeAccessValue = (value) => {
    const normalized = String(value ?? "").trim().toUpperCase();
    if (normalized === "KPMD-2")
        return "KPMD 2";
    if (normalized === "KPMD" || normalized === "RANGE" || normalized === "KPMD 2")
        return normalized;
    return "";
};
const getCollectionRoot = (pathValue) => pathValue.replace(/^\/+|\/+$/g, "").split("/")[0] || "";
const isProgrammeScopedPath = (pathValue) => PROGRAMME_SCOPED_COLLECTIONS.has(getCollectionRoot(pathValue));
const getRecordProgramme = (record) => normalizeProgrammeAccessValue(record.programme ?? record.Programme);
const buildAllowedProgrammeSet = (allowedProgrammes) => {
    const allowed = new Set();
    if (!allowedProgrammes || typeof allowedProgrammes !== "object")
        return allowed;
    Object.entries(allowedProgrammes).forEach(([programme, enabled]) => {
        if (enabled !== true)
            return;
        const normalized = normalizeProgrammeAccessValue(programme);
        if (normalized)
            allowed.add(normalized);
    });
    return allowed;
};
const fetchUserProfileData = async (db, uid) => {
    const directSnap = await db.ref(`users/${uid}`).once("value");
    if (directSnap.exists()) {
        return directSnap.val();
    }
    const snap = await db.ref("users").orderByChild("uid").equalTo(uid).once("value");
    if (!snap.exists())
        return null;
    const entries = Object.entries(snap.val());
    const [, data] = entries[0];
    return data;
};
const resolveUserProgrammeAccess = async (db, uid) => {
    const profile = await fetchUserProfileData(db, uid);
    const role = normalizeAccessToken(profile?.role);
    const attribute = normalizeAccessToken(profile?.accessControl?.customAttribute ??
        profile?.customAttribute);
    return {
        isAdmin: role === "admin" || attribute === "admin",
        allowedProgrammes: buildAllowedProgrammeSet(profile?.allowedProgrammes),
    };
};
const filterByUserProgrammeAccess = (records, collectionPath, access) => {
    if (!isProgrammeScopedPath(collectionPath) || access.isAdmin)
        return records;
    if (access.allowedProgrammes.size === 0)
        return [];
    return records.filter((record) => {
        const programme = getRecordProgramme(record);
        return programme !== "" && access.allowedProgrammes.has(programme);
    });
};
const requestedProgrammesAllowed = (requestedProgrammes, access) => {
    if (access.isAdmin)
        return requestedProgrammes.map(normalizeProgrammeAccessValue).filter(Boolean);
    return requestedProgrammes
        .map(normalizeProgrammeAccessValue)
        .filter((programme) => programme && access.allowedProgrammes.has(programme));
};
const canWriteProgrammeRecord = (collectionPath, access, data) => {
    if (!isProgrammeScopedPath(collectionPath) || access.isAdmin)
        return true;
    if (access.allowedProgrammes.size === 0)
        return false;
    if (!data)
        return true;
    const programme = getRecordProgramme(data);
    return programme !== "" && access.allowedProgrammes.has(programme);
};
const toRecordObject = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : null;
// ─── Utility: Get RTDB reference ────────────────────────────────────────────
const getDb = () => {
    ensureAdmin();
    return admin.database();
};
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const parseRequestedFields = (value) => {
    const raw = Array.isArray(value) ? value.join(",") : String(value ?? "");
    return raw
        .split(",")
        .map((field) => field.trim())
        .filter((field) => /^[A-Za-z0-9_.$:-]+$/.test(field));
};
const projectRecordFields = (record, fields) => {
    if (fields.length === 0)
        return record;
    const projected = { id: record.id };
    fields.forEach((field) => {
        if (field === "id")
            return;
        if (Object.prototype.hasOwnProperty.call(record, field)) {
            projected[field] = record[field];
        }
    });
    return projected;
};
const projectRecordsFields = (records, fields) => fields.length === 0 ? records : records.map((record) => projectRecordFields(record, fields));
const COLLECTION_DATE_FIELDS = {
    farmers: ["createdAt", "created_at", "registrationDate", "registration_date", "registeredAt", "timestamp", "date"],
    offtakes: ["date", "Date", "purchaseDate", "purchase_date", "createdAt", "created_at"],
    capacityBuilding: ["date", "Date", "createdAt", "created_at", "trainingDate"],
    AnimalHealthActivities: ["date", "Date", "createdAt", "created_at", "vaccinationDate", "vaccination_date"],
    boreholes: ["date", "Date", "createdAt", "created_at"],
    BoreholeStorage: ["date", "Date", "createdAt", "created_at"],
    HayStorage: ["date_planted", "datePlanted", "date_sold", "dateSold", "date", "Date", "createdAt", "created_at"],
    activities: ["date", "Date", "createdAt", "created_at"],
    fodderFarmers: ["date", "Date", "createdAt", "created_at", "registrationDate", "registration_date", "registeredAt", "timestamp"],
    requisitions: ["date", "Date", "createdAt", "created_at", "requestedAt", "requestDate"],
    orders: ["date", "Date", "createdAt", "created_at", "orderDate"],
};
const DEFAULT_DATE_FIELDS = ["date", "Date", "createdAt", "created_at", "timestamp"];
const truthy = (value) => value === true || value === "true" || value === "1" || value === 1 || value === "yes";
const toSingleValue = (value) => Array.isArray(value) ? value[0] : value;
const normalizeDateInput = (value) => {
    const raw = String(toSingleValue(value) ?? "").trim();
    if (!raw)
        return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw))
        return raw;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime()))
        return null;
    return parsed.toISOString().slice(0, 10);
};
const getCurrentMonthRange = () => {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth();
    return {
        startDate: new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10),
        endDate: now.toISOString().slice(0, 10),
    };
};
const resolveDateRange = (input) => {
    const source = input || {};
    const nested = source.dateRange || {};
    const noDateFilter = truthy(source.noDateFilter);
    if (noDateFilter) {
        return {
            startDate: "",
            endDate: "",
            disabled: true,
            explicit: true,
            key: "no-date-filter",
        };
    }
    const startDate = normalizeDateInput(nested.startDate ?? source.startDate);
    const endDate = normalizeDateInput(nested.endDate ?? source.endDate);
    if (startDate && endDate) {
        return {
            startDate,
            endDate,
            disabled: false,
            explicit: true,
            key: `${startDate}:${endDate}`,
        };
    }
    const currentMonth = getCurrentMonthRange();
    return {
        ...currentMonth,
        disabled: false,
        explicit: false,
        key: `${currentMonth.startDate}:${currentMonth.endDate}`,
    };
};
const resolvePagination = (input) => {
    const source = input || {};
    const fetchAll = truthy(source.fetchAll);
    const parsedPage = Number.parseInt(String(toSingleValue(source.page) ?? "1"), 10);
    const parsedLimit = Number.parseInt(String(toSingleValue(source.limit) ?? String(DEFAULT_PAGE_LIMIT)), 10);
    const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const requestedLimit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : DEFAULT_PAGE_LIMIT;
    const limit = Math.min(requestedLimit, MAX_PAGE_LIMIT);
    return {
        page,
        limit,
        fetchAll,
        offset: (page - 1) * limit,
    };
};
const getDateFieldsForCollection = (collectionPath, requestedOrderBy) => {
    const normalized = collectionPath.replace(/^\/+|\/+$/g, "");
    const base = normalized.split("/")[0];
    const configured = COLLECTION_DATE_FIELDS[normalized] || COLLECTION_DATE_FIELDS[base] || DEFAULT_DATE_FIELDS;
    return requestedOrderBy && !configured.includes(requestedOrderBy)
        ? [requestedOrderBy, ...configured]
        : configured;
};
const parseDateValue = (value) => {
    if (!value)
        return null;
    if (value instanceof Date)
        return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "number") {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof value === "string") {
        const parsed = new Date(value);
        return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    if (typeof value === "object" && value !== null) {
        const record = value;
        const seconds = record.seconds ?? record._seconds;
        if (typeof seconds === "number") {
            const parsed = new Date(seconds * 1000);
            return Number.isNaN(parsed.getTime()) ? null : parsed;
        }
    }
    return null;
};
const getRecordDate = (record, fields) => {
    for (const field of fields) {
        const parsed = parseDateValue(record[field]);
        if (parsed)
            return parsed;
    }
    return null;
};
const getRangeBounds = (range) => {
    if (!range?.startDate || !range?.endDate || ("disabled" in range && range.disabled))
        return null;
    const start = new Date(`${range.startDate}T00:00:00.000Z`);
    const end = new Date(`${range.endDate}T23:59:59.999Z`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
        return null;
    return {
        start,
        end,
        startMs: start.getTime(),
        endMs: end.getTime(),
        startDate: range.startDate,
        endDate: range.endDate,
    };
};
const isInDateRange = (record, dateFields, range) => {
    const bounds = getRangeBounds(range);
    if (!bounds)
        return true;
    const date = getRecordDate(record, dateFields);
    if (!date)
        return false;
    const time = date.getTime();
    return time >= bounds.startMs && time <= bounds.endMs;
};
const fetchDateRangeRecords = async (db, collectionPath, dateFields, range) => {
    const bounds = getRangeBounds(range);
    if (!bounds) {
        const snap = await db.ref(collectionPath).once("value");
        return snapToRecords(snap);
    }
    const recordsById = new Map();
    await Promise.all(dateFields.flatMap((field) => [
        db.ref(collectionPath)
            .orderByChild(field)
            .startAt(bounds.startDate)
            .endAt(`${bounds.endDate}\uf8ff`)
            .once("value")
            .then((snap) => snapToRecords(snap).forEach((record) => recordsById.set(record.id, record)))
            .catch(() => undefined),
        db.ref(collectionPath)
            .orderByChild(field)
            .startAt(bounds.startMs)
            .endAt(bounds.endMs)
            .once("value")
            .then((snap) => snapToRecords(snap).forEach((record) => recordsById.set(record.id, record)))
            .catch(() => undefined),
    ]));
    return [...recordsById.values()].filter((record) => isInDateRange(record, dateFields, range));
};
const numberField = (record, ...fields) => {
    for (const field of fields) {
        const value = record[field];
        if (value === undefined || value === null || value === "")
            continue;
        if (typeof value === "number" && Number.isFinite(value))
            return value;
        const parsed = Number(String(value).replace(/,/g, "").trim());
        if (Number.isFinite(parsed))
            return parsed;
    }
    return 0;
};
const boolField = (value) => {
    if (typeof value === "boolean")
        return value;
    if (typeof value === "number")
        return value === 1;
    const normalized = String(value ?? "").trim().toLowerCase();
    return ["true", "yes", "1"].includes(normalized);
};
const arrayLikeSize = (value) => {
    if (Array.isArray(value))
        return value.length;
    if (value && typeof value === "object")
        return Object.keys(value).length;
    return 0;
};
const goatTotal = (value) => {
    if (typeof value === "number" || typeof value === "string")
        return numberField({ value }, "value");
    if (Array.isArray(value))
        return value.length;
    if (value && typeof value === "object") {
        const record = value;
        return Math.max(numberField(record, "total", "goats", "goat", "noOfGoats", "numberOfGoats", "totalGoats"), numberField(record, "male") + numberField(record, "female"));
    }
    return 0;
};
const farmerGoats = (record) => Math.max(goatTotal(record.goats ?? record.Goats), numberField(record, "goats", "goat", "noOfGoats", "numberOfGoats", "totalGoats"), arrayLikeSize(record.goats), arrayLikeSize(record.Goats));
const offtakeGoats = (record) => Math.max(numberField(record, "totalGoats", "goats_purchased", "goatsPurchased", "goatsBought", "goats", "goat", "noOfGoats", "numberOfGoats"), arrayLikeSize(record.goats), arrayLikeSize(record.Goats));
const monthLabels = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const seriesColors = ["#2710a1", "#f89b0d", "#ffea00", "#2cb100", "#0ea5e9", "#ef4444"];
const countyColors = seriesColors.slice(0, 4);
const yearlySegments = (records, dateFields) => {
    const counts = new Map();
    records.forEach((record) => {
        const date = getRecordDate(record, dateFields);
        if (!date)
            return;
        counts.set(date.getFullYear(), (counts.get(date.getFullYear()) || 0) + 1);
    });
    return [...counts.entries()].sort(([a], [b]) => a - b).map(([year, value], index) => ({
        name: String(year),
        value,
        color: seriesColors[index % seriesColors.length],
    }));
};
const annualComparison = (farmers, offtakes) => {
    const years = new Set();
    const onRecord = new Map();
    const purchased = new Map();
    farmers.forEach((record) => {
        const date = getRecordDate(record, ["createdAt", "created_at", "registrationDate", "registration_date", "registeredAt", "timestamp", "date"]);
        if (!date)
            return;
        const year = date.getFullYear();
        years.add(year);
        onRecord.set(year, (onRecord.get(year) || 0) + farmerGoats(record));
    });
    offtakes.forEach((record) => {
        const date = getRecordDate(record, ["date", "Date", "createdAt", "created_at"]);
        if (!date)
            return;
        const year = date.getFullYear();
        years.add(year);
        purchased.set(year, (purchased.get(year) || 0) + offtakeGoats(record));
    });
    const sortedYears = [...years].sort((a, b) => a - b);
    return {
        years: sortedYears,
        data: sortedYears.map((year) => ({
            name: String(year),
            goatsOnRecord: onRecord.get(year) || 0,
            goatsPurchased: purchased.get(year) || 0,
        })),
    };
};
const vaccinationTrend = (farmers) => {
    const years = new Set();
    farmers.forEach((record) => {
        if (!boolField(record.vaccinated))
            return;
        const date = getRecordDate(record, ["vaccinationDate", "vaccination_date", "dateVaccinated", "date_vaccinated", "updatedAt", "updated_at"]);
        if (date && farmerGoats(record) > 0)
            years.add(date.getFullYear());
    });
    const sortedYears = [...years].sort((a, b) => a - b);
    const data = monthLabels.map((name) => {
        const point = { name };
        sortedYears.forEach((year) => { point[String(year)] = 0; });
        return point;
    });
    farmers.forEach((record) => {
        if (!boolField(record.vaccinated))
            return;
        const date = getRecordDate(record, ["vaccinationDate", "vaccination_date", "dateVaccinated", "date_vaccinated", "updatedAt", "updated_at"]);
        const total = farmerGoats(record);
        if (!date || total <= 0 || !sortedYears.includes(date.getFullYear()))
            return;
        const key = String(date.getFullYear());
        data[date.getMonth()][key] = Number(data[date.getMonth()][key] || 0) + total;
    });
    return { years: sortedYears, data };
};
const recentFarmers = (farmers) => [...farmers]
    .map((record) => ({
    id: String(record.id || ""),
    name: String(record.fullName || record.name || record.farmerName || `${record.firstName || ""} ${record.lastName || ""}`.trim()).trim() || "Unknown farmer",
    county: String(record.county || record.region || "").trim() || "Unknown county",
    registeredAt: getRecordDate(record, ["createdAt", "created_at", "registrationDate", "registration_date", "registeredAt", "timestamp", "date"])?.toISOString() || "",
    gender: String(record.gender || "").trim(),
    goats: farmerGoats(record),
}))
    .filter((record) => record.registeredAt)
    .sort((a, b) => new Date(b.registeredAt).getTime() - new Date(a.registeredAt).getTime())
    .slice(0, 5);
const recentActivities = (activities) => [...activities]
    .map((record, index) => ({
    id: String(record.id || record.activityId || `activity-${index + 1}`),
    activityName: String(record.activityName || record.title || "Untitled activity").trim() || "Untitled activity",
    date: String(record.date || record.createdAt || ""),
    status: String(record.status || "pending").trim() || "pending",
    location: String(record.location || record.activityName || record.county || "Unknown location").trim() || "Unknown location",
    participants: Math.max(numberField(record, "numberOfPersons", "participantsCount"), arrayLikeSize(record.participants)),
}))
    .filter((record) => parseDateValue(record.date))
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 3);
const buildOverviewSummary = ({ farmers, capacity, offtakes, boreholes, activities, }) => {
    const countyMap = {};
    let maleFarmers = 0;
    let femaleFarmers = 0;
    let totalGoats = 0;
    let totalSheep = 0;
    let totalCattle = 0;
    farmers.forEach((farmer) => {
        const gender = String(farmer.gender || "").trim().toLowerCase();
        if (gender === "male")
            maleFarmers += 1;
        if (gender === "female")
            femaleFarmers += 1;
        totalGoats += farmerGoats(farmer);
        totalSheep += numberField(farmer, "sheep");
        totalCattle += numberField(farmer, "cattle");
        const county = String(farmer.county || farmer.region || "").trim();
        if (county)
            countyMap[county] = (countyMap[county] || 0) + 1;
    });
    const countyCoverage = Object.entries(countyMap)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 4)
        .map(([name, value], index) => ({ name, value, color: countyColors[index % countyColors.length] }));
    return {
        stats: {
            totalFarmers: farmers.length,
            maleFarmers,
            femaleFarmers,
            trainedFarmers: capacity.reduce((sum, record) => sum + numberField(record, "totalFarmers", "trainedFarmers"), 0),
            totalAnimals: totalGoats + totalSheep + totalCattle,
            totalGoats,
            totalSheep,
            totalCattle,
            totalGoatsPurchased: offtakes.reduce((sum, record) => sum + offtakeGoats(record), 0),
            countiesCovered: Object.keys(countyMap).length,
        },
        maintainedInfrastructure: [
            { name: "Drilled", value: boreholes.filter((record) => boolField(record.drilled ?? record.Drilled)).length, color: "#2710a1" },
            { name: "Equipped", value: boreholes.filter((record) => boolField(record.equipped ?? record.Equipped ?? record.equiped ?? record.Equiped)).length, color: "#0ea5e9" },
            { name: "Maintained", value: boreholes.filter((record) => boolField(record.maintained ?? record.Maintained ?? record.maintaned ?? record.Maintaned ?? record.rehabilitated ?? record.Rehabilitated)).length, color: "#f89b0d" },
        ],
        registrationComparison: yearlySegments(farmers, ["createdAt", "created_at", "registrationDate", "registration_date", "registeredAt", "timestamp", "date"]),
        animalCensusComparison: annualComparison(farmers, offtakes),
        vaccinationTrend: vaccinationTrend(farmers),
        countyCoverage: countyCoverage.length ? countyCoverage : countyColors.map((color, index) => ({ name: `County ${index + 1}`, value: 0, color })),
        recentLocations: [],
        recentActivities: recentActivities(activities),
        recentFarmers: recentFarmers(farmers),
        pendingActivitiesCount: activities.filter((record) => String(record.status || "").trim().toLowerCase() === "pending").length,
        capacity,
        offtakes: [...offtakes]
            .sort((a, b) => (getRecordDate(b, ["date", "Date", "createdAt", "created_at"])?.getTime() || 0) - (getRecordDate(a, ["date", "Date", "createdAt", "created_at"])?.getTime() || 0))
            .slice(0, 8),
    };
};
const fetchOverviewSummaryRecords = async (db, collectionPath, dateFields, dateRange) => {
    try {
        const snap = await db.ref(collectionPath).once("value");
        return snapToRecords(snap).filter((record) => isInDateRange(record, dateFields, dateRange));
    }
    catch (error) {
        console.error(`Failed to load overview collection ${collectionPath}:`, error);
        return [];
    }
};
// ═══════════════════════════════════════════════════════════════════════════════
// READ ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════
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
 */
exports.data = functions.https.onRequest(withCors(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const collectionPath = req.query.path;
    if (!collectionPath) {
        res.status(400).json({ error: "Missing 'path'" });
        return;
    }
    const programme = req.query.programme;
    const sinceVersion = req.query.sinceVersion ? parseInt(req.query.sinceVersion, 10) : null;
    const orderBy = req.query.orderBy;
    const fields = parseRequestedFields(req.query.fields);
    const dateRange = resolveDateRange(req.query);
    const pagination = resolvePagination(req.query);
    const dateFields = getDateFieldsForCollection(collectionPath, orderBy);
    const db = getDb();
    const access = await resolveUserProgrammeAccess(db, user.uid);
    const cacheKey = `${collectionPath}:${programme || "all"}:${orderBy || "none"}:${dateRange.key}`;
    // Check cache (skip pagination check — cache the full filtered set)
    const cached = cache.get(cacheKey);
    if (cached) {
        const accessibleRecords = filterByUserProgrammeAccess(cached.data.data, collectionPath, access);
        const accessibleVersion = computeVersion(accessibleRecords);
        if (sinceVersion !== null && accessibleVersion === sinceVersion) {
            res.status(304).send("");
            return;
        }
        let result = accessibleRecords;
        if (!pagination.fetchAll) {
            result = result.slice(pagination.offset, pagination.offset + pagination.limit);
        }
        result = projectRecordsFields(result, fields);
        const accessibleResponseData = {
            version: accessibleVersion,
            count: accessibleRecords.length,
            data: result,
        };
        const etag = generateEtag(accessibleResponseData);
        const clientEtag = req.headers["if-none-match"];
        if (clientEtag === etag) {
            res.set("ETag", etag);
            res.status(304).send("");
            return;
        }
        res.set("ETag", etag);
        res.json({
            version: accessibleResponseData.version,
            count: accessibleRecords.length,
            data: result,
            page: pagination.page,
            limit: pagination.fetchAll ? result.length : pagination.limit,
            fetchAll: pagination.fetchAll,
            dateRange: dateRange.disabled ? null : { startDate: dateRange.startDate, endDate: dateRange.endDate },
        });
        return;
    }
    // Fetch from RTDB
    let records = await fetchDateRangeRecords(db, collectionPath, dateFields, dateRange);
    if (programme)
        records = filterByProgramme(records, programme);
    if (orderBy) {
        records.sort((a, b) => {
            const va = a[orderBy];
            const vb = b[orderBy];
            if (va < vb)
                return -1;
            if (va > vb)
                return 1;
            return 0;
        });
    }
    const rawVersion = computeVersion(records);
    const responseData = { version: rawVersion, count: records.length, data: records };
    // Cache the full programme/date-filtered result once, then apply user access per response.
    cache.set(cacheKey, responseData, rawVersion);
    const accessibleRecords = filterByUserProgrammeAccess(records, collectionPath, access);
    const version = computeVersion(accessibleRecords);
    const accessibleResponseData = { version, count: accessibleRecords.length, data: accessibleRecords };
    // ETag support
    const etag = generateEtag(accessibleResponseData);
    const clientEtag = req.headers["if-none-match"];
    if (clientEtag === etag) {
        res.set("ETag", etag);
        res.status(304).send("");
        return;
    }
    // Apply pagination for response
    let responseRecords = accessibleRecords;
    if (!pagination.fetchAll) {
        responseRecords = accessibleRecords.slice(pagination.offset, pagination.offset + pagination.limit);
    }
    responseRecords = projectRecordsFields(responseRecords, fields);
    res.set("ETag", etag);
    res.json({
        version,
        count: accessibleRecords.length,
        data: responseRecords,
        page: pagination.page,
        limit: pagination.fetchAll ? responseRecords.length : pagination.limit,
        fetchAll: pagination.fetchAll,
        dateRange: dateRange.disabled ? null : { startDate: dateRange.startDate, endDate: dateRange.endDate },
    });
}));
exports.batchData = functions.https.onRequest(withCors(async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const inputRequests = Array.isArray(req.body?.requests) ? req.body.requests : [];
    if (inputRequests.length === 0) {
        res.status(400).json({ error: "Missing 'requests'" });
        return;
    }
    if (inputRequests.length > 20) {
        res.status(400).json({ error: "Too many batch requests" });
        return;
    }
    const db = getDb();
    const access = await resolveUserProgrammeAccess(db, user.uid);
    const results = {};
    await Promise.all(inputRequests.map(async (request, index) => {
        const collectionPath = String(request.path || "").trim();
        const key = String(request.key || collectionPath || index);
        try {
            if (!collectionPath) {
                results[key] = { version: 0, count: 0, data: [] };
                return;
            }
            const options = request.options && typeof request.options === "object" ? request.options : {};
            const orderBy = typeof request.orderBy === "string" ? request.orderBy : undefined;
            const dateRange = resolveDateRange(options);
            const pagination = resolvePagination(options);
            const dateFields = getDateFieldsForCollection(collectionPath, orderBy);
            const fields = parseRequestedFields(options.fields);
            const programmes = Array.isArray(request.programmes)
                ? request.programmes.map((programme) => String(programme))
                : [];
            const programme = typeof request.programme === "string" ? request.programme : undefined;
            const programmeKey = programme || programmes.map(normalizeProgrammeAccessValue).sort().join("|") || "all";
            const cacheKey = ["batch", collectionPath, programmeKey, orderBy || "none", dateRange.key].join(":");
            let records;
            const cached = cache.get(cacheKey);
            if (cached) {
                records = cached.data.data;
            }
            else {
                records = await fetchDateRangeRecords(db, collectionPath, dateFields, dateRange);
                records = filterByProgramme(records, programme);
                records = filterByProgrammes(records, programmes);
                if (orderBy) {
                    records.sort((a, b) => {
                        const va = a[orderBy];
                        const vb = b[orderBy];
                        if (va < vb)
                            return -1;
                        if (va > vb)
                            return 1;
                        return 0;
                    });
                }
                const rawVersion = computeVersion(records);
                cache.set(cacheKey, { version: rawVersion, count: records.length, data: records }, rawVersion);
            }
            const accessibleRecords = filterByUserProgrammeAccess(records, collectionPath, access);
            const version = computeVersion(accessibleRecords);
            const pageRecords = pagination.fetchAll
                ? accessibleRecords
                : accessibleRecords.slice(pagination.offset, pagination.offset + pagination.limit);
            results[key] = {
                version,
                count: accessibleRecords.length,
                data: projectRecordsFields(pageRecords, fields),
                page: pagination.page,
                limit: pagination.fetchAll ? pageRecords.length : pagination.limit,
                fetchAll: pagination.fetchAll,
                dateRange: dateRange.disabled ? null : { startDate: dateRange.startDate, endDate: dateRange.endDate },
            };
        }
        catch (error) {
            console.error(`Batch data request failed for ${collectionPath || key}:`, error);
            results[key] = {
                version: 0,
                count: 0,
                data: [],
                error: error?.message || "Batch item failed",
            };
        }
    }));
    res.json({ results });
}));
/**
 * GET /api/record — Read a single record by path
 *
 * Query params:
 *   path  (required) — Full RTDB path to the record (e.g. "requisitions/abc123")
 */
exports.record = functions.https.onRequest(withCors(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const recordPath = req.query.path;
    if (!recordPath) {
        res.status(400).json({ error: "Missing 'path'" });
        return;
    }
    const db = getDb();
    const access = await resolveUserProgrammeAccess(db, user.uid);
    const cacheKey = `record:${recordPath}:${user.uid}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        if (filterByUserProgrammeAccess([cached.data], recordPath, access).length === 0) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        res.json(cached.data);
        return;
    }
    const snap = await db.ref(recordPath).once("value");
    if (!snap.exists()) {
        res.status(404).json({ error: "Record not found" });
        return;
    }
    const data = { id: snap.key, ...snap.val() };
    if (filterByUserProgrammeAccess([data], recordPath, access).length === 0) {
        res.status(403).json({ error: "Forbidden" });
        return;
    }
    cache.set(cacheKey, data, computeVersion([data]));
    res.json(data);
}));
/**
 * POST /api/query — Run a filtered query (replaces onValue/query/orderByChild/equalTo)
 *
 * Body:
 *   path        (required) — Collection path
 *   filters     (optional) — [{ field, operator, value }]
 *   programmes  (optional) — string[] — shorthand for programme OR filter
 *   orderBy     (optional) — string — field to order by
 */
exports.queryEndpoint = functions.https.onRequest(withCors(async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const { path: collectionPath, programmes, orderBy } = req.body || {};
    if (!collectionPath) {
        res.status(400).json({ error: "Missing 'path'" });
        return;
    }
    const dateRange = resolveDateRange(req.body || {});
    const pagination = resolvePagination(req.body || {});
    const dateFields = getDateFieldsForCollection(collectionPath, orderBy);
    const db = getDb();
    const access = await resolveUserProgrammeAccess(db, user.uid);
    // Build cache key
    const cacheKey = `query:${collectionPath}:${JSON.stringify(programmes || [])}:${orderBy || "none"}:${dateRange.key}:${user.uid}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        const accessibleRecords = filterByUserProgrammeAccess(cached.data.data, collectionPath, access);
        const records = pagination.fetchAll
            ? accessibleRecords
            : accessibleRecords.slice(pagination.offset, pagination.offset + pagination.limit);
        res.json({
            ...cached.data,
            count: accessibleRecords.length,
            data: records,
            page: pagination.page,
            limit: pagination.fetchAll ? records.length : pagination.limit,
            fetchAll: pagination.fetchAll,
            dateRange: dateRange.disabled ? null : { startDate: dateRange.startDate, endDate: dateRange.endDate },
        });
        return;
    }
    let records = await fetchDateRangeRecords(db, collectionPath, dateFields, dateRange);
    if (programmes && programmes.length > 0) {
        const upperSet = new Set(requestedProgrammesAllowed(programmes, access));
        records = records.filter((r) => {
            const p1 = String(r.programme || "").trim().toUpperCase();
            const p2 = String(r.Programme || "").trim().toUpperCase();
            return upperSet.has(p1) || upperSet.has(p2);
        });
    }
    records = filterByUserProgrammeAccess(records, collectionPath, access);
    // Sort if requested
    if (orderBy) {
        records.sort((a, b) => {
            const va = a[orderBy];
            const vb = b[orderBy];
            if (va < vb)
                return -1;
            if (va > vb)
                return 1;
            return 0;
        });
    }
    const version = computeVersion(records);
    const responseData = { version, count: records.length, data: records };
    const responseRecords = pagination.fetchAll
        ? records
        : records.slice(pagination.offset, pagination.offset + pagination.limit);
    cache.set(cacheKey, responseData, version);
    res.json({
        ...responseData,
        data: responseRecords,
        page: pagination.page,
        limit: pagination.fetchAll ? responseRecords.length : pagination.limit,
        fetchAll: pagination.fetchAll,
        dateRange: dateRange.disabled ? null : { startDate: dateRange.startDate, endDate: dateRange.endDate },
    });
}));
/**
 * GET /api/auth-verify — Verify ID token and return user info
 */
exports.authVerify = functions.https.onRequest(withCors(async (req, res) => {
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    res.json({
        uid: user.uid,
        email: user.email,
        name: user.name,
        customClaims: user.customClaims || {},
    });
}));
// ═══════════════════════════════════════════════════════════════════════════════
// WRITE ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════
/** Invalidate cache entries matching a collection path */
const invalidateCacheForPath = (collectionPath) => {
    cache.invalidateByPrefix(collectionPath);
    cache.invalidateByPrefix("query:" + collectionPath);
};
const getCollectionCachePathsForWrite = (recordPath, data) => {
    const normalizedPath = String(recordPath || "").trim().replace(/^\/+|\/+$/g, "");
    if (!normalizedPath && data && typeof data === "object" && !Array.isArray(data)) {
        return Array.from(new Set(Object.keys(data)
            .map((pathValue) => pathValue.split("/").filter(Boolean)[0])
            .filter(Boolean)));
    }
    const segments = normalizedPath.split("/").filter(Boolean);
    if (segments.length === 0)
        return [];
    if (segments.length === 1)
        return [segments[0]];
    return [segments.slice(0, -1).join("/"), segments[0]];
};
const invalidateCachesForWrite = (recordPath, data) => {
    getCollectionCachePathsForWrite(recordPath, data).forEach(invalidateCacheForPath);
};
/**
 * POST /api/create — Push a new record to a collection
 */
exports.create = functions.https.onRequest(withCors(async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const { path: collectionPath, data } = req.body || {};
    if (!collectionPath || !data) {
        res.status(400).json({ error: "Missing 'path' or 'data'" });
        return;
    }
    const db = getDb();
    const access = await resolveUserProgrammeAccess(db, user.uid);
    if (!canWriteProgrammeRecord(collectionPath, access, data)) {
        res.status(403).json({ error: "Forbidden" });
        return;
    }
    const newRef = db.ref(collectionPath).push();
    await newRef.set({ createdAt: admin.database.ServerValue.TIMESTAMP, ...data });
    // Invalidate cache
    invalidateCacheForPath(collectionPath);
    res.json({ id: newRef.key });
}));
/**
 * POST /api/update — Update an existing record
 */
exports.update = functions.https.onRequest(withCors(async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const { path: recordPath, data } = req.body || {};
    if (!recordPath || !data) {
        res.status(400).json({ error: "Missing 'path' or 'data'" });
        return;
    }
    const db = getDb();
    const normalizedRecordPath = String(recordPath || "").trim().replace(/^\/+|\/+$/g, "");
    const access = await resolveUserProgrammeAccess(db, user.uid);
    if (!normalizedRecordPath && data && typeof data === "object" && !Array.isArray(data)) {
        for (const [updatePath, updateValue] of Object.entries(data)) {
            const updateSegments = updatePath.split("/").filter(Boolean);
            if (updateSegments.length === 0)
                continue;
            const collectionPath = updateSegments.length === 1 ? updateSegments[0] : updateSegments.slice(0, -1).join("/");
            const existingSnap = await db.ref(updatePath).once("value");
            const existingData = toRecordObject(existingSnap.val());
            const updateRecord = toRecordObject(updateValue);
            const mergedData = updateValue === null
                ? existingData
                : existingData && updateRecord
                    ? { ...existingData, ...updateRecord }
                    : updateRecord;
            if (!canWriteProgrammeRecord(collectionPath, access, existingData) ||
                (updateValue !== null && !canWriteProgrammeRecord(collectionPath, access, mergedData))) {
                res.status(403).json({ error: "Forbidden" });
                return;
            }
        }
    }
    else {
        const collectionPath = normalizedRecordPath.split("/").slice(0, -1).join("/") || normalizedRecordPath;
        const existingSnap = await db.ref(recordPath).once("value");
        const existingData = toRecordObject(existingSnap.val());
        const updateRecord = toRecordObject(data);
        const mergedData = existingData && updateRecord ? { ...existingData, ...updateRecord } : updateRecord;
        if (!canWriteProgrammeRecord(collectionPath, access, existingData) ||
            !canWriteProgrammeRecord(collectionPath, access, mergedData)) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
    }
    await db.ref(recordPath).update(data);
    // Invalidate caches related to this collection
    invalidateCachesForWrite(recordPath, data);
    cache.delete(`record:${recordPath}:`);
    res.json({ success: true });
}));
/**
 * POST /api/set — Overwrite a record (set)
 */
exports.setRecord = functions.https.onRequest(withCors(async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const { path: recordPath, data } = req.body || {};
    if (!recordPath || data === undefined) {
        res.status(400).json({ error: "Missing 'path' or 'data'" });
        return;
    }
    const db = getDb();
    const collectionPath = recordPath.split("/").slice(0, -1).join("/") || recordPath;
    const access = await resolveUserProgrammeAccess(db, user.uid);
    if (!canWriteProgrammeRecord(collectionPath, access, data)) {
        res.status(403).json({ error: "Forbidden" });
        return;
    }
    await db.ref(recordPath).set(data);
    invalidateCacheForPath(collectionPath);
    cache.delete(`record:${recordPath}:`);
    res.json({ success: true });
}));
/**
 * DELETE /api/delete — Remove a record
 */
exports.remove = functions.https.onRequest(withCors(async (req, res) => {
    if (req.method !== "DELETE" && req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const recordPath = (req.method === "DELETE" ? req.query.path : req.body?.path);
    if (!recordPath) {
        res.status(400).json({ error: "Missing 'path'" });
        return;
    }
    const db = getDb();
    const collectionPath = recordPath.split("/").slice(0, -1).join("/") || recordPath;
    const access = await resolveUserProgrammeAccess(db, user.uid);
    const existingSnap = await db.ref(recordPath).once("value");
    const existingData = existingSnap.exists() ? existingSnap.val() : null;
    if (!canWriteProgrammeRecord(collectionPath, access, existingData)) {
        res.status(403).json({ error: "Forbidden" });
        return;
    }
    await db.ref(recordPath).remove();
    invalidateCacheForPath(collectionPath);
    cache.delete(`record:${recordPath}:`);
    res.json({ success: true });
}));
/**
 * POST /api/batch-delete — Remove multiple records
 */
exports.batchDelete = functions.https.onRequest(withCors(async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const { paths } = req.body || {};
    if (!Array.isArray(paths) || paths.length === 0) {
        res.status(400).json({ error: "Missing 'paths' array" });
        return;
    }
    const db = getDb();
    const access = await resolveUserProgrammeAccess(db, user.uid);
    const updates = {};
    const collectionsToInvalidate = new Set();
    for (const p of paths) {
        const collectionPath = p.split("/").slice(0, -1).join("/") || p;
        const existingSnap = await db.ref(p).once("value");
        const existingData = existingSnap.exists() ? existingSnap.val() : null;
        if (!canWriteProgrammeRecord(collectionPath, access, existingData)) {
            res.status(403).json({ error: "Forbidden" });
            return;
        }
        updates[p] = null;
        collectionsToInvalidate.add(collectionPath);
    }
    await db.ref().update(updates);
    for (const col of collectionsToInvalidate) {
        invalidateCacheForPath(col);
    }
    res.json({ success: true, deleted: paths.length });
}));
/**
 * GET /api/cache-stats — Debug: view cache status
 */
exports.cacheStats = functions.https.onRequest(withCors(async (req, res) => {
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    res.json({
        entries: cache.size,
        maxEntries: CACHE_MAX_ENTRIES,
        ttlMs: CACHE_TTL_MS,
    });
}));
/**
 * GET /api/health — Health check (no auth required)
 */
exports.health = functions.https.onRequest(withCors(async (_req, res) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        cacheEntries: cache.size,
    });
}));
// ═══════════════════════════════════════════════════════════════════════════════
// AUTH-SPECIFIC ENDPOINTS (called from AuthContext)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * GET /api/userProfile?uid=<uid>
 * Returns the user profile for the authenticated user.
 */
exports.userProfile = functions.https.onRequest(withCors(async (req, res) => {
    if (req.method !== "GET") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    ensureAdmin();
    const db = getDb();
    // Try by UID key first
    const directSnap = await db.ref(`users/${user.uid}`).once("value");
    if (directSnap.exists()) {
        res.json({ id: user.uid, ...directSnap.val() });
        return;
    }
    // Fall back to querying by uid field
    const snap = await db.ref("users").orderByChild("uid").equalTo(user.uid).once("value");
    if (!snap.exists()) {
        res.status(404).json({ error: "Profile not found" });
        return;
    }
    const entries = Object.entries(snap.val());
    const [recordId, data] = entries[0];
    res.json({ id: recordId, ...data });
}));
/**
 * POST /api/updateLastLogin
 * Updates lastLogin timestamp for authenticated user.
 */
exports.updateLastLogin = functions.https.onRequest(withCors(async (req, res) => {
    if (req.method !== "POST") {
        res.status(405).json({ error: "Method not allowed" });
        return;
    }
    const user = await verifyUser(req.headers.authorization);
    if (!user) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }
    const { recordId } = req.body || {};
    if (!recordId) {
        res.status(400).json({ error: "recordId required" });
        return;
    }
    ensureAdmin();
    const db = getDb();
    await db.ref(`users/${recordId}/lastLogin`).set(admin.database.ServerValue.TIMESTAMP);
    // Invalidate users cache
    invalidateCacheForPath("users");
    res.json({ ok: true });
}));
