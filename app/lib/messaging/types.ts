export type MessagingProvider = "supabase" | "stream";

export type BookingChannelType = "main" | "role";

export type BookingChannelRoleKey =
  | "admin"
  | "client"
  | "worker"
  | "audio"
  | "light"
  | "transportation"
  | "production"
  | string;

export interface BookingChannelRecord {
  id: string;
  booking_id: string;
  provider: MessagingProvider;
  provider_channel_id: string;
  type: BookingChannelType;
  role_key: BookingChannelRoleKey | null;
  created_at?: string;
}

export interface MessagingMember {
  streamUserId: string;
  displayName: string;
  email: string | null;
  profileId: string | null;
  participantId: string | null;
  roleKey: string;
  isOwner: boolean;
}
