import { Resend } from "resend";
import type { AppConfig } from "../config.js";
import { DeliveryError } from "../errors.js";

export type OutboundEmail = {
  idempotencyKey: string;
  to: string;
  subject: string;
  text: string;
};

export type SendResult = {
  providerMessageId: string;
  initialStatus: string;
};

export interface EmailSender {
  send(message: OutboundEmail): Promise<SendResult>;
}

const TRANSIENT_RESEND = new Set([
  "rate_limit_exceeded",
  "internal_server_error",
  "application_error",
  "concurrent_idempotent_requests",
]);

export function assertLiveDeliveryAllowed(config: AppConfig): void {
  if (process.env.NODE_ENV === "test") {
    throw new DeliveryError("live_sends_blocked_in_test", true);
  }
  if (!config.allowLiveSends) {
    throw new DeliveryError("live_sends_disabled", true);
  }
}

export function createResendEmailSender(config: AppConfig): EmailSender {
  const resend = new Resend(config.resendApiKey);
  return {
    async send(message) {
      assertLiveDeliveryAllowed(config);
      const result = await resend.emails.send(
        {
          from: config.emailFrom,
          to: [message.to],
          subject: message.subject,
          text: message.text,
        },
        { idempotencyKey: message.idempotencyKey },
      );
      if (result.error || !result.data) {
        const name = result.error?.name ?? "resend_error";
        const status = result.error?.statusCode ?? 0;
        const transient =
          TRANSIENT_RESEND.has(name) || status === 429 || status >= 500;
        throw new DeliveryError(name, !transient);
      }
      return { providerMessageId: result.data.id, initialStatus: "sent" };
    },
  };
}
