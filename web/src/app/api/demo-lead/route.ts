import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      email,
      selected_keywords = [],
      selected_count    = 0,
      category          = "home-decor",
      intent            = "weekly_plan",
      source_cta        = "build_weekly_plan",
      locked_clicks     = 0,
      session_id        = "",
      lead_stage        = "selected_0",
    } = body;

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return NextResponse.json({ error: "Invalid email" }, { status: 400 });
    }

    const supabase = createServerClient();
    const now      = new Date().toISOString();

    const { error: upsertError } = await supabase
      .from("demo_leads")
      .upsert(
        {
          email:             email.toLowerCase().trim(),
          selected_keywords: selected_keywords as string[],
          selected_count:    selected_count as number,
          category,
          intent,
          source_cta,
          locked_clicks:     locked_clicks as number,
          session_id,
          lead_stage,
          updated_at:        now,
        },
        { onConflict: "email" },
      );

    if (upsertError) console.error("demo_leads upsert:", upsertError.message);

    const { error: eventError } = await supabase
      .from("demo_events")
      .insert({
        session_id,
        event_type: "email_submitted",
        payload:    { email: email.toLowerCase().trim(), selected_count, source_cta, lead_stage },
        created_at: now,
      });

    if (eventError) console.error("demo_events insert:", eventError.message);

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("demo-lead route error:", e);
    return NextResponse.json({ ok: true }); // always non-fatal to the user
  }
}
