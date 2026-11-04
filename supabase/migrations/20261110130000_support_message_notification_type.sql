-- Support chat (V1, Sandbox) — adds "support_message" to notifications_type_check.
-- Written for supabase/functions/support-chat-webhook (new, this pass), which
-- inserts a notifications row with type = "support_message" on every Stream
-- message.new in a support-chat channel (channel custom field kind =
-- "support" — see app/lib/messaging/support.server.ts). subtype/related_id
-- are not part of this change — the webhook sets related_id to the request's
-- boost_campaigns.id and leaves subtype null.
--
-- NOT APPLIED — write only, per the task that added this file. Until this
-- runs, every notifications insert with type = "support_message" fails with
-- a check-constraint violation (the webhook catches and logs that, it never
-- blocks the underlying Stream chat message).

alter table public.notifications drop constraint notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type = any (array['campaign_status', 'campaign_ended', 'booking', 'advisor_warning',
                           'chat_request', 'wallet_bonus', 'wire_topup_received', 'support_message']));
