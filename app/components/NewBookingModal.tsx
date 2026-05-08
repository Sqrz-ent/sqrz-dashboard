import { useState } from "react";
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
  fontSize: 13,
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

const sectionLabel: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  color: "var(--text-muted)",
  margin: "20px 0 10px",
  display: "block",
};

export default function NewBookingModal({
  isOpen,
  onClose,
  services,
  onSuccess,
}: {
  isOpen: boolean;
  onClose: () => void;
  services: NewBookingService[];
  onSuccess: (clientEmail: string) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [includeProposal, setIncludeProposal] = useState(false);
  const [lineItems, setLineItems] = useState<LineItem[]>([{ label: "Artist Fee", amount: 0 }]);

  const [form, setForm] = useState({
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
    requires_payment: false,
  });

  function set(key: keyof typeof form, value: string | boolean) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.client_name || !form.client_email || !form.title) return;
    setSubmitting(true);
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
          include_proposal: includeProposal,
          rate: includeProposal ? parseFloat(form.rate) || null : null,
          currency: form.currency,
          line_items: includeProposal ? lineItems.filter((i) => i.label && i.amount > 0) : [],
          proposal_message: includeProposal ? form.proposal_message : null,
          requires_payment: includeProposal ? form.requires_payment : false,
        }),
      });
      const json = await res.json();
      if (json.success) {
        onSuccess(form.client_email);
        onClose();
      }
    } catch (err) {
      console.error("[new booking]", err);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Booking">
      <form
        onSubmit={handleSubmit}
        style={{ padding: "0 22px 24px", overflowY: "auto", flex: 1, fontFamily: FONT_BODY }}
      >
        {/* Client Details */}
        <span style={sectionLabel}>Client Details</span>
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

        {/* Booking Details */}
        <span style={sectionLabel}>Booking Details</span>
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
        <div style={{ marginBottom: 10 }}>
          <label style={lbl}>Notes / Message</label>
          <textarea
            rows={3}
            style={{ ...inputStyle, resize: "vertical" }}
            placeholder="Any details for the client…"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
          />
        </div>

        {/* Proposal toggle */}
        <div
          style={{
            marginTop: 16,
            padding: "12px 14px",
            background: "var(--bg)",
            borderRadius: 10,
            border: "1px solid var(--border)",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={includeProposal}
              onChange={(e) => setIncludeProposal(e.target.checked)}
              style={{ accentColor: ACCENT, width: 15, height: 15, flexShrink: 0 }}
            />
            <div>
              <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>Include proposal now</p>
              <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>
                Add rate and breakdown — or send later from the booking page
              </p>
            </div>
          </label>

          {includeProposal && (
            <div style={{ marginTop: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 90px", gap: 10, marginBottom: 10 }}>
                <div>
                  <label style={lbl}>Total budget</label>
                  <input
                    style={inputStyle}
                    type="number"
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

              <div style={{ marginBottom: 10 }}>
                <label style={lbl}>Message (optional)</label>
                <textarea
                  rows={2}
                  style={{ ...inputStyle, resize: "vertical" }}
                  placeholder="Note with the proposal…"
                  value={form.proposal_message}
                  onChange={(e) => set("proposal_message", e.target.value)}
                />
              </div>

              <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={form.requires_payment}
                  onChange={(e) => set("requires_payment", e.target.checked)}
                  style={{ accentColor: ACCENT, width: 15, height: 15, marginTop: 2, flexShrink: 0 }}
                />
                <div>
                  <p style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", margin: 0 }}>Request payment via Stripe</p>
                  <p style={{ fontSize: 11, color: "var(--text-muted)", margin: "2px 0 0" }}>Client receives a Stripe payment link</p>
                </div>
              </label>
            </div>
          )}
        </div>

        <button
          type="submit"
          disabled={submitting || !form.client_name || !form.client_email || !form.title}
          style={{
            width: "100%",
            marginTop: 20,
            padding: "13px",
            background: ACCENT,
            color: "#111",
            border: "none",
            borderRadius: 10,
            fontSize: 14,
            fontWeight: 700,
            cursor: submitting || !form.client_name || !form.client_email || !form.title ? "default" : "pointer",
            opacity: submitting ? 0.7 : 1,
            fontFamily: FONT_BODY,
          }}
        >
          {submitting ? "Creating…" : "Create Booking & Send Link"}
        </button>
      </form>
    </Modal>
  );
}
