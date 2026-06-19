// review-surfaces.CONFIG_FACTS.4 — a bounded XML text-plist reader for Info.plist,
// *.entitlements, and PrivacyInfo.xcprivacy. It extracts the SET of declared keys
// and a few specific scalar values (the only things the high-signal facts need),
// never inferring absence from a binary plist (goal contract D10): a binary plist
// is flagged so callers emit a diagnostic instead of a false "key removed".

export interface PlistView {
  // True when the content is a BINARY plist — keys/values are unknown, not absent.
  binary: boolean;
  // Every <key> name declared anywhere in the plist (nested included).
  keys: Set<string>;
  // Boolean value of a specific key by its immediate <true/>/<false/> sibling.
  bool: (key: string) => boolean | undefined;
  // A whitespace-normalized fingerprint of the VALUE region(s) under a key name (the
  // text between its </key> and the next <key>), so a change UNDER an existing key (a new
  // app group, a new privacy-reason entry) is detectable even when the key set is equal.
  valueFingerprint: (key: string) => string | undefined;
}

export function isBinaryPlist(content: string): boolean {
  return content.startsWith("bplist");
}

export function readPlist(content: string): PlistView {
  if (isBinaryPlist(content)) {
    return { binary: true, keys: new Set(), bool: () => undefined, valueFingerprint: () => undefined };
  }
  const keys = new Set<string>();
  // key name -> concatenated value region(s). A key value runs from after its </key> to
  // the next <key> tag (or end); duplicate key names across nested dicts are concatenated
  // so any instance changing alters the fingerprint.
  const values = new Map<string, string>();
  const keyTag = /<key>([^<]*)<\/key>/g;
  const matches = [...content.matchAll(keyTag)];
  for (let i = 0; i < matches.length; i += 1) {
    const name = matches[i][1].trim();
    keys.add(name);
    const valueStart = (matches[i].index ?? 0) + matches[i][0].length;
    const valueEnd = i + 1 < matches.length ? matches[i + 1].index ?? content.length : content.length;
    const region = content.slice(valueStart, valueEnd).replace(/\s+/g, " ").trim();
    values.set(name, (values.get(name) ?? "") + region);
  }
  return {
    binary: false,
    keys,
    bool: (key: string): boolean | undefined => {
      // <key>NAME</key> optionally followed by whitespace then <true/> or <false/>.
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<(true|false)\\s*/>`).exec(content);
      return match ? match[1] === "true" : undefined;
    },
    valueFingerprint: (key: string): string | undefined => values.get(key)
  };
}
