"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { CheckCircle } from "lucide-react";
import { useLocale } from "@/lib/i18n/LocaleProvider";

const CONTACT = "support@vibepin.co";

const CONTACT_REASONS = [
  ["contact.reason.product.title", "contact.reason.product.description"],
  ["contact.reason.billing.title", "contact.reason.billing.description"],
  ["contact.reason.partnership.title", "contact.reason.partnership.description"],
] as const;

export function ContactDetails() {
  const { t } = useLocale();

  return (
    <div>
      <div className="rounded-2xl border p-6 mb-5" style={{ background: "var(--public-surface)", borderColor: "var(--public-border)" }}>
        <p className="text-[11px] font-bold uppercase tracking-wider mb-2" style={{ color: "var(--public-text-muted)" }}>{t("contact.emailLabel")}</p>
        <a href={`mailto:${CONTACT}`} className="text-xl font-black hover:opacity-80 transition-opacity" style={{ color: "var(--public-text)" }}>{CONTACT}</a>
        <p className="text-[12px] mt-2" style={{ color: "var(--public-text-muted)" }}>{t("contact.emailHint")}</p>
      </div>
      <div className="space-y-3">
        {CONTACT_REASONS.map(([title, description]) => (
          <div key={title} className="rounded-xl border p-4" style={{ background: "var(--public-surface)", borderColor: "var(--public-border)" }}>
            <p className="text-[13px] font-bold mb-1" style={{ color: "var(--public-text)" }}>{t(title)}</p>
            <p className="text-[12px] leading-relaxed" style={{ color: "var(--public-text-muted)" }}>{t(description)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

type Status = "idle" | "submitting" | "success" | "error";

export default function ContactForm() {
  const searchParams = useSearchParams();
  const { t } = useLocale();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState(() => searchParams.get("subject") ?? "");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — real users never fill this
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "submitting" || status === "success") return;
    setError(null);

    if (!email.trim() || !email.includes("@")) {
      setStatus("error");
      setError(t("contact.invalidEmail"));
      return;
    }
    if (!message.trim()) {
      setStatus("error");
      setError(t("contact.missingMessage"));
      return;
    }

    setStatus("submitting");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, subject, message, website }),
      });
      if (res.ok) {
        setStatus("success");
        return;
      }

      setStatus("error");
      // Server details can be operational or provider-specific. Keep the
      // customer-visible failure localized and stable.
      setError(t("contact.genericError"));
    } catch {
      setStatus("error");
      setError(t("contact.networkError"));
    }
  }

  function resetForm() {
    setName("");
    setEmail("");
    setSubject("");
    setMessage("");
    setWebsite("");
    setError(null);
    setStatus("idle");
  }

  if (status === "success") {
    return (
      <div
        data-testid="contact-success-state"
        role="status"
        aria-live="polite"
        className="rounded-2xl border p-6 sm:p-7"
        style={{ background: "var(--public-surface)", borderColor: "var(--public-border)", boxShadow: "0 12px 32px rgba(15,23,42,0.10)" }}
      >
        <div className="flex items-start gap-3">
          <CheckCircle aria-hidden="true" className="mt-0.5 shrink-0" size={22} style={{ color: "var(--public-accent)" }} />
          <div className="min-w-0">
            <p className="text-[15px] font-black mb-1" style={{ color: "var(--public-text)" }}>{t("contact.success.title")}</p>
            <p className="text-[13px] leading-relaxed" style={{ color: "var(--public-text-muted)" }}>{t("contact.success.description")}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Link href="/" data-testid="contact-success-home" className="btn-cta min-h-11 inline-flex items-center rounded-full px-4 py-2 text-[12px] font-bold text-white">
            {t("contact.success.home")}
          </Link>
          <button type="button" data-testid="contact-success-another" onClick={resetForm} className="min-h-11 rounded-full border px-4 py-2 text-[12px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2" style={{ borderColor: "var(--public-border-hi)", color: "var(--public-text)" }}>
            {t("contact.success.another")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      aria-busy={status === "submitting"}
      className="rounded-2xl border p-6 sm:p-7"
      style={{ background: "var(--public-surface)", borderColor: "var(--public-border)", boxShadow: "0 12px 32px rgba(15,23,42,0.10)" }}
    >
      <p className="text-[15px] font-black mb-4" style={{ color: "var(--public-text)" }}>{t("contact.formTitle")}</p>

      {/* Honeypot — invisible to real users, catches bots that fill every field */}
      <input
        type="text"
        name="website"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        style={{ position: "absolute", left: "-9999px", opacity: 0, height: 0, width: 0 }}
      />

      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        <Field label={t("contact.name")} name="name" placeholder={t("contact.namePlaceholder")} value={name} onChange={setName} />
        <Field label={t("contact.email")} name="email" type="email" placeholder={t("contact.emailPlaceholder")} value={email} onChange={setEmail} />
      </div>
      <Field label={t("contact.subject")} name="subject" placeholder={t("contact.subjectPlaceholder")} value={subject} onChange={setSubject} />
      <div className="mt-3">
        <label htmlFor="contact-message" className="block text-[11px] font-semibold mb-1.5" style={{ color: "var(--public-text-muted)" }}>{t("contact.message")}</label>
        <textarea
          id="contact-message"
          name="message"
          rows={5}
          placeholder={t("contact.messagePlaceholder")}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full rounded-lg px-3 py-2.5 text-[13px] outline-none focus:border-fuchsia-500/50 transition-colors"
          style={{ background: "var(--public-bg)", border: "1px solid var(--public-border)", color: "var(--public-text)", resize: "vertical" }}
        />
      </div>

      {error && (
        <p data-testid="contact-error" role="alert" className="text-[12px] mt-3" style={{ color: "#DC2626" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="btn-cta min-h-11 w-full mt-5 rounded-full py-3 text-[14px] font-bold text-white transition-transform hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100"
      >
        {status === "submitting" ? t("contact.sending") : t("contact.send")}
      </button>
      <p className="text-[11px] text-center mt-3" style={{ color: "var(--public-text-muted)" }}>
        Prefer email? Write to{" "}
        <a href={`mailto:${CONTACT}`} className="hover:opacity-80" style={{ color: "var(--public-accent-strong)" }}>
          {CONTACT}
        </a>.
      </p>
    </form>
  );
}

export function ContactPageIntro() {
  const { t } = useLocale();
  return (
    <>
      <p className="text-[11px] font-bold uppercase tracking-[0.16em] mb-3" style={{ color: "#0E7490" }}>{t("contact.eyebrow")}</p>
      <h1 className="text-4xl sm:text-5xl font-black tracking-tight leading-[1.05] mb-4" style={{ color: "var(--public-text)" }}>
        {t("contact.title")} {" "}
        <span style={{ background: "linear-gradient(100deg,#0891B2,#0F766E)", WebkitBackgroundClip: "text", backgroundClip: "text", color: "transparent" }}>{t("contact.titleAccent")}</span>
      </h1>
      <p className="text-[15px] leading-relaxed mb-12 max-w-[560px]" style={{ color: "var(--public-text-muted)" }}>{t("contact.description")}</p>
    </>
  );
}

function Field({
  label,
  name,
  type = "text",
  placeholder,
  value,
  onChange,
}: {
  label: string;
  name: string;
  type?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={`contact-${name}`} className="block text-[11px] font-semibold mb-1.5" style={{ color: "var(--public-text-muted)" }}>{label}</label>
      <input
        id={`contact-${name}`}
        type={type}
        name={name}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg px-3 py-2.5 text-[13px] outline-none focus:border-fuchsia-500/50 transition-colors"
        style={{ background: "var(--public-bg)", border: "1px solid var(--public-border)", color: "var(--public-text)" }}
      />
    </div>
  );
}
