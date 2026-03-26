// ─── Profile completion scoring ──────────────────────────────────────────────

const SOCIAL_FIELDS = [
  "social_instagram", "social_youtube", "social_facebook",
  "social_linkedin", "social_tiktok", "social_twitter", "website_url",
] as const;

const WIDGET_FIELDS = [
  "widget_spotify", "widget_soundcloud", "widget_bandsintown", "widget_muso",
] as const;

export type RichProfile = {
  onboarding_completed?: boolean | null;
  bio?: string | null;
  city?: string | null;
  hasSkills: boolean;
  hasVideos: boolean;
  hasRefs: boolean;
  hasServices: boolean;
  social_instagram?: string | null;
  social_youtube?: string | null;
  social_facebook?: string | null;
  social_linkedin?: string | null;
  social_tiktok?: string | null;
  social_twitter?: string | null;
  website_url?: string | null;
  widget_spotify?: string | null;
  widget_soundcloud?: string | null;
  widget_bandsintown?: string | null;
  widget_muso?: string | null;
  company_name?: string | null;
  company_address?: string | null;
  company_tax_id?: string | null;
  legal_form?: string | null;
  custom_domain?: string | null;
  [key: string]: unknown;
};

export type CompletionItem = {
  key: string;
  label: string;
  done: boolean;
};

export type CompletionResult = {
  score: number;
  total: number;
  percentage: number;
  items: CompletionItem[];
  incomplete: string[];
};

export function getProfileCompletion(p: RichProfile): CompletionResult {
  const hasSocial = SOCIAL_FIELDS.some((f) => !!(p[f] as string | null));
  const hasWidget = WIDGET_FIELDS.some((f) => !!(p[f] as string | null));

  const items: CompletionItem[] = [
    { key: "onboarding", label: "Complete onboarding",         done: p.onboarding_completed === true },
    { key: "basics",     label: "Add bio and city",            done: !!(p.bio && p.city) },
    { key: "skills",     label: "Add at least one skill",      done: p.hasSkills },
    { key: "socials",    label: "Add at least one social link", done: hasSocial },
    { key: "widgets",    label: "Add at least one widget",     done: hasWidget },
    { key: "videos",     label: "Add at least one video",      done: p.hasVideos },
    { key: "refs",       label: "Add at least one reference",  done: p.hasRefs },
    { key: "services",   label: "Add at least one service",    done: p.hasServices },
    { key: "business",   label: "Complete business details",   done: !!(p.company_name && p.company_address && p.company_tax_id && p.legal_form) },
    { key: "domain",     label: "Connect custom domain",       done: !!p.custom_domain },
  ];

  const score = items.filter((c) => c.done).length;
  const total = items.length;

  return {
    score,
    total,
    percentage: Math.round((score / total) * 100),
    items,
    incomplete: items.filter((c) => !c.done).map((c) => c.label),
  };
}
