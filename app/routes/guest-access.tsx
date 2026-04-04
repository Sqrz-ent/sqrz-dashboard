export default function GuestAccess() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100vh', gap: '1rem', textAlign: 'center', padding: '2rem' }}>
      <h1>No booking found</h1>
      <p>Please use the booking link from your email to access your booking.</p>
      <a href="https://sqrz.com">Learn about SQRZ →</a>
    </div>
  );
}
