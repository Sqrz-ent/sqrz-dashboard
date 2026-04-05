import { useState, useEffect, useRef } from "react";
import { supabase } from "~/lib/supabase.client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Notification = {
  id: string;
  created_at: string;
  read: boolean;
};

export type Toast = Notification & { toastId: string };

export type Lead = {
  id: string;
  description: string | null;
  created_at: string;
};

// ─── Read-state persistence (localStorage) ────────────────────────────────────

const READ_KEY = "sqrz_notif_read";

function getReadIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(READ_KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

function persistReadIds(ids: Set<string>) {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...ids]));
  } catch {}
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profileName, setProfileName] = useState<string | null>(null);
  const [unreadMessageCount, setUnreadMessageCount] = useState(0);
  const initialized = useRef(false);

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function init() {
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) return;

      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id, name")
        .eq("user_id", user.id)
        .single();

      if (!profileError && profile) {
        setProfileId(profile.id as string);
        setProfileName((profile.name as string) ?? null);
      }

      if (profileError || !profile) return;

      const readIds = getReadIds();

      // Initial fetch: only new booking requests
      const { data: bookingData } = await supabase
        .from("bookings")
        .select("id, created_at")
        .eq("owner_id", profile.id)
        .eq("status", "requested")
        .order("created_at", { ascending: false })
        .limit(10);

      if (bookingData) {
        setNotifications(
          bookingData.map((b: Record<string, unknown>) => ({
            id: b.id as string,
            created_at: b.created_at as string,
            read: readIds.has(b.id as string),
          }))
        );
      }

      // Initial fetch: open leads
      const { data: leadData } = await supabase
        .from("bookings")
        .select("id, created_at, description")
        .eq("owner_id", profile.id)
        .eq("status", "lead")
        .order("created_at", { ascending: false })
        .limit(50);

      if (leadData) {
        setLeads(
          leadData.map((b: Record<string, unknown>) => ({
            id: b.id as string,
            description: (b.description as string) ?? null,
            created_at: b.created_at as string,
          }))
        );
      }

      // Unread message count across all owned bookings
      const { data: ownedIds } = await supabase
        .from("bookings")
        .select("id")
        .eq("owner_id", profile.id);

      if (ownedIds && ownedIds.length > 0) {
        const ids = (ownedIds as { id: string }[]).map((b) => b.id);
        const { count } = await supabase
          .from("messages")
          .select("id", { count: "exact", head: true })
          .in("booking_id", ids)
          .eq("is_read", false)
          .neq("sender_id", profile.id);
        setUnreadMessageCount(count ?? 0);
      }

      initialized.current = true;

      // Realtime subscription for new bookings (any status)
      const filter = `owner_id=eq.${profile.id}`;

      try {
        channel = supabase
          .channel("bookings-notifications")
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "bookings", filter },
            (payload) => {
              const b = payload.new as Record<string, unknown>;
              const bStatus = b.status as string;

              if (bStatus === "lead") {
                // Add to leads list
                const lead: Lead = {
                  id: b.id as string,
                  description: (b.description as string) ?? null,
                  created_at: b.created_at as string,
                };
                setLeads((prev) => [lead, ...prev]);
              } else if (bStatus === "requested") {
                // Add to notifications + toast for new booking requests only
                const notif: Notification = {
                  id: b.id as string,
                  created_at: b.created_at as string,
                  read: false,
                };
                setNotifications((prev) => [notif, ...prev]);
                const toastId = `toast-${b.id}-${Date.now()}`;
                setToasts((prev) => [...prev, { ...notif, toastId }]);
              }
            }
          )
          .subscribe();
      } catch (err) {
        console.error("Failed to set up Realtime subscription:", err);
      }
    }

    init();

    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  function markAsRead(id: string) {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n))
    );
    const readIds = getReadIds();
    readIds.add(id);
    persistReadIds(readIds);
  }

  function markAllAsRead() {
    setNotifications((prev) => {
      const readIds = getReadIds();
      prev.forEach((n) => readIds.add(n.id));
      persistReadIds(readIds);
      return prev.map((n) => ({ ...n, read: true }));
    });
  }

  function dismissToast(toastId: string) {
    setToasts((prev) => prev.filter((t) => t.toastId !== toastId));
  }

  async function convertLead(id: string) {
    const { error } = await supabase
      .from("bookings")
      .update({ status: "requested" })
      .eq("id", id);
    if (!error) {
      setLeads((prev) => prev.filter((l) => l.id !== id));
    }
  }

  async function declineLead(id: string) {
    const { error } = await supabase
      .from("bookings")
      .update({ status: "declined" })
      .eq("id", id);
    if (!error) {
      setLeads((prev) => prev.filter((l) => l.id !== id));
    }
  }

  const unreadCount = notifications.filter((n) => !n.read).length;
  const leadCount = leads.length;

  return {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    toasts,
    dismissToast,
    leads,
    leadCount,
    convertLead,
    declineLead,
    profileId,
    profileName,
    unreadMessageCount,
  };
}
