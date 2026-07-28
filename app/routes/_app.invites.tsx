import { redirect, useLoaderData } from "react-router";
import type { Route } from "./+types/_app.invites";
import { createSupabaseServerClient } from "~/lib/supabase.server";
import { getCurrentProfile } from "~/lib/profile.server";
import { loadBetaInviteSectionData, type BetaInviteSectionData } from "~/lib/partner.server";
import PartnerSection from "~/components/PartnerSection";

export async function loader({ request }: Route.LoaderArgs) {
  const { supabase, headers } = createSupabaseServerClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return redirect("/login", { headers });

  const profile = await getCurrentProfile(supabase, user.id);
  if (!profile) return redirect("/login", { headers });
  if (!profile.is_partner) return redirect("/office", { headers });

  const data = await loadBetaInviteSectionData(supabase, profile);
  return Response.json(data, { headers });
}

export default function InvitesPage() {
  const data = useLoaderData<typeof loader>() as BetaInviteSectionData;
  return <PartnerSection {...data} />;
}
