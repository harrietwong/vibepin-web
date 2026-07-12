// Strict gating for plan-state diagnostics ("plan debug") on Create Pins cards.
//
// Debug badges expose internal matching internals (draft id, match reason, raw
// planning status) and must NEVER appear in production or in a normal user
// session. They render only in local development, or when an explicit local
// debug flag is set — never in a production build or deployed preview unless
// that flag is deliberately enabled.
//
// NODE_ENV === "test" is intentionally excluded so production-parity component
// tests assert the same absence real users see.

export function isPlanDebugEnabled(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  flag: string | undefined = process.env.NEXT_PUBLIC_PLAN_DEBUG,
): boolean {
  if (flag === "true") return true;
  return nodeEnv === "development";
}
