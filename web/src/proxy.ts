import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  // E2E test bypass — skip auth when running Playwright tests locally
  if (process.env.E2E_TEST_MODE === "true") {
    return NextResponse.next();
  }

  // Allow unauthenticated access for demo mode
  if (
    request.nextUrl.pathname === "/app/discover" &&
    request.nextUrl.searchParams.get("demo") === "true"
  ) {
    return NextResponse.next();
  }

  try {
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

    if (!session && request.nextUrl.pathname.startsWith("/app")) {
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
