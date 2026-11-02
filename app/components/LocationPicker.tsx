import { useEffect, useState } from "react";
import { RADIUS_OPTIONS_KM } from "~/lib/templates";

const ACCENT = "#F5A623";

export type CampaignLocation = { cityName: string; latitude: number; longitude: number; radiusKm: number };
type Result = { name: string; display: string; latitude: number; longitude: number };

const input: React.CSSProperties = {
  width: "100%", padding: "12px 14px", background: "var(--surface)", border: "1px solid var(--border)",
  borderRadius: 10, fontSize: 14, color: "var(--text)", outline: "none", boxSizing: "border-box",
};

// Campaign geo-targeting: city search + a fixed radius (10/25/50/80 km — 80 is
// Meta's real custom_locations maximum), like iOS LocationPickerField.
export default function LocationPicker({
  value,
  onChange,
}: {
  value: CampaignLocation | null;
  onChange: (v: CampaignLocation | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    if (value || query.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/location-search?q=${encodeURIComponent(query.trim())}`);
        const data = await res.json().catch(() => null);
        setResults(data?.results ?? []);
      } finally {
        setSearching(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [query, value]);

  if (value) {
    return (
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, ...input }}>
          <span>📍 {value.cityName}</span>
          <button type="button" onClick={() => { onChange(null); setQuery(""); }} style={{ background: "none", border: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 12 }}>
            Change
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          {RADIUS_OPTIONS_KM.map((km) => (
            <button
              key={km}
              type="button"
              onClick={() => onChange({ ...value, radiusKm: km })}
              style={{
                padding: "6px 14px", borderRadius: 999, cursor: "pointer", fontSize: 12, fontWeight: 600,
                border: `1px solid ${value.radiusKm === km ? ACCENT : "var(--border)"}`,
                background: value.radiusKm === km ? "rgba(245,166,35,0.12)" : "var(--surface)",
                color: value.radiusKm === km ? ACCENT : "var(--text)",
              }}
            >
              {km} km
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search for a city…" style={input} autoComplete="off" />
      {searching && <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-muted)" }}>Searching…</p>}
      {results.length > 0 && (
        <div style={{ marginTop: 6, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          {results.map((r) => (
            <button
              key={r.display}
              type="button"
              onClick={() => { onChange({ cityName: r.name, latitude: r.latitude, longitude: r.longitude, radiusKm: 25 }); setResults([]); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "10px 14px", background: "none", border: "none", borderTop: "1px solid var(--border)", cursor: "pointer", color: "var(--text)", fontSize: 13 }}
            >
              <div style={{ fontWeight: 600 }}>{r.name}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.display}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
