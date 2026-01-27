import { useState } from "react";

export default function Profile() {
  const [form, setForm] = useState({
    name: "",
    role: "",
    city: "",
    country: "",
    primarySkills: "",
    secondarySkills: "",
    experience: "",
    intent: [] as string[],
  });

  function update<K extends keyof typeof form>(key: K, value: typeof form[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function toggleIntent(value: string) {
    setForm((prev) => ({
      ...prev,
      intent: prev.intent.includes(value)
        ? prev.intent.filter((v) => v !== value)
        : [...prev.intent, value],
    }));
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    console.log("PROFILE FORM SUBMIT", form);
    alert("Profile form logged to console 👀");
  }

  return (
    <main style={page}>
      <div style={container}>
        <h1 style={title}>Your Profile</h1>
        <p style={subtitle}>
          Tell us who you are and what you want to do on SQRZ.
        </p>

        <form onSubmit={submit} style={formStyle}>
          {/* Basics */}
          <Section title="Basics">
            <Input
              label="Display name"
              value={form.name}
              onChange={(v) => update("name", v)}
            />
            <Input
              label="Role / profession"
              placeholder="Sound engineer, dancer, tour manager…"
              value={form.role}
              onChange={(v) => update("role", v)}
            />
            <Input
              label="City"
              value={form.city}
              onChange={(v) => update("city", v)}
            />
            <Input
              label="Country"
              value={form.country}
              onChange={(v) => update("country", v)}
            />
          </Section>

          {/* Skills */}
          <Section title="What you do">
            <Textarea
              label="Primary skills"
              placeholder="FOH mixing, lighting design, tour management…"
              value={form.primarySkills}
              onChange={(v) => update("primarySkills", v)}
            />
            <Textarea
              label="Secondary skills"
              placeholder="Stagehand, backline, playback…"
              value={form.secondarySkills}
              onChange={(v) => update("secondarySkills", v)}
            />
            <Input
              label="Years of experience"
              type="number"
              value={form.experience}
              onChange={(v) => update("experience", v)}
            />
          </Section>

          {/* Intent */}
          <Section title="What are you here for?">
            {[
              "Get booked",
              "Promote myself",
              "Find crew",
              "Organize events",
            ].map((opt) => (
              <label key={opt} style={checkbox}>
                <input
                  type="checkbox"
                  checked={form.intent.includes(opt)}
                  onChange={() => toggleIntent(opt)}
                />
                {opt}
              </label>
            ))}
          </Section>

          <button type="submit" style={button}>
            Save (for now)
          </button>
        </form>
      </div>
    </main>
  );
}

/* ---------------- styles ---------------- */

const page = {
  minHeight: "100vh",
  background: "#0b0f17",
  color: "#e5e7eb",
  padding: "48px 24px",
  fontFamily:
    "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial",
};

const container = {
  maxWidth: 720,
  margin: "0 auto",
};

const title = {
  fontSize: 32,
  marginBottom: 6,
};

const subtitle = {
  opacity: 0.7,
  marginBottom: 32,
};

const formStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 28,
};

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 style={{ marginBottom: 12 }}>{title}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {children}
      </div>
    </section>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label style={field}>
      <span style={labelStyle}>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={input}
      />
    </label>
  );
}

function Textarea({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label style={field}>
      <span style={labelStyle}>{label}</span>
      <textarea
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        style={input}
      />
    </label>
  );
}

const field = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 6,
};

const labelStyle = {
  fontSize: 13,
  opacity: 0.8,
};

const input = {
  background: "#101827",
  color: "#e5e7eb",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 10,
  padding: "10px 12px",
};

const checkbox = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const button = {
  marginTop: 12,
  padding: "12px 16px",
  borderRadius: 12,
  border: "none",
  fontWeight: 700,
  background: "#f3b130",
  color: "#0b0f17",
  cursor: "pointer",
};
