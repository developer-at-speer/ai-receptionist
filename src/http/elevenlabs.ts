import { createHash, createHmac } from "node:crypto";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

const client = new ElevenLabsClient({
  apiKey: "webhook-verification-only",
});

export async function readElevenLabsEvent(
  rawBody: string,
  signature: string,
  secret: string,
): Promise<unknown> {
  return client.webhooks.constructEvent(rawBody, signature, secret);
}

export function elevenLabsSignature(
  secret: string,
  rawBody: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const hash = createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `t=${timestamp},v0=${hash}`;
}

export function postCallIdentity(event: unknown, rawBody: string): {
  eventId: string;
  conversationId: string | null;
  eventType: string;
} {
  const record =
    event && typeof event === "object" ? (event as Record<string, unknown>) : {};
  const eventType = typeof record.type === "string" ? record.type : "unknown";
  const data =
    record.data && typeof record.data === "object"
      ? (record.data as Record<string, unknown>)
      : {};
  const conversationId =
    typeof data.conversation_id === "string" ? data.conversation_id : null;
  const timestamp =
    typeof record.event_timestamp === "number" ||
    typeof record.event_timestamp === "string"
      ? String(record.event_timestamp)
      : "";
  const eventId =
    conversationId && timestamp
      ? `${eventType}:${conversationId}:${timestamp}`
      : `${eventType}:${createHash("sha256").update(rawBody).digest("hex")}`;
  return { eventId, conversationId, eventType };
}
