import { redirect } from "next/navigation";

type LegacyPlanPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Preserve old bookmarks/OAuth callbacks while keeping Create Pins as the only Plan shell. */
export default async function LegacyPlanRedirect({ searchParams }: LegacyPlanPageProps) {
  const incoming = await searchParams;
  const outgoing = new URLSearchParams({ view: "plan" });

  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (key === "view") {
      const legacyView = Array.isArray(value) ? value[0] : value;
      if (legacyView === "calendar" || legacyView === "list") outgoing.set("planView", legacyView);
      continue;
    }
    if (Array.isArray(value)) value.forEach(item => outgoing.append(key, item));
    else outgoing.set(key, value);
  }

  redirect(`/app/studio?${outgoing.toString()}`);
}
