import { createClient, type User } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";

type AuthUser = Pick<User, "id" | "email" | "app_metadata" | "user_metadata">;

function anonClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}

function allowedEmails(): Set<string> {
  return new Set(
    (process.env.SUPER_ADMIN_EMAILS ?? "")
      .split(",")
      .map(email => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * LOCAL-DEV-ONLY super-admin bypass.
 *
 * ⚠️ SECURITY — this grants full super-admin access WITHOUT authentication.
 * It is double-gated and can NEVER activate in production:
 *   1. process.env.NODE_ENV must NOT be "production" (Next.js sets this to
 *      "production" for `next build` / `next start`), AND
 *   2. ENABLE_LOCAL_ADMIN_BYPASS must be explicitly set to "true".
 *
 * Do NOT set ENABLE_LOCAL_ADMIN_BYPASS in any deployed/production environment.
 * Purpose: let a local developer open /admin/* (incl. the internal Visual
 * Review tool) without seeding their email into SUPER_ADMIN_EMAILS. Visual
 * Review scores stay internal regardless of this flag.
 */
function localAdminBypassEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.ENABLE_LOCAL_ADMIN_BYPASS === "true"
  );
}

const LOCAL_DEV_ADMIN: AuthUser = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "local-dev-admin@localhost",
  app_metadata: { role: "super_admin" },
  user_metadata: {},
};

export function isSuperAdminUser(user: AuthUser | null): boolean {
  if (!user) return false;
  const role =
    typeof user.app_metadata?.role === "string" ? user.app_metadata.role :
    typeof user.user_metadata?.role === "string" ? user.user_metadata.role :
    null;
  if (role === "super_admin") return true;

  const email = user.email?.toLowerCase();
  return !!email && allowedEmails().has(email);
}

export async function getUserFromBearer(request: Request): Promise<AuthUser | null> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) return null;

  const { data: { user }, error } = await anonClient().auth.getUser(token);
  if (error || !user) return null;
  return user;
}

export async function getUserFromCookies(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() { return cookieStore.getAll(); },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Server components can be read-only; auth refresh is best effort.
          }
        },
      },
    },
  );

  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  return user;
}

export async function requireSuperAdminFromRequest(request: Request): Promise<AuthUser | null> {
  if (
    process.env.E2E_TEST_MODE === "true" &&
    request.headers.get("x-e2e-super-admin") === "true"
  ) {
    return { id: "00000000-0000-0000-0000-000000000001", app_metadata: { role: "super_admin" }, user_metadata: {} };
  }
  // Local-dev bypass (double-gated; never active in production). See helper above.
  if (localAdminBypassEnabled()) return LOCAL_DEV_ADMIN;
  const user = await getUserFromBearer(request) ?? await getUserFromCookies();
  return isSuperAdminUser(user) ? user : null;
}

export async function getCurrentSuperAdmin(): Promise<AuthUser | null> {
  const headerStore = await headers();
  if (
    process.env.E2E_TEST_MODE === "true" &&
    headerStore.get("x-e2e-super-admin") === "true"
  ) {
    return { id: "00000000-0000-0000-0000-000000000001", app_metadata: { role: "super_admin" }, user_metadata: {} };
  }
  // Local-dev bypass (double-gated; never active in production). See helper above.
  if (localAdminBypassEnabled()) return LOCAL_DEV_ADMIN;
  const user = await getUserFromCookies();
  return isSuperAdminUser(user) ? user : null;
}

// ── Admin roles (super_admin > support) ──────────────────────────────────────
//
// Additive layer on top of the super-admin gate. Super admins retain FULL
// access (unchanged). "support" is a lower tier that may view internal debug
// tooling (e.g. Generation Logs) but is denied sensitive fields such as the
// full internal prompt template. Support is EMPTY by default: no email is a
// support user unless added to SUPPORT_ADMIN_EMAILS or given role "support",
// so today's behaviour is identical to super-admin-only until a support user
// is explicitly provisioned. Sensitive pages keep their own getCurrentSuperAdmin
// gate, so relaxing the console shell to admin-role never exposes them.

export type AdminRole = "super_admin" | "support";

function supportEmails(): Set<string> {
  return new Set(
    (process.env.SUPPORT_ADMIN_EMAILS ?? "")
      .split(",")
      .map(email => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function adminRoleOf(user: AuthUser | null): AdminRole | null {
  if (!user) return null;
  if (isSuperAdminUser(user)) return "super_admin";
  const role =
    typeof user.app_metadata?.role === "string" ? user.app_metadata.role :
    typeof user.user_metadata?.role === "string" ? user.user_metadata.role :
    null;
  if (role === "support") return "support";
  const email = user.email?.toLowerCase();
  return !!email && supportEmails().has(email) ? "support" : null;
}

export type AdminSession = { role: AdminRole; user: AuthUser };

export async function getCurrentAdminRole(): Promise<AdminSession | null> {
  const headerStore = await headers();
  if (process.env.E2E_TEST_MODE === "true") {
    if (headerStore.get("x-e2e-super-admin") === "true") {
      return { role: "super_admin", user: { id: "00000000-0000-0000-0000-000000000001", app_metadata: { role: "super_admin" }, user_metadata: {} } };
    }
    if (headerStore.get("x-e2e-support-admin") === "true") {
      return { role: "support", user: { id: "00000000-0000-0000-0000-000000000002", app_metadata: { role: "support" }, user_metadata: {} } };
    }
  }
  if (localAdminBypassEnabled()) return { role: "super_admin", user: LOCAL_DEV_ADMIN };
  const user = await getUserFromCookies();
  const role = adminRoleOf(user);
  return role && user ? { role, user } : null;
}

export async function requireAdminRoleFromRequest(request: Request): Promise<AdminSession | null> {
  if (process.env.E2E_TEST_MODE === "true") {
    if (request.headers.get("x-e2e-super-admin") === "true") {
      return { role: "super_admin", user: { id: "00000000-0000-0000-0000-000000000001", app_metadata: { role: "super_admin" }, user_metadata: {} } };
    }
    if (request.headers.get("x-e2e-support-admin") === "true") {
      return { role: "support", user: { id: "00000000-0000-0000-0000-000000000002", app_metadata: { role: "support" }, user_metadata: {} } };
    }
  }
  if (localAdminBypassEnabled()) return { role: "super_admin", user: LOCAL_DEV_ADMIN };
  const user = await getUserFromBearer(request) ?? await getUserFromCookies();
  const role = adminRoleOf(user);
  return role && user ? { role, user } : null;
}
