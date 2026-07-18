"use client";

import { useState, useEffect } from "react";
import { createBrowserClient } from "@supabase/ssr";

// V1: email whitelist only. No Stripe, no DB table.
// To grant Pro access, add email to this array.
const PRO_EMAILS: string[] = [
  "zhihuihuang321@gmail.com",
];

export function useUserTier(): { isPro: boolean } {
  const [isPro, setIsPro] = useState(false);

  useEffect(() => {
    const supabase = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    );
    supabase.auth.getUser().then(({ data }) => {
      const email = data.user?.email ?? "";
      // Read the plan from app_metadata (service-role-writable only), NOT
      // user_metadata (user-editable — trusting it there let anyone self-grant
      // a paid tier). The Creem webhook refreshes app_metadata.plan after real
      // payment; resolvePlan on the server is the authoritative check.
      const metaPlan = data.user?.app_metadata?.plan;
      setIsPro(PRO_EMAILS.includes(email) || metaPlan === "pro" || metaPlan === "business");
    });
  }, []);

  return { isPro };
}
