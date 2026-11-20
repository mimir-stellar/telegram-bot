import { createHash } from "node:crypto";

import type { DecodedEvent } from "../stellar/decode.js";

/**
 * Stable opaque identifier for one notification event.
 *
 * Only chain position metadata is hashed; formatted notification content and
 * credentials are never inputs to the identifier.
 */
export function notificationCorrelationId(event: DecodedEvent): string {
  const identity = event.eventId
    ? ["event", event.eventId]
    : [
        "position",
        event.ledger,
        event.txHash,
        event.transactionIndex ?? "unknown",
        event.operationIndex ?? "unknown",
        event.eventType,
        event.payload.name,
      ];
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "mimir-notification-correlation-v1",
        event.source,
        event.contractId,
        ...identity,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
  return `evt_${digest}`;
}
