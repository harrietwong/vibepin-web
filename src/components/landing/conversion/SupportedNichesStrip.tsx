import { SUPPORTED_NICHES } from "@/lib/landing/conversionData";
import { CONTAINER, SECTION } from "./shared";

export function SupportedNichesStrip() {
  return (
    <section className="py-12 lg:py-16 border-t" style={{ borderColor: "rgba(255,255,255,0.06)" }}>
      <div className={CONTAINER}>
        <div
          className="rounded-2xl border px-6 py-8 text-center"
          style={{
            background: "rgba(255,255,255,0.02)",
            borderColor: "rgba(255,255,255,0.07)",
          }}
        >
          <h3 className="text-lg sm:text-xl font-bold text-white tracking-tight mb-5">
            Works across the niches Pinterest users already love.
          </h3>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {SUPPORTED_NICHES.map(n => (
              <span
                key={n}
                className="rounded-full px-3.5 py-1.5 text-[12px] font-semibold"
                style={{
                  color: "#9097A0",
                  border: "1px solid rgba(255,255,255,0.10)",
                  background: "rgba(255,255,255,0.02)",
                }}
              >
                {n}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
