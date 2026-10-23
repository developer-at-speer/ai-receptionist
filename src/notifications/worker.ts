import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { decryptString } from "../crypto/recipientCipher.js";
import { asDeliveryError, DeliveryError } from "../errors.js";
import { logEvent } from "../log.js";
import { formatAppointment } from "../time.js";
import type { EmailSender } from "./emailService.js";
import { renderAdminEmail, renderSms } from "./content.js";
import {
  claimNext,
  findAppointment,
  markAccepted,
  markAttempt,
  markFailed,
  markRetry,
  recoverExpiredLeases,
  type NotificationJob,
} from "./notificationRepository.js";
import type { SmsSender } from "./smsService.js";

export type WorkerDeps = {
  config: AppConfig;
  db: AppDatabase;
  email: EmailSender;
  sms: SmsSender;
  sendsEnabled: boolean;
  now: () => Date;
  leaseMs: number;
};

export async function processDueNotifications(
  deps: WorkerDeps,
  limit = 20,
): Promise<number> {
  if (!deps.sendsEnabled) return 0;
  recoverExpiredLeases(deps.db, deps.now());
  let processed = 0;
  for (let index = 0; index < limit; index += 1) {
    const job = claimNext(deps.db, deps.now(), deps.leaseMs);
    if (!job) break;
    await deliverJob(deps, job);
    processed += 1;
  }
  return processed;
}

async function deliverJob(deps: WorkerDeps, job: NotificationJob): Promise<void> {
  const now = deps.now();
  const appointment = findAppointment(deps.db, job.appointmentId);
  if (!appointment) {
    markFailed(deps.db, job.id, "appointment_missing", now);
    logEvent("notification_failed", {
      channel: job.channel,
      code: "appointment_missing",
    });
    return;
  }
  const attempt = job.attemptCount + 1;
  markAttempt(deps.db, job.id, attempt, now);
  const when = formatAppointment(new Date(appointment.startsAt), appointment.timezone);
  try {
    if (job.channel === "email") {
      const content = renderAdminEmail({
        clinicName: deps.config.clinicName,
        reference: appointment.appointmentId,
        date: when.date,
        time: when.time,
        physician: appointment.physician,
        demo: appointment.demo,
      });
      const result = await deps.email.send({
        idempotencyKey: job.id,
        to: deps.config.adminEmail,
        subject: content.subject,
        text: content.text,
      });
      markAccepted(deps.db, job.id, result.initialStatus, result.providerMessageId, deps.now());
    } else {
      if (!job.recipientCiphertext) {
        throw new DeliveryError("recipient_unreadable", true);
      }
      const toE164 = decryptString(deps.config.recipientDataKey, job.recipientCiphertext);
      const result = await deps.sms.send({
        idempotencyKey: job.id,
        toE164,
        body: renderSms({
          clinicName: deps.config.clinicName,
          date: when.date,
          time: when.time,
          demo: appointment.demo,
        }),
        statusCallbackUrl: `${deps.config.appBaseUrl}/webhooks/twilio/status`,
      });
      markAccepted(deps.db, job.id, result.initialStatus, result.providerMessageId, deps.now());
    }
    logEvent("notification_accepted", {
      appointmentId: appointment.appointmentId,
      channel: job.channel,
      attempt,
    });
  } catch (error) {
    const delivery = asDeliveryError(error);
    if (delivery.permanent || attempt >= job.maxAttempts) {
      markFailed(deps.db, job.id, delivery.code, deps.now());
      logEvent("notification_failed", {
        appointmentId: appointment.appointmentId,
        channel: job.channel,
        code: delivery.code,
        attempt,
      });
      return;
    }
    const delay = Math.min(60 * 60 * 1000, 30_000 * 2 ** (attempt - 1));
    markRetry(
      deps.db,
      job.id,
      delivery.code,
      new Date(deps.now().getTime() + delay),
      deps.now(),
    );
    logEvent("notification_retry", {
      appointmentId: appointment.appointmentId,
      channel: job.channel,
      code: delivery.code,
      attempt,
    });
  }
}
