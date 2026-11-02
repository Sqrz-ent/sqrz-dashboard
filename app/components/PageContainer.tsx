// The one content container for every authenticated page — page title, sub-section
// pill row and content all sit inside it, with the same max width, the same left edge
// and the same top/bottom spacing. Dimensions are the Profile page's (the reference).
// Pages apply it to their outermost element: `<div style={pageContainerStyle}>`;
// no page sets its own max width.
export const PAGE_MAX_WIDTH = 680;

export const pageContainerStyle: React.CSSProperties = {
  maxWidth: PAGE_MAX_WIDTH,
  margin: "0 auto",
  padding: "32px 20px 80px",
  fontFamily: "'DM Sans', ui-sans-serif, system-ui, -apple-system, sans-serif",
  color: "var(--text)",
};

export default function PageContainer({ children }: { children: React.ReactNode }) {
  return <div style={pageContainerStyle}>{children}</div>;
}
