"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

const CONTACT = "support@vibepin.co";

type Status = "idle" | "submitting" | "success" | "error";

export default function ContactForm() {
  const searchParams = useSearchParams();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [website, setWebsite] = useState(""); // honeypot — real users never fill this
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initialSubject = searchParams.get("subject");
    if (initialSubject) setSubject(initialSubject);
    // Only seed from the URL once on mount — the field stays fully editable afterward.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim() || !email.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }
    if (!message.trim()) {
      setError("Please enter a message.");
      return;
    }

    setStatus("submitting");
    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, subject, message, website }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok) {
        setStatus("success");
        return;
      }

      setStatus("error");
      setError(data?.error || "Something went wrong. Please try again.");
    } catch {
      setStatus("error");
      setError("Network error. Please check your connection and try again.");
    }
  }

  if (status === "success") {
    return (
      <div
        className="rounded-2xl border p-6 sm:p-7"
        style={{ background: "linear-gradient(180deg,#0C1018,#0A0C14)", borderColor: "rgba(255,255,255,0.10)", boxShadow: "0 24px 70px rgba(0,0,0,0.28)" }}
      >
        <p className="text-[15px] font-black text-white mb-2">Message sent</p>
        <p className="text-[13px] leading-relaxed" style={{ color: "#8B93A1" }}>
          Thanks — we got your message and will reply within 1–2 business days.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border p-6 sm:p-7"
      style={{ background: "linear-gradient(180deg,#0C1018,#0A0C14)", borderColor: "rgba(255,255,255,0.10)", boxShadow: "0 24px 70px rgba(0,0,0,0.28)" }}
    >
      <p className="text-[15px] font-black text-white mb-4">Send us a message</p>

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
        <Field label="Name" name="name" placeholder="Your name" value={name} onChange={setName} />
        <Field label="Email" name="email" type="email" placeholder="you@example.com" value={email} onChange={setEmail} />
      </div>
      <Field label="Subject" name="subject" placeholder="How can we help?" value={subject} onChange={setSubject} />
      <div className="mt-3">
        <label className="block text-[11px] font-semibold mb-1.5" style={{ color: "#9097A0" }}>Message</label>
        <textarea
          name="message"
          rows={5}
          placeholder="Tell us a bit more…"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full rounded-lg px-3 py-2.5 text-[13px] outline-none focus:border-fuchsia-500/50 transition-colors"
          style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.10)", color: "#E5E7EB", resize: "vertical" }}
        />
      </div>

      {error && (
        <p className="text-[12px] mt-3" style={{ color: "#F87171" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={status === "submitting"}
        className="btn-cta w-full mt-5 rounded-full py-3 text-[14px] font-bold text-white transition-transform hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100"
      >
        {status === "submitting" ? "Sending…" : "Send message"}
      </button>
      <p className="text-[11px] text-center mt-3" style={{ color: "#4B5563" }}>
        Prefer email? Write to{" "}
        <a href={`mailto:${CONTACT}`} className="hover:text-white" style={{ color: "#A855F7" }}>
          {CONTACT}
        </a>.
      </p>
    </form>
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
      <label className="block text-[11px] font-semibold mb-1.5" style={{ color: "#9097A0" }}>{label}</label>
      <input
        type={type}
        name={name}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg px-3 py-2.5 text-[13px] outline-none focus:border-fuchsia-500/50 transition-colors"
        style={{ background: "#080C12", border: "1px solid rgba(255,255,255,0.10)", color: "#E5E7EB" }}
      />
    </div>
  );
}
