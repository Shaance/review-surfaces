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
}

export function isBinaryPlist(content: string): boolean {
  return content.startsWith("bplist");
}

export function readPlist(content: string): PlistView {
  if (isBinaryPlist(content)) {
    return { binary: true, keys: new Set(), bool: () => undefined };
  }
  const keys = new Set<string>();
  for (const match of content.matchAll(/<key>([^<]+)<\/key>/g)) {
    keys.add(match[1].trim());
  }
  return {
    binary: false,
    keys,
    bool: (key: string): boolean | undefined => {
      // <key>NAME</key> optionally followed by whitespace then <true/> or <false/>.
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<(true|false)\\s*/>`).exec(content);
      return match ? match[1] === "true" : undefined;
    }
  };
}
