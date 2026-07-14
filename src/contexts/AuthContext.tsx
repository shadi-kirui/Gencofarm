import { createContext, useContext, useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { User, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { auth, getUserProfile, touchLastLogin, fetchCollection, fetchCollectionByProgrammes } from "@/lib/firebase";
import { useToast } from "@/hooks/use-toast";
import {
  canViewAllProgrammes,
  getLandingRouteForRole,
  isActiveUserStatus,
  isMobileUser,
} from "@/contexts/authhelper";
import { resolveAccessibleProgrammes } from "@/lib/programme-access";

interface UserProfile {
  recordId: string | null;
  role: string | null;
  allowedProgrammes: Record<string, boolean> | null;
  name: string | null;
  userAttribute: string | null;
  status: string | null;
}

interface AuthContextType {
  user: User | null;
  userRole: string | null;
  userAttribute: string | null;
  userName: string | null;
  allowedProgrammes: Record<string, boolean> | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOutUser: () => Promise<void>;
}

declare global {
  var __gencoAuthContext__: ReturnType<typeof createContext<AuthContextType | undefined>> | undefined;
}

const AuthContext =
  globalThis.__gencoAuthContext__ ??
  createContext<AuthContextType | undefined>(undefined);

if (typeof globalThis !== "undefined") {
  globalThis.__gencoAuthContext__ = AuthContext;
}

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};

const ROLE_STORAGE_KEY = "user_role";

// ─── Profile polling (replaces onValue realtime listener) ─────────────────────

let profilePollTimer: ReturnType<typeof setInterval> | null = null;

const stopProfilePolling = () => {
  if (profilePollTimer) {
    clearInterval(profilePollTimer);
    profilePollTimer = null;
  }
};

export const AuthProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [userRole, setUserRole] = useState<string | null>(null);
  const [userAttribute, setUserAttribute] = useState<string | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [allowedProgrammes, setAllowedProgrammes] = useState<Record<string, boolean> | null>(null);
  const [loading, setLoading] = useState(true);
  const pendingLoginRef = useRef(false);
  const blockedSessionRef = useRef<string | null>(null);
  const profileRecordIdRef = useRef<string | null>(null);
  const { toast } = useToast();

  const clearAuthState = () => {
    setUser(null);
    setUserRole(null);
    setUserAttribute(null);
    setAllowedProgrammes(null);
    setUserName(null);
    localStorage.removeItem(ROLE_STORAGE_KEY);
    profileRecordIdRef.current = null;
    stopProfilePolling();
  };

  const extractUserAttribute = (userData: any): string | null => {
    const directAttribute = userData?.accessControl?.customAttribute;
    if (typeof directAttribute === "string" && directAttribute.trim()) {
      return directAttribute.trim();
    }

    const legacyAttributes = userData?.accessControl?.customAttributes;
    if (legacyAttributes && typeof legacyAttributes === "object") {
      const firstKey = Object.keys(legacyAttributes)[0];
      if (firstKey && firstKey.trim()) {
        return firstKey.trim();
      }
    }

    const fallbackAttribute = userData?.customAttribute;
    if (typeof fallbackAttribute === "string" && fallbackAttribute.trim()) {
      return fallbackAttribute.trim();
    }

    return null;
  };

  const extractUserStatus = (userData: any): string | null =>
    typeof userData?.status === "string" && userData.status.trim()
      ? userData.status.trim()
      : null;

  const buildUserProfile = (
    recordId: string | null,
    userData: any,
  ): UserProfile => ({
    recordId,
    role: userData?.role || null,
    allowedProgrammes: userData?.allowedProgrammes || null,
    name: userData?.name || null,
    userAttribute: extractUserAttribute(userData),
    status: extractUserStatus(userData),
  });

  const syncProfileState = (firebaseUser: User, profile: UserProfile) => {
    blockedSessionRef.current = null;
    setUser(firebaseUser);
    setUserRole(profile.role);
    setUserAttribute(profile.userAttribute);
    setAllowedProgrammes(profile.allowedProgrammes);
    setUserName(profile.name || firebaseUser.displayName || firebaseUser.email || "Admin");

    if (profile.role) {
      localStorage.setItem(ROLE_STORAGE_KEY, profile.role);
    } else {
      localStorage.removeItem(ROLE_STORAGE_KEY);
    }
  };

  const getAccessibleProgrammesForProfile = (
    profile: UserProfile,
  ): string[] =>
    resolveAccessibleProgrammes(
      canViewAllProgrammes(
        profile.role,
        profile.userAttribute,
        profile.allowedProgrammes,
      ),
      profile.allowedProgrammes,
    );

  const resolveBlockedAccessMessage = (profile: UserProfile, profileLoadFailed = false): string => {
    if (profileLoadFailed) {
      return "Could not load your account profile from the server. Please try again or contact an admin.";
    }

    if (isMobileUser(profile.role, profile.userAttribute)) {
      return "Field Officers can submit data only and cannot access the web dashboard.";
    }

    if (!isActiveUserStatus(profile.status)) {
      return "Your account has been deactivated or disabled. Contact an admin for help.";
    }

    if (getAccessibleProgrammesForProfile(profile).length === 0) {
      return "Your account is not assigned to any programme. Contact an admin for help.";
    }

    return "Your account is not authorized to access the web dashboard.";
  };

  const canAccessWebDashboard = (profile: UserProfile): boolean => {
    if (!profile.recordId) return false;
    if (isMobileUser(profile.role, profile.userAttribute)) return false;
    if (!isActiveUserStatus(profile.status)) return false;
    if (getAccessibleProgrammesForProfile(profile).length === 0) return false;
    return getLandingRouteForRole(profile.role, profile.userAttribute) !== "/auth";
  };

  const blockUserSession = async (
    firebaseUser: User,
    profile: UserProfile,
    title = "Access restricted",
    profileLoadFailed = false,
  ) => {
    stopProfilePolling();
    pendingLoginRef.current = false;
    clearAuthState();

    if (blockedSessionRef.current !== firebaseUser.uid) {
      blockedSessionRef.current = firebaseUser.uid;
      toast({
        title,
        description: resolveBlockedAccessMessage(profile, profileLoadFailed),
        variant: "destructive",
      });
    }

    await signOut(auth);
  };

  /**
   * Fetch user profile directly from RTDB at `users/{uid}`.
   */
  const fetchUserProfile = async (uid: string): Promise<UserProfile> => {
    try {
      const data = await getUserProfile(uid);
      if (!data) throw new Error("User profile not found");

      const recordId = data.id || uid;
      const { id: _id, ...profileData } = data;
      return buildUserProfile(recordId, profileData);
    } catch (error) {
      console.error("Error fetching user profile:", error);
      throw error;
    }
  };

  /**
   * Update lastLogin directly in RTDB.
   */
  const doTouchLastLogin = async (recordId: string | null) => {
    if (!recordId) return;
    try {
      await touchLastLogin(recordId);
    } catch (error) {
      console.error("Error updating last login:", error);
    }
  };

  /**
   * Poll profile every 5 minutes (replaces onValue realtime listener).
   * Profile rarely changes mid-session so this is sufficient.
   */
  const startProfilePolling = (firebaseUser: User, recordId: string) => {
    stopProfilePolling();
    profileRecordIdRef.current = recordId;

    profilePollTimer = setInterval(async () => {
      try {
        const profile = await fetchUserProfile(firebaseUser.uid);
        if (!profile.recordId) {
          // Account may have been removed
          void blockUserSession(
            firebaseUser,
            { recordId, role: null, allowedProgrammes: null, name: null, userAttribute: null, status: "disabled" },
            "Account removed",
          );
          return;
        }

        if (!canAccessWebDashboard(profile)) {
          void blockUserSession(firebaseUser, profile);
          return;
        }

        syncProfileState(firebaseUser, profile);
      } catch (error) {
        console.error("Error polling user profile:", error);
      }
    }, 5 * 60 * 1000); // 5 minutes
  };

  // --- Regression check: AuthProvider should mount exactly ONCE per session ---
  // If you see this log more than once during normal navigation, something is
  // causing the provider tree to remount (e.g. a key prop changing on a parent).
  console.log("[Genco Auth] AuthProvider mounted — data prefetch will run once");
  const prefetchDoneRef = useRef(false);

  useEffect(() => {
    let isMounted = true;

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!isMounted) return;

      setLoading(true);

      if (!firebaseUser) {
        pendingLoginRef.current = false;
        blockedSessionRef.current = null;
        stopProfilePolling();
        clearAuthState();
        if (isMounted) setLoading(false);
        return;
      }

      setUser(firebaseUser);

      try {
        const profile = await fetchUserProfile(firebaseUser.uid);
        if (!isMounted) return;

        if (!canAccessWebDashboard(profile)) {
          await blockUserSession(firebaseUser, profile);
          return;
        }

        // Start polling profile instead of onValue listener
        if (profile.recordId) {
          startProfilePolling(firebaseUser, profile.recordId);
        }

        if (pendingLoginRef.current) {
          await doTouchLastLogin(profile.recordId);
        }

        syncProfileState(firebaseUser, profile);

        if (pendingLoginRef.current) {
          pendingLoginRef.current = false;
          toast({
            title: "Welcome back!",
            description: "You have successfully signed in.",
          });
        }

        // Fire-and-forget prefetch of ALL dashboard collections into cache.
        // Scoped to the user's accessible programmes so pages get instant cache hits.
        // Direct SDK prefetch — no Cloud Functions needed
        const accessible = getAccessibleProgrammesForProfile(profile);
        if (!prefetchDoneRef.current) {
          prefetchDoneRef.current = true;
          // Prefetch key dashboard collections into cache via direct SDK
          Promise.allSettled([
            fetchCollection("BoreholeStorage"),
            ...accessible.map((p) => fetchCollectionByProgrammes("BoreholeStorage", [p])),
          ]).catch(() => {});
        }
      } catch (error) {
        console.error("Auth initialization error:", error);
        pendingLoginRef.current = false;
        if (firebaseUser) {
          await blockUserSession(
            firebaseUser,
            {
              recordId: null,
              role: null,
              allowedProgrammes: null,
              name: null,
              userAttribute: null,
              status: null,
            },
            "Profile unavailable",
            true,
          );
          return;
        }
        clearAuthState();
      } finally {
        if (isMounted) setLoading(false);
      }
    });

    return () => {
      isMounted = false;
      stopProfilePolling();
      unsubscribe();
    };
  }, [toast]);

  const signIn = async (email: string, password: string) => {
    const normalizedEmail = email.trim();
    const normalizedPassword = password;

    try {
      pendingLoginRef.current = true;
      setLoading(true);
      await signInWithEmailAndPassword(auth, normalizedEmail, normalizedPassword);
    } catch (error: any) {
      pendingLoginRef.current = false;
      setLoading(false);
      console.error("Sign in error:", error);

      let message = "Invalid credentials. Please try again.";

      if (
        error.code === "auth/invalid-credential" ||
        error.code === "auth/user-not-found" ||
        error.code === "auth/wrong-password"
      ) {
        // Check if env vars are missing — this is the #1 cause of this error
        const envMissing = !import.meta.env.VITE_API_KEY || import.meta.env.VITE_API_KEY === "your_firebase_api_key_here";
        const wrongProject = import.meta.env.VITE_PROJECT_ID && import.meta.env.VITE_PROJECT_ID !== "genco-export";
        if (envMissing) {
          message = "Firebase is not configured. Create a .env file from .env.example with your Firebase credentials.";
        } else if (wrongProject) {
          message = "Firebase project mismatch. Set VITE_PROJECT_ID=genco-export in .env — user accounts are registered in the genco-export project.";
        } else {
          message = "Incorrect email or password contact Admin";
        }
      } else if (error.code === "auth/too-many-requests") {
        message = "Too many failed attempts. Please try again later.";
      } else if (error.message) {
        message = error.message;
      }

      toast({
        title: "Sign In Failed",
        description: message,
        variant: "destructive",
      });
      throw error;
    }
  };

  const signOutUser = async () => {
    try {
      stopProfilePolling();
      await signOut(auth);
      toast({
        title: "Signed Out",
        description: "You have been successfully signed out.",
      });
    } catch (error: any) {
      console.error("Sign out error:", error);
      toast({
        title: "Error",
        description: "Failed to sign out. Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <AuthContext.Provider
      value={{ user, userRole, userAttribute, userName, allowedProgrammes, loading, signIn, signOutUser }}
    >
      {children}
    </AuthContext.Provider>
  );
};