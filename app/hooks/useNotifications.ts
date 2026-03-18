import { useState, useEffect, useRef } from "react";
import { supabase } from "~/lib/supabase.client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Notification = {
  id: string;
  service: string | null;
  city: string | null;
  created_at: string;
  read: boolean;
};

export type Toast = Notification & { toastId: string };

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
  const [toasts, setToasts] = useState<Toast[]>([]);
  const initialized = useRef(false);

  useEffect(() => {
    let channel: ReturnType<typeof supabase.channel> | null = null;

    async function init() {
      // Step 1 — resolve the authenticated user
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError) {
        console.error("[useNotifications] auth.getUser error:", userError.message);
        return;
      }

      if (!user) {
        console.warn("[useNotifications] No authenticated user — skipping subscription");
        return;
      }

      console.log("Auth user.id:", user?.id);

      // Step 2 — resolve profile.id (owner_id on bookings references profiles.id, not auth uid)
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("id")
        .eq("user_id", user.id)
        .single();

      if (profileError) {
        console.error("[useNotifications] Profile fetch error:", profileError.message);
        return;
      }

      if (!profile) {
        console.warn("[useNotifications] No profile row found for user:", user.id);
        return;
      }

      console.log("[notifications] profile.id:", profile?.id);
      console.log("Subscribing with profile.id:", profile?.id);

      const readIds = getReadIds();

      // Step 3 — initial fetch: bookings from last 7 days
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data, error: fetchError } = await supabase
        .from("bookings")
        .select("id, created_at, status, city, venue")
        .eq("owner_id", profile.id)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(50);

      if (fetchError) {
        console.error("[useNotifications] Initial fetch error:", fetchError.message);
      } else {
        console.log("[useNotifications] Initial fetch returned", data?.length ?? 0, "bookings");
      }

      if (data) {
        setNotifications(
          data.map((b: Record<string, unknown>) => ({
            id: b.id as string,
            service: (b.status as string) ?? null,
            city: (b.city as string) ?? (b.venue as string) ?? null,
            created_at: b.created_at as string,
            read: readIds.has(b.id as string),
          }))
        );
      }

      initialized.current = true;

      // Step 4 — Realtime subscription using profile.id (matches bookings.owner_id)
      const filter = `owner_id=eq.${profile.id}`;
      console.log("Starting subscription for user:", user.id);

      try {
        channel = supabase
          .channel("bookings-notifications")
          .on(
            "postgres_changes",
            {
              event: "INSERT",
              schema: "public",
              table: "bookings",
              filter,
            },
            (payload) => {
              console.log("Realtime event received:", payload);
              const b = payload.new as Record<string, unknown>;
              const notif: Notification = {
                id: b.id as string,
                service: (b.status as string) ?? null,
                city: (b.city as string) ?? (b.venue as string) ?? null,
                created_at: b.created_at as string,
                read: false,
              };
              setNotifications((prev) => [notif, ...prev]);
              // Toast only for live events, never for initial load
              const toastId = `toast-${b.id}-${Date.now()}`;
              setToasts((prev) => [...prev, { ...notif, toastId }]);
            }
          )
          .subscribe((status, err) => {
            console.log("Realtime status:", status);
            if (err) console.error("Realtime error:", err);
            if (status === "CHANNEL_ERROR") console.error("Channel error - check filter value and RLS");
            if (status === "TIMED_OUT") console.error("Subscription timed out");
            if (status === "SUBSCRIBED") console.log("Successfully subscribed, listening for bookings");
          });
      } catch (err) {
        console.error("Failed to set up Realtime subscription:", err);
      }
    }

    init();

    return () => {
      if (channel) {
        console.log("[useNotifications] Removing channel");
        supabase.removeChannel(channel);
      }
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

  const unreadCount = notifications.filter((n) => !n.read).length;

  return { notifications, unreadCount, markAsRead, markAllAsRead, toasts, dismissToast };
}
