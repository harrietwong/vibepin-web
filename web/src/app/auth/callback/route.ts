import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { authFailureRedirect, resolveAuthNext } from "@/lib/authRedirects";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const cookieStore = await cookies();
  const cookieNext = cookieStore.get("vp_next")?.value;
  const next = resolveAuthNext(searchParams.get("next"), cookieNext);

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
    try {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        const response = NextResponse.redirect(`${origin}${next}`);
        response.cookies.set("vp_next", "", { path: "/", maxAge: 0 });
        return response;
      }
    } catch {
      // Provider errors are intentionally reduced to the generic UI-safe path.
    }
  }

  const response = NextResponse.redirect(`${origin}${authFailureRedirect(next)}`);
  response.cookies.set("vp_next", "", { path: "/", maxAge: 0 });
  return response;
}
