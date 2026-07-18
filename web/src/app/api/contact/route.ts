import { NextRequest, NextResponse } from "next/server";
import { sendEmail, contactFormEmail } from "@/lib/support/email";

/**
 * Public "Contact us" form submission (marketing site, no auth).
 *
 * Fixes the "This form is not secure" browser warning that was shown on
 * /contact: the old form posted directly to `mailto:support@vibepin.co`
 * (a non-HTTPS form action, which Chrome/Firefox flag). This route replaces
 * that with a real HTTPS POST that sends the message via the existing
 * Resend-backed sendEmail() abstraction.
 */

const MAX_EMAIL_LEN = 254;
const MAX_NAME_LEN = 200;
const MAX_SUBJECT_LEN = 200;
const MAX_MESSAGE_LEN = 5000;

// Matches C0/C1 control characters except tab (\t), newline (\n),
// and carriage-return (\r), which are legitimate in a free-text
// message body.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/;

/**
 * Minimal in-memory sliding-window rate limiter scoped to this route.
 *
 * This is process-local: it resets on redeploy/cold-start and is not
 * shared across serverless instances. No distributed rate-limit utility
 * (Redis/Upstash) exists elsewhere in this codebase, and adding one is out
 * of scope here — accepted P0 tradeoff for a low-traffic marketing form.
 */
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RATE_LIMIT_MAX = 5;
const requestLog = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const existing = (requestLog.get(ip) ?? []).filter((t) => t > cutoff);

  if (existing.length >= RATE_LIMIT_MAX) {
    requestLog.set(ip, existing);
    return true;
  }

  existing.push(now);
  requestLog.set(ip, existing);

  // Opportunistic pruning so the map doesn't grow unbounded over the life
  // of the process — cheap since it only runs on the handling path.
  if (requestLog.size > 5000) {
    for (const [key, times] of requestLog) {
      const fresh = times.filter((t) => t > cutoff);
      if (fresh.length === 0) requestLog.delete(key);
      else requestLog.set(key, fresh);
    }
  }

  return false;
}

function getClientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req);
  if (isRateLimited(ip)) {
    return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const website = typeof body.website === "string" ? body.website.trim() : "";

  // Honeypot: real users never see or fill this field. Bots that fill every
  // field in a scraped form do. Pretend success without sending anything.
  if (website) {
    return NextResponse.json({ ok: true }, { status: 201 });
  }

  if (!email || !email.includes("@") || email.length > MAX_EMAIL_LEN) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
  }
  if (!message || message.length > MAX_MESSAGE_LEN) {
    return NextResponse.json({ error: "Please enter a message." }, { status: 400 });
  }
  if (name.length > MAX_NAME_LEN || subject.length > MAX_SUBJECT_LEN) {
    return NextResponse.json({ error: "One of the fields is too long." }, { status: 400 });
  }
  if (
    CONTROL_CHARS.test(name) ||
    CONTROL_CHARS.test(email) ||
    CONTROL_CHARS.test(subject) ||
    CONTROL_CHARS.test(message)
  ) {
    return NextResponse.json({ error: "Your message contains invalid characters." }, { status: 400 });
  }

  const destination = process.env.SUPPORT_NOTIFICATION_EMAIL || "support@vibepin.co";
  const template = contactFormEmail({ name, email, subject, message });

  const result = await sendEmail({
    to: destination,
    replyTo: email,
    ...template,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: "Could not send your message. Please email support@vibepin.co directly." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 201 });
}
