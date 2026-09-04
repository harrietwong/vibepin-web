/** Legacy publishing_queue route: no owner schema or confirmation, so fail closed. */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function disabled() {
  return NextResponse.json(
    { error: "Legacy publishing route is disabled", code: "legacy_publish_disabled" },
    { status: 410 },
  );
}

export async function POST() { return disabled(); }
export async function GET() { return disabled(); }
export async function PATCH() { return disabled(); }
