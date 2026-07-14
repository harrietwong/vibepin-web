import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

function safeNextPath(value: string | null | undefined): string {
  if (
    value &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    !value.startsWith("/login") &&
    !value.startsWith("/signup") &&
    !value.startsWith("/auth")
  ) return value;
  return "/app/studio";
}

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const cookieStore = await cookies();
  const cookieNext = cookieStore.get("vp_next")?.value;
  const decodedCookieNext = cookieNext ? decodeURIComponent(cookieNext) : null;
  const requestedNext = searchParams.get("next") ?? decodedCookieNext;
  const next = safeNextPath(requestedNext);

  if (code) {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return cookieStore.getAll(); },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          },
        },
      },
    );
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const response = NextResponse.redirect(`${origin}${next}`);
      response.cookies.set("vp_next", "", { path: "/", maxAge: 0 });
      return response;
    }
  }

  return NextResponse.redirect(`${origin}/login?error=1`);
}
