/**
 * Maps client-side /api/* paths to deployed Firebase Cloud Function names.
 * Functions are exported individually (e.g. userProfile), not under an /api router.
 */
const CLOUD_FUNCTION_ROUTES: Record<string, string> = {
  "/api/data": "/data",
  "/api/batch-data": "/batchData",
  "/api/record": "/record",
  "/api/query": "/queryEndpoint",
  "/api/set": "/setRecord",
  "/api/update": "/update",
  "/api/create": "/create",
  "/api/delete": "/remove",
  "/api/userProfile": "/userProfile",
  "/api/updateLastLogin": "/updateLastLogin",
  "/api/batch-delete": "/batchDelete",
  "/api/auth-verify": "/authVerify",
  "/api/health": "/health",
  "/api/cache-stats": "/cacheStats",
};

export const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  "https://us-central1-genco-export.cloudfunctions.net";

export const resolveCloudFunctionPath = (path: string): string => {
  const [pathname, query] = path.split("?", 2);
  const resolved =
    CLOUD_FUNCTION_ROUTES[pathname] ?? pathname.replace(/^\/api\//, "/");
  return query ? `${resolved}?${query}` : resolved;
};

export const buildCloudFunctionUrl = (path: string): string =>
  `${API_BASE_URL}${resolveCloudFunctionPath(path)}`;
