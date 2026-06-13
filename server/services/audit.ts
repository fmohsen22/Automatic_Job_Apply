import { prisma } from "../db.js";
import { toJsonString } from "../utils/json.js";

const SECRETISH_KEYS = /secret|password|token|apiKey|key|credential|encrypted/i;

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        SECRETISH_KEYS.test(key) ? "[redacted]" : redactSecrets(nested)
      ])
    );
  }

  return value;
}

export async function audit(action: string, summary: string, options?: {
  entity?: string;
  entityId?: string;
  metadata?: Record<string, unknown>;
}) {
  return prisma.auditEvent.create({
    data: {
      action,
      summary,
      entity: options?.entity,
      entityId: options?.entityId,
      metadata: options?.metadata ? toJsonString(redactSecrets(options.metadata)) : undefined
    }
  });
}
