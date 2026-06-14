import { useEffect, useState } from "react";
import Modal from "~/components/Modal";

export type NewBookingService = {
  id: string;
  title: string;
  booking_type: string;
};

type LineItem = { label: string; amount: number };

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

const checkRow: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  cursor: "pointer",
};

export default function NewBookingModal({
  isOpen,
  onClose,
  services,
  onSuccess,
  prefill,
  requiresPaymentDefault = false,
  connectPending = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  services: NewBookingService[];
  onSuccess: (clientEmail: string, bookingId: string) => void;
  prefill?: { client_name?: string; client_email?: string; description?: string };
  requiresPaymentDefault?: boolean;
  connectPending?: boolean;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([{ label: "Artist Fee", amount: 0 }]);

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
    requires_payment: requiresPaymentDefault,
    tax_pct: "",
    require_hotel: false,
    require_travel: false,
    require_food: false,
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
      setLineItems([{ label: "Artist Fee", amount: 0 }]);
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
        requires_payment: requiresPaymentDefault,
        tax_pct: "",
        require_hotel: false,
        require_travel: false,
        require_food: false,
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
          line_items: lineItems.filter((i) => i.label && i.amount > 0),
          proposal_message: form.proposal_message || null,
          requires_payment: form.requires_payment,
          tax_pct: form.tax_pct ? parseFloat(form.tax_pct) : null,
          require_hotel: form.require_hotel,
          require_travel: form.require_travel,
          require_food: form.require_food,
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

          {/* Tax */}
          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>Tax % (optional)</label>
            <input
              style={inputStyle}
              type="number"
              min={0}
              max={100}
              step={0.1}
              placeholder="e.g. 19"
              value={form.tax_pct}
              onChange={(e) => set("tax_pct", e.target.value)}
            />
          </div>

          {/* Breakdown */}
          <div style={{ marginBottom: 10 }}>
            <label style={lbl}>Breakdown (optional)</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {lineItems.map((item, idx) => (
                <div key={idx} style={{ display: "grid", gridTemplateColumns: "1fr 90px 30px", gap: 6, alignItems: "center" }}>
                  <input
                    type="text"
                    style={{ ...inputStyle, padding: "8px 10px" }}
                    placeholder="e.g. Artist Fee"
                    value={item.label}
                    onChange={(e) => {
                      const next = [...lineItems];
                      next[idx] = { ...item, label: e.target.value };
                      setLineItems(next);
                    }}
                  />
                  <input
                    type="number"
                    min={0}
                    style={{ ...inputStyle, padding: "8px 10px", textAlign: "right" }}
                    placeholder="0"
                    value={item.amount || ""}
                    onChange={(e) => {
                      const next = [...lineItems];
                      next[idx] = { ...item, amount: parseFloat(e.target.value) || 0 };
                      setLineItems(next);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setLineItems(lineItems.filter((_, i) => i !== idx))}
                    style={{
                      background: "none",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      color: "var(--text-muted)",
                      fontSize: 13,
                      cursor: "pointer",
                      padding: "5px 7px",
                      lineHeight: 1,
                      fontFamily: FONT_BODY,
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setLineItems([...lineItems, { label: "", amount: 0 }])}
              style={{
                marginTop: 6,
                background: "none",
                border: "1px dashed var(--border)",
                borderRadius: 8,
                color: "var(--text-muted)",
                fontSize: 12,
                cursor: "pointer",
                padding: "6px 12px",
                fontFamily: FONT_BODY,
                width: "100%",
              }}
            >
              + Add Line Item
            </button>
          </div>

          {/* Rider requirements */}
          <div
            style={{
              padding: "12px 14px",
              background: "var(--bg)",
              borderRadius: 10,
              border: "1px solid var(--border)",
              marginBottom: 10,
              display: "flex",
              flexDirection: "column",
              gap: 10,
            }}
          >
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--text-muted)" }}>
              Rider requirements
            </span>
            <label style={checkRow}>
              <input
                type="checkbox"
                checked={form.require_hotel}
                onChange={(e) => set("require_hotel", e.target.checked)}
                style={{ accentColor: ACCENT, width: 15, height: 15, flexShrink: 0, marginTop: 1 }}
              />
              <span style={{ fontSize: 13, color: "var(--text)" }}>Hotel accommodation</span>
            </label>
            <label style={checkRow}>
              <input
                type="checkbox"
                checked={form.require_travel}
                onChange={(e) => set("require_travel", e.target.checked)}
                style={{ accentColor: ACCENT, width: 15, height: 15, flexShrink: 0, marginTop: 1 }}
              />
              <span style={{ fontSize: 13, color: "var(--text)" }}>Travel / transport</span>
            </label>
            <label style={checkRow}>
              <input
                type="checkbox"
                checked={form.require_food}
                onChange={(e) => set("require_food", e.target.checked)}
                style={{ accentColor: ACCENT, width: 15, height: 15, flexShrink: 0, marginTop: 1 }}
              />
              <span style={{ fontSize: 13, color: "var(--text)" }}>Food / catering</span>
            </label>
          </div>

          {/* Payment method */}
          {requiresPaymentDefault ? (
            <div
              style={{
                padding: "12px 14px",
                background: "var(--bg)",
                borderRadius: 10,
                border: "1px solid var(--border)",
                marginBottom: 10,
              }}
            >
              <label style={{ ...checkRow, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={!form.requires_payment}
                  onChange={(e) => set("requires_payment", !e.target.checked)}
                  style={{ accentColor: ACCENT, width: 15, height: 15, flexShrink: 0, marginTop: 2 }}
                />
                <div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>Handle payment manually instead</p>
                  <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
                    {form.requires_payment
                      ? "Client will receive a Stripe payment link"
                      : "Payment handled outside SQRZ — no Stripe link sent"}
                  </p>
                </div>
              </label>
            </div>
          ) : connectPending ? (
            <div
              style={{
                padding: "11px 14px",
                background: "var(--bg)",
                borderRadius: 10,
                border: "1px solid var(--border)",
                marginBottom: 10,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ fontSize: 15, lineHeight: 1 }}>⚠️</span>
              <div>
                <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>
                  Finish your Stripe onboarding to unlock payments
                </p>
                <a
                  href="/payments"
                  style={{ fontSize: 11, color: ACCENT, textDecoration: "none", fontWeight: 600 }}
                >
                  Complete setup →
                </a>
              </div>
            </div>
          ) : null}

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
