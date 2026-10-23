import { createRequire } from "node:module";
import type { AppConfig } from "../config.js";
import { DeliveryError } from "../errors.js";
import { assertLiveDeliveryAllowed, type SendResult } from "./emailService.js";

const require = createRequire(import.meta.url);
const twilio = require("twilio") as typeof import("twilio");

export type OutboundSms = {
  idempotencyKey: string;
  toE164: string;
  body: string;
  statusCallbackUrl: string;
};

export interface SmsSender {
  send(message: OutboundSms): Promise<SendResult>;
}

const PERMANENT_TWILIO = new Set([
  "20003",
  "20404",
  "21211",
  "21212",
  "21408",
  "21606",
  "21608",
  "21610",
  "21614",
]);

export function classifyTwilioError(error: unknown): DeliveryError {
  const record =
    error && typeof error === "object"
      ? (error as { code?: unknown; status?: unknown })
      : {};
  const code = record.code === undefined ? "twilio_error" : String(record.code);
  const status = Number(record.status ?? 0);
  const permanent =
    PERMANENT_TWILIO.has(code) ||
    (status >= 400 && status < 500 && status !== 429);
  return new DeliveryError(code, permanent);
}

export function twilioMessageFields(
  config: AppConfig,
  message: OutboundSms,
): Record<string, string> {
  if (!config.twilioPhoneNumber) {
    throw new DeliveryError("sms_sender_not_configured", true);
  }
  // From and StatusCallback are per message. This request does not set the
  // phone number's inbound SMS URL, so ElevenLabs keeps the conversation webhook.
  return {
    To: message.toE164,
    From: config.twilioPhoneNumber,
    Body: message.body,
    StatusCallback: message.statusCallbackUrl,
  };
}

export function createTwilioSmsSender(config: AppConfig): SmsSender {
  const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
  return {
    async send(message) {
      assertLiveDeliveryAllowed(config);
      const data = twilioMessageFields(config, message);
      try {
        const response = await client.request({
          method: "post",
          uri: `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Messages.json`,
          data,
          headers: { "Idempotency-Key": message.idempotencyKey },
        });
        const body = (response?.body ?? response) as {
          sid?: string;
          status?: string;
        };
        if (!body?.sid) throw new DeliveryError("twilio_missing_sid", true);
        const status = body.status === "sent" ? "sent" : "queued";
        return { providerMessageId: body.sid, initialStatus: status };
      } catch (error) {
        if (error instanceof DeliveryError) throw error;
        throw classifyTwilioError(error);
      }
    },
  };
}

export function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!authToken || !signature) return false;
  return twilio.validateRequest(authToken, signature, url, params);
}

export function expectedTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  return twilio.getExpectedTwilioSignature(authToken, url, params);
}
