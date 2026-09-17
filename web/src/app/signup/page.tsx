"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { createBrowserClient } from "@supabase/ssr";
import BrandLogo from "@/components/BrandLogo";
import { safeNextPath } from "@/lib/authRedirects";
import { PublicAuthHeader, PublicShell } from "@/components/public/PublicShell";
import { usePublicRouteCopy } from "@/components/public/PublicLocaleSummary";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const supabase = createBrowserClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

function SignupContent() {
  const copy = usePublicRouteCopy("signup");
  const { t } = useLocale();
  const authError = (code: string | null | undefined) => t(code === "oauth_unavailable" ? "public.auth.error.oauthUnavailable" : code === "oauth_callback" ? "public.auth.error.oauthCallback" : "public.auth.error.authenticationFailed");
  const planLabel = (value: string) => t(value === "starter" || value === "creator" ? "public.auth.plan.starter" : value === "pro" || value === "growth" ? "public.auth.plan.pro" : value === "business" ? "public.auth.plan.business" : "public.auth.plan.free");
  const params = useSearchParams();
  const plan   = params.get("plan") ?? "free";
  const next   = safeNextPath(params.get("next"));

  const [email,     setEmail]     = useState("");
  const [password,  setPassword]  = useState("");
  const [loading,   setLoading]   = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(() => params.get("error"));
  const error = errorCode === "password_short" ? `${copy.password} (${copy.passwordHint})` : errorCode ? authError(errorCode) : "";
  const [done,      setDone]      = useState(false);

  const signInHref = (() => {
    const qs = new URLSearchParams();
    qs.set("next", next);
    if (plan !== "free") qs.set("plan", plan);
    return `/login?${qs.toString()}`;
  })();

  async function handleGoogle() {
    setLoading(true);
    setErrorCode(null);
    try {
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}` },
      });
      if (oauthError) {
        setErrorCode("oauth_unavailable");
        setLoading(false);
      }
    } catch {
      setErrorCode("oauth_unavailable");
      setLoading(false);
    }
  }

  async function handleSignup(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setErrorCode("password_short"); return; }
    setLoading(true);
    setErrorCode(null);
    // SECURITY: never write the ?plan= param into user_metadata. user_metadata
    // is user-editable, and the plan there was previously trusted for
    // authorization → anyone could self-grant a paid plan. The plan lives only
    // in the URL as purchase intent; entitlements come from the Creem billing
    // mirror (app_metadata cache), refreshed by the webhook after real payment.
    const { error: signupError } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    if (signupError) {
      setErrorCode("authentication_failed");
      setLoading(false);
    } else {
      setDone(true);
    }
  }

  return (
    <div className="public-auth-page min-h-screen flex flex-col" style={{ background: "var(--public-bg)" }}>
      <PublicAuthHeader />
      <main className="flex flex-1 items-center justify-center px-4 py-8">
      <div className="w-full max-w-[400px]">

        {/* Logo */}
        <div className="flex items-center justify-center gap-2.5 mb-8">
          <BrandLogo size={32} />
          <span className="font-black text-gray-900 text-lg tracking-tight">VibePin</span>
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-8">
          {done ? (
            <div className="text-center py-4">
              <div className="text-4xl mb-4">📬</div>
              <h2 className="text-lg font-black text-gray-900 mb-2">{copy.confirmationTitle}</h2>
              <p className="text-sm text-gray-500 leading-relaxed">
                {copy.confirmationBody} <strong>{email}</strong>.
              </p>
            </div>
          ) : (
            <>
              <h1 className="text-xl font-black text-gray-900 mb-1">{copy.eyebrow}</h1>
              <p className="text-sm text-gray-500 mb-1">
                {plan !== "free" ? (
                  <span>{copy.planPrefix} <span className="font-semibold text-[#0891B2]">{planLabel(plan)}</span></span>
                ) : copy.body}
              </p>

              {error && (
                <div className="rounded-xl bg-red-50 border border-red-100 px-4 py-3 mb-5 mt-4 text-sm text-red-600">
                  {error}
                </div>
              )}

              <button
                type="button"
                onClick={handleGoogle}
                disabled={loading}
                className="w-full flex items-center justify-center gap-3 rounded-xl border border-gray-200 bg-white py-3 text-[14px] font-semibold text-gray-700 hover:bg-gray-50 transition-all disabled:opacity-60 mt-6 mb-5"
              >
                <svg viewBox="0 0 24 24" className="w-4 h-4 shrink-0">
                  <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                  <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                  <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                  <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                </svg>
                {copy.google}
              </button>

              <div className="flex items-center gap-3 mb-1">
                <div className="flex-1 h-px bg-gray-200" />
                <span className="text-[11px] text-gray-400 font-medium">{copy.divider}</span>
                <div className="flex-1 h-px bg-gray-200" />
              </div>

              <form onSubmit={handleSignup} className="space-y-4 mt-6">
                <div>
                  <label htmlFor="signup-email" className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                    {copy.email}
                  </label>
                  <input
                    id="signup-email" type="email" value={email} onChange={e => setEmail(e.target.value)}
                    required autoFocus
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-[14px] text-gray-900 focus:border-[#0891B2] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0891B2]/20 transition-all"
                    placeholder={t("public.auth.emailPlaceholder")}
                  />
                </div>
                <div>
                  <label htmlFor="signup-password" className="block text-[11px] font-semibold text-gray-500 uppercase tracking-wider mb-1.5">
                    {copy.password} <span className="text-gray-400 normal-case font-normal">({copy.passwordHint})</span>
                  </label>
                  <input
                    id="signup-password" type="password" value={password} onChange={e => setPassword(e.target.value)}
                    required minLength={8}
                    className="w-full rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-[14px] text-gray-900 focus:border-[#0891B2] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#0891B2]/20 transition-all"
                    placeholder={t("public.auth.passwordPlaceholder")}
                  />
                </div>

                <button
                  type="submit" disabled={loading}
                  className="w-full rounded-xl py-3 text-[14px] font-bold text-white transition-all disabled:opacity-60"
                  style={{ background: loading ? "#94A3B8" : "linear-gradient(135deg, #0891B2, #0E7490)" }}
                >
                  {loading ? `${copy.cta}…` : copy.cta}
                </button>

                <p className="text-[11px] text-gray-400 text-center leading-relaxed">
                  {copy.legalNotice}{" "}
                  <Link href="/terms" className="underline">{copy.termsLabel}</Link>{" · "}
                  <Link href="/privacy" className="underline">{copy.privacyLabel}</Link>
                </p>
              </form>
            </>
          )}
        </div>

        {!done && (
          <p className="text-center text-[13px] text-gray-500 mt-5">
            {copy.signInPrompt}{" "}
            <Link href={signInHref} className="text-[#0891B2] font-semibold hover:underline">
              {copy.signInCta}
            </Link>
          </p>
        )}
      </div>
      </main>
    </div>
  );
}

export default function SignupPage() {
  return (
    <PublicShell>
      <Suspense fallback={
        <div className="public-auth-page min-h-screen flex items-center justify-center" style={{ background: "var(--public-bg)" }}>
          <div className="h-8 w-8 rounded-xl animate-pulse" style={{ background: "linear-gradient(135deg,#FF4D8D,#7C3AED)" }} />
        </div>
      }>
        <SignupContent />
      </Suspense>
    </PublicShell>
  );
}
