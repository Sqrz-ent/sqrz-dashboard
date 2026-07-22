-- Rebuild invoice upload only (no generation, no e-invoicing).
CREATE TABLE invoices (
  id              uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  booking_id      uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  uploaded_by     uuid NOT NULL REFERENCES profiles(id),
  file_url        text NOT NULL,
  file_name       text NOT NULL,
  file_size_bytes integer,
  uploaded_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_bypass" ON invoices
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "booking_parties_can_view" ON invoices
  FOR SELECT TO authenticated
  USING (
    booking_id IN (
      SELECT b.id FROM bookings b
      JOIN booking_participants bp ON bp.booking_id = b.id
      WHERE bp.user_id = auth.uid()
    )
  );

CREATE INDEX idx_invoices_booking_id ON invoices(booking_id);

-- Match the upload route's 10MB cap (bucket was previously 5MB).
UPDATE storage.buckets SET file_size_limit = 10485760 WHERE id = 'invoices';
