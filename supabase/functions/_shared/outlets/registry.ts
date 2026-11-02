// All API outlets → adapter factory. Used by sandbox-admin (test_connection). Adding an outlet =
// one line here, one in types.ts' OutletName, and a row in outlet_sandbox.outlets.
// Factories read config at call time (after primeOutletSecrets), so they always see current keys.

import { type OutletAdapter, type OutletName } from "./types.ts";
import { GoogleAdsAdapter, googleConfigFromEnv } from "./google.ts";
import { MicrosoftAdsAdapter, microsoftConfigFromEnv } from "./microsoft.ts";
import { SnapchatAdsAdapter, snapchatConfigFromEnv } from "./snapchat.ts";
import { OpenAIAdsAdapter, openaiConfigFromEnv } from "./openai.ts";
import { SpotifyAdsAdapter, spotifyConfigFromEnv } from "./spotify.ts";
import { TikTokAdsAdapter, tiktokConfigFromEnv } from "./tiktok.ts";
import { RedditAdsAdapter, redditConfigFromEnv } from "./reddit.ts";
import { LinkedInAdsAdapter, linkedinConfigFromEnv } from "./linkedin.ts";
import { PinterestAdsAdapter, pinterestConfigFromEnv } from "./pinterest.ts";
import { XAdsAdapter, xConfigFromEnv } from "./x.ts";
import { AmazonAdsAdapter, amazonConfigFromEnv } from "./amazon.ts";
import { TaboolaAdsAdapter, taboolaConfigFromEnv } from "./taboola.ts";
import { AdQuickAdapter, adquickConfigFromEnv } from "./adquick.ts";

export const OUTLET_ADAPTERS: Record<OutletName, () => OutletAdapter> = {
  google: () => new GoogleAdsAdapter(googleConfigFromEnv()),
  microsoft: () => new MicrosoftAdsAdapter(microsoftConfigFromEnv()),
  snapchat: () => new SnapchatAdsAdapter(snapchatConfigFromEnv()),
  openai: () => new OpenAIAdsAdapter(openaiConfigFromEnv()),
  spotify: () => new SpotifyAdsAdapter(spotifyConfigFromEnv()),
  tiktok: () => new TikTokAdsAdapter(tiktokConfigFromEnv()),
  reddit: () => new RedditAdsAdapter(redditConfigFromEnv()),
  linkedin: () => new LinkedInAdsAdapter(linkedinConfigFromEnv()),
  pinterest: () => new PinterestAdsAdapter(pinterestConfigFromEnv()),
  x: () => new XAdsAdapter(xConfigFromEnv()),
  amazon: () => new AmazonAdsAdapter(amazonConfigFromEnv()),
  taboola: () => new TaboolaAdsAdapter(taboolaConfigFromEnv()),
  adquick: () => new AdQuickAdapter(adquickConfigFromEnv()),
};
