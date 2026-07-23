import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  // E2E test bypass — skip auth when running Playwright tests locally
  if (process.env.E2E_TEST_MODE === "true") {
    return NextResponse.next();
  }

  try {
    if (request.nextUrl.searchParams.has("demo")) {
      const url = request.nextUrl.clone();
      url.searchParams.delete("demo");
      return NextResponse.redirect(url, 308);
    }

    let supabaseResponse = NextResponse.next({ request });

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value }) =>
              request.cookies.set(name, value),
            );
            supabaseResponse = NextResponse.next({ request });
            cookiesToSet.forEach(({ name, value, options }) =>
              supabaseResponse.cookies.set(name, value, options),
            );
          },
        },
      },
    );

    // getSession reads the JWT from cookies without a network call, making
    // every client-side navigation instant. Supabase RLS still validates on
    // each data request, so this is safe for a nav guard.
    const { data: { session } } = await supabase.auth.getSession();

    // Help Center is public: prospects need to read "how to connect Pinterest",
    // the refund policy, etc. before signing up, and the landing footer links
    // straight here. The articles are static content with no user data, and
    // /app/help renders fine with a null session (the shell degrades to an
    // empty user). Everything else under /app still requires a session.
    // Exact path or a child of it — a bare startsWith("/app/help") would also
    // exempt a future /app/helpdesk and silently make it public.
    const isPublicAppPath =
      request.nextUrl.pathname === "/app/help" ||
      request.nextUrl.pathname.startsWith("/app/help/");

    if (!session && !isPublicAppPath && request.nextUrl.pathname.startsWith("/app")) {
      const url = request.nextUrl.clone();
      url.pathname = "/login";
      url.searchParams.set("next", request.nextUrl.pathname + request.nextUrl.search);
      return NextResponse.redirect(url);
    }

    return supabaseResponse;
  } catch (e) {
    console.error("[proxy] error:", e);
    return NextResponse.next();
  }
}

export const config = {
  matcher: ["/app/:path*"],
};
