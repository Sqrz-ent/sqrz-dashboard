import { useEffect, useState } from "react";
import Modal from "~/components/Modal";

export type NewBookingService = {
  id: string;
  title: string;
  booking_type: string;
};

const FONT_BODY = "ui-sans-serif, system-ui, -apple-system, sans-serif";
const ACCENT = "#F5A623";

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  background: "var(--surface)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 16,
  outline: "none",
  boxSizing: "border-box",
  fontFamily: FONT_BODY,
};

const lbl: React.CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.07em",
  margin: "0 0 5px",
  display: "block",
};

export default function NewBookingModal({
  isOpen,
  onClose,
  services,
  onSuccess,
  prefill,
}: {
  isOpen: boolean;
  onClose: () => void;
  services: NewBookingService[];
  onSuccess: (clientEmail: string, bookingId: string) => void;
  prefill?: { client_name?: string; client_email?: string; description?: string };
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    // Step 1
    client_name: prefill?.client_name ?? "",
    client_email: prefill?.client_email ?? "",
    title: "",
    service: "",
    date_start: "",
    venue: "",
    city: "",
    description: "",
    // Step 2
    rate: "",
    currency: "EUR",
    proposal_message: "",
  });

  // Sync prefill when modal opens
  useEffect(() => {
    if (isOpen && prefill) {
      setForm((f) => ({
        ...f,
        client_name: prefill.client_name ?? f.client_name,
        client_email: prefill.client_email ?? f.client_email,
        description: prefill.description ?? f.description,
      }));
    }
    if (!isOpen) {
      setStep(1);
      setError(null);
      setForm({
        client_name: "",
        client_email: "",
        title: "",
        service: "",
        date_start: "",
        venue: "",
        city: "",
        description: "",
        rate: "",
        currency: "EUR",
        proposal_message: "",
      });
    }
  }, [isOpen]);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleNext(e: React.FormEvent) {
    e.preventDefault();
    setStep(2);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.rate) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/booking/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: form.client_name,
          client_email: form.client_email,
          title: form.title,
          service: form.service || null,
          date_start: form.date_start || null,
          venue: form.venue || null,
          city: form.city || null,
          description: form.description || null,
          include_proposal: true,
          rate: parseFloat(form.rate),
          currency: form.currency,
          proposal_message: form.proposal_message || null,
        }),
      });
      const json = await res.json();
      if (!json.success) {
        setError(json.error ?? "Failed to create booking");
        return;
      }
      onSuccess(form.client_email, json.booking_id ?? "");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  const step1Valid = !!form.client_name && !!form.client_email && !!form.title;
  const step2Valid = !!form.rate;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Booking">
      {/* Progress indicator */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 20,
          fontFamily: FONT_BODY,
        }}
      >
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: ACCENT,
            flexShrink: 0,
          }}
        />
        <div
          style={{
            flex: 1,
            height: 2,
            background: step === 2 ? ACCENT : "var(--border)",
            borderRadius: 1,
            transition: "background 0.2s",
          }}
        />
        <div
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: step === 2 ? ACCENT : "var(--border)",
            flexShrink: 0,
            transition: "background 0.2s",
          }}
        />
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            fontWeight: 600,
            marginLeft: 4,
            whiteSpace: "nowrap",
          }}
        >
          {step} of 2
        </span>
      </div>

      {/* Step 1 */}
      {step === 1 && (
        <form onSubmit={handleNext} style={{ fontFamily: FONT_BODY }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={lbl}>Name *</label>
              <input
                style={inputStyle}
                type="text"
                required
                placeholder="Jane Smith"
                value={form.client_name}
                onChange={(e) => set("client_name", e.target.value)}
              />
            </div>
            <div>
              <label style={lbl}>Email *</label>
              <input
                style={inputStyle}
                type="email"
                required
                placeholder="jane@example.com"
                value={form.client_email}
                onChange={(e) => set("client_email", e.target.value)}
              />
            </div>
          </div>

          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>Project name *</label>
            <input
              style={inputStyle}
              type="text"
              required
              placeholder="e.g. Summer Festival Set"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
            />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={lbl}>Service</label>
              <select
                style={inputStyle}
                value={form.service}
                onChange={(e) => set("service", e.target.value)}
              >
                <option value="">— Select —</option>
                {services.map((s) => (
                  <option key={s.id} value={s.title}>{s.title}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={lbl}>Date</label>
              <input
                style={inputStyle}
                type="date"
                value={form.date_start}
                onChange={(e) => set("date_start", e.target.value)}
              />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={lbl}>Venue</label>
              <input
                style={inputStyle}
                type="text"
                placeholder="Venue name"
                value={form.venue}
                onChange={(e) => set("venue", e.target.value)}
              />
            </div>
            <div>
              <label style={lbl}>City</label>
              <input
                style={inputStyle}
                type="text"
                placeholder="City"
                value={form.city}
                onChange={(e) => set("city", e.target.value)}
              />
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={lbl}>Job details / description</label>
            <textarea
              rows={3}
              style={{ ...inputStyle, resize: "vertical" }}
              placeholder="Describe what's needed…"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </div>

          <button
            type="submit"
            disabled={!step1Valid}
            style={{
              width: "100%",
              padding: "13px",
              background: ACCENT,
              color: "#111",
              border: "none",
              borderRadius: 10,
              fontSize: 14,
              fontWeight: 700,
              cursor: step1Valid ? "pointer" : "default",
              opacity: step1Valid ? 1 : 0.5,
              fontFamily: FONT_BODY,
            }}
          >
            Next →
          </button>
        </form>
      )}

      {/* Step 2 */}
      {step === 2 && (
        <form onSubmit={handleSubmit} style={{ fontFamily: FONT_BODY }}>
          {/* Rate + currency */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 10, marginBottom: 10 }}>
            <div>
              <label style={lbl}>Your rate *</label>
              <input
                style={inputStyle}
                type="number"
                min={0}
                required
                placeholder="1500"
                value={form.rate}
                onChange={(e) => set("rate", e.target.value)}
              />
            </div>
            <div>
              <label style={lbl}>Currency</label>
              <select
                style={inputStyle}
                value={form.currency}
                onChange={(e) => set("currency", e.target.value)}
              >
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
              </select>
            </div>
          </div>

          <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.5 }}>
            Keep this as the agreed proposal amount. Tax and payment details belong on the invoice.
          </p>

          {/* Message */}
          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>Message to client (optional)</label>
            <textarea
              rows={2}
              style={{ ...inputStyle, resize: "vertical" }}
              placeholder="Note with the proposal…"
              value={form.proposal_message}
              onChange={(e) => set("proposal_message", e.target.value)}
            />
          </div>

          {error && (
            <p style={{ color: "#ef4444", fontSize: 12, margin: "0 0 10px", fontFamily: FONT_BODY }}>
              {error}
            </p>
          )}

          {/* Navigation */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
            <button
              type="button"
              onClick={() => setStep(1)}
              style={{
                padding: "13px",
                background: "transparent",
                color: "var(--text-muted)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: FONT_BODY,
              }}
            >
              ← Back
            </button>
            <button
              type="submit"
              disabled={submitting || !step2Valid}
              style={{
                padding: "13px",
                background: ACCENT,
                color: "#111",
                border: "none",
                borderRadius: 10,
                fontSize: 14,
                fontWeight: 700,
                cursor: submitting || !step2Valid ? "default" : "pointer",
                opacity: submitting || !step2Valid ? 0.6 : 1,
                fontFamily: FONT_BODY,
              }}
            >
              {submitting ? "Creating…" : "Create Booking & Send Proposal"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
