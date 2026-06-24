import pkg from "../package.json" with { type: "json" };

export interface RelayLimitation {
  max_message_length?: number;
  max_subscriptions?: number;
  max_limit?: number;
  max_subid_length?: number;
  max_content_length?: number;
  max_event_tags?: number;
  min_pow_difficulty?: number;
  auth_required?: boolean;
  payment_required?: boolean;
  restricted_writes?: boolean;
  created_at_lower_limit?: number;
  created_at_upper_limit?: number;
  default_limit?: number;
}

export interface RelayInfo {
  name?: string;
  description?: string;
  pubkey?: string;
  contact?: string;
  supported_nips: number[];
  software: string;
  version: string;
  limitation?: RelayLimitation;
  icon?: string;
  banner?: string;
  terms_of_service?: string;
}

export interface RelayInfoOptions {
  defaultLimit?: number;
  maxSubIdLength?: number;
  /** Rate/size limits advertised to clients so they can back off before hitting. */
  limits?: {
    maxMessageBytes?: number;
    maxSubsPerConn?: number;
  };
}

const SUPPORTED_NIPS = [1, 9, 11, 40, 42, 70];
const DEFAULT_SOFTWARE = "https://github.com/Resolvr-io/relay";

export function getRelayInfo(options: RelayInfoOptions = {}): RelayInfo {
  const info: RelayInfo = {
    name: process.env.RELAY_NAME ?? "relay",
    description: process.env.RELAY_DESCRIPTION ?? "A Nostr relay",
    supported_nips: SUPPORTED_NIPS,
    software: process.env.RELAY_SOFTWARE ?? DEFAULT_SOFTWARE,
    // Released semver from package.json (bumped by changesets). `RELAY_VERSION`
    // stays an optional override; `||` so an empty value falls back.
    version: process.env.RELAY_VERSION?.trim() || pkg.version,
    limitation: {
      max_subid_length: options.maxSubIdLength ?? 64,
      default_limit: options.defaultLimit ?? 500,
      ...(options.limits?.maxMessageBytes !== undefined && {
        max_message_length: options.limits.maxMessageBytes,
      }),
      ...(options.limits?.maxSubsPerConn !== undefined && {
        max_subscriptions: options.limits.maxSubsPerConn,
      }),
    },
  };

  if (process.env.RELAY_PUBKEY) info.pubkey = process.env.RELAY_PUBKEY;
  if (process.env.RELAY_CONTACT) info.contact = process.env.RELAY_CONTACT;
  if (process.env.RELAY_ICON) info.icon = process.env.RELAY_ICON;
  if (process.env.RELAY_BANNER) info.banner = process.env.RELAY_BANNER;
  if (process.env.RELAY_TOS) info.terms_of_service = process.env.RELAY_TOS;

  return info;
}
