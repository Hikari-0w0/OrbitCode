import type { ManagedContextMessage } from "@/core/context/types";

const CONTEXT_REFERENCE_PATTERN = /^context:\/\/v1\/[0-9a-f-]{36}$/u;

export function collectContextReferences(
  messages: readonly ManagedContextMessage[],
): readonly string[] {
  const references = new Set<string>();
  for (const message of messages) {
    if (message.kind === "tool-result" && message.payload.storage === "offloaded") {
      references.add(message.payload.reference);
      continue;
    }
    if (message.kind !== "boundary") continue;
    const reference = operationalBoundaryReference(message.content);
    if (reference !== undefined) references.add(reference);
  }
  return [...references];
}

function operationalBoundaryReference(content: string): string | undefined {
  if (
    !content.startsWith("<orbitcode_operational_compaction>\n") ||
    !content.endsWith("\n</orbitcode_operational_compaction>")
  ) return undefined;
  const line = content.split("\n").find((item) => item.startsWith("reference: "));
  if (line === undefined) return undefined;
  const reference = line.slice("reference: ".length);
  return CONTEXT_REFERENCE_PATTERN.test(reference) ? reference : undefined;
}
