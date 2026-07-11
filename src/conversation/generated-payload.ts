import { findReviewSurfacesArtifactName } from "../artifacts/inventory";

/** True only for transport/scaffolding or an artifact introduced as payload data. */
export function conversationEventLooksLikeGeneratedPayload(summary: string): boolean {
  const trimmed = summary.trimStart();
  if (/<(?:environment_context|permissions instructions|skills_instructions|apps_instructions|plugins_instructions|recommended_plugins|local-command-caveat|command-name|command-message|command-args|system-reminder)>|<codex_internal_context\b/i.test(summary) ||
    /# AGENTS\.md instructions/i.test(summary)) {
    return true;
  }
  const transportMarker = /(?:custom_tool_call_output|internal_chat_message_metadata_passthrough)/.exec(summary);
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return transportMarker !== null || /["']type["']\s*:\s*["']input_image["']|data:image\//i.test(summary) ||
      findReviewSurfacesArtifactName(summary) !== undefined;
  }
  if (transportMarker) {
    const prefix = summary.slice(Math.max(0, transportMarker.index - 240), transportMarker.index);
    return /(?:here (?:is|'s)|quoted|generated|report|payload|output)[^\n]{0,120}[{[]/i.test(prefix) ||
      /(?:\{|\[)\s*["\\].{0,120}$/.test(prefix);
  }
  const artifact = findReviewSurfacesArtifactName(summary);
  if (!artifact) return false;
  const prefix = summary.slice(Math.max(0, artifact.index - 240), artifact.index);
  const suffix = summary.slice(artifact.index + artifact.name.length, artifact.index + artifact.name.length + 240);
  const introducedAsPayload = /(?:here (?:is|'s)|quoted|generated|report|payload|output|contents?(?: of)?)[^\n]{0,120}$/i.test(prefix);
  const hasPayloadBoundary = /^\s*(?:(?:output|contents?)\s*)?:\s*(?:\n|```|---|[{[])/i.test(suffix);
  return introducedAsPayload && hasPayloadBoundary;
}
