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
      const metaPlan = data.user?.user_metadata?.plan;
      setIsPro(PRO_EMAILS.includes(email) || metaPlan === "pro");
    });
  }, []);

  return { isPro };
}
