import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import { confirmBooking } from "./booking/bookingService.js";
import { normalizeBookingBody } from "./booking/normalizeBooking.js";
import type { AppConfig } from "./config.js";
import type { AppDatabase } from "./db/database.js";
import { BookingError } from "./errors.js";
import { safeEqual } from "./crypto/recipientCipher.js";
import {
  postCallIdentity,
  readElevenLabsEvent,
} from "./http/elevenlabs.js";
import { logEvent } from "./log.js";
import {
  applyProviderStatus,
  countProviderEvents,
  findAppointment,
  listJobs,
  recordProviderEvent,
} from "./notifications/notificationRepository.js";
import {
  validateTwilioSignature,
  type SmsSender,
} from "./notifications/smsService.js";
import type { EmailSender } from "./notifications/emailService.js";
import { processDueNotifications } from "./notifications/worker.js";
import type { PetalPublisher } from "./petal/petalClient.js";
import type { SchedulingService } from "./scheduling/schedulingService.js";
import { formatAppointment, formatParts } from "./time.js";

export type AppDeps = {
  config: AppConfig;
  db: AppDatabase;
  scheduler: SchedulingService;
  email: EmailSender;
  sms: SmsSender;
  sendsEnabled: boolean;
  now: () => Date;
  leaseMs: number;
  autoDispatch?: boolean;
  petal?: PetalPublisher;
};

const bookSchema = z.object({
  patient_reference: z.string().regex(/^[\p{L}\p{N}][\p{L}\p{N}&.'’ -]{0,79}$/u),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  appointment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  appointment_time: z.string().regex(/^\d{2}:\d{2}$/),
  physician: z.string().min(1).max(80),
  conversation_id: z.string().max(128).optional(),
  caller_phone: z.string().max(32).optional(),
  reason: z.string().max(200).optional(),
});

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

function authorized(req: Request, secret: string): boolean {
  const header = headerValue(req.headers.authorization);
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match || !secret) return false;
  return safeEqual(match[1], secret);
}

function blankToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function limitedText(value: unknown, max: number): string | undefined {
  const text = blankToUndefined(value);
  return text ? text.slice(0, max) : undefined;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  app.get("/health", (_req, res) => {
    res.status(200).json({
      ok: true,
      demoMode: deps.config.demoMode,
      schedulingProvider: deps.scheduler.provider,
      liveSends: deps.sendsEnabled,
      petalCards: Boolean(deps.config.petalApiUrl && deps.config.petalBookingSecret),
    });
  });

  app.post(
    ["/api/appointments/book", "/webhooks/elevenlabs/book-appointment"],
    express.json({ limit: "32kb" }),
    async (req, res) => {
      if (!authorized(req, deps.config.bookingWebhookSecret)) {
        logEvent("booking_rejected", { code: "unauthorized" });
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      const rawBody =
        req.body && typeof req.body === "object"
          ? (req.body as Record<string, unknown>)
          : {};
      const body = normalizeBookingBody(rawBody, {
        now: deps.now(),
        timeZone: deps.config.timeZone,
        physicianName: deps.config.physicianName,
        patientReference: deps.config.demoPatientReference,
      });
      const parsed = bookSchema.safeParse({
        patient_reference:
          typeof body.patient_reference === "string"
            ? body.patient_reference.trim()
            : body.patient_reference,
        date_of_birth: body.date_of_birth,
        appointment_date: body.appointment_date,
        appointment_time: body.appointment_time,
        physician:
          typeof body.physician === "string" ? body.physician.trim() : body.physician,
        conversation_id: limitedText(body.conversation_id, 128),
        caller_phone: limitedText(body.caller_phone, 32),
        reason: limitedText(body.reason, 200),
      });
      if (!parsed.success) {
        const fields = parsed.error.issues
          .map((issue) => issue.path.join("."))
          .filter(Boolean)
          .join(",");
        logEvent("booking_rejected", { code: "invalid_request", fields });
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      // caller_phone and reason are accepted so the agent can send them,
      // then discarded. Caller ID is not SMS consent, and reason is clinical text.
      void parsed.data.caller_phone;
      void parsed.data.reason;

      try {
        const result = await confirmBooking(
          deps.db,
          deps.config,
          deps.scheduler,
          {
            patientReference: parsed.data.patient_reference,
            dateOfBirth: parsed.data.date_of_birth ?? "",
            appointmentDate: parsed.data.appointment_date,
            appointmentTime: parsed.data.appointment_time,
            physician: parsed.data.physician,
            conversationId: parsed.data.conversation_id,
          },
          deps.now(),
        );
        const when = formatAppointment(
          new Date(result.appointment.startsAt),
          result.appointment.timezone,
        );
        const demo = result.appointment.demo;
        res.status(200).json({
          ok: true,
          demo,
          scheduling_provider: result.appointment.schedulingProvider,
          juno_appointment: false,
          duplicate: result.duplicate,
          appointment_id: result.appointment.appointmentId,
          status: result.appointment.status,
          physician: result.appointment.physician,
          date: when.date,
          time: when.time,
          timezone: result.appointment.timezone,
          message: demo
            ? `Synthetic demo booking confirmed. This appointment is not in Juno EMR. Reference ${result.appointment.appointmentId}. ${when.date} at ${when.time}. Physician ${result.appointment.physician}.`
            : `Appointment confirmed. Reference ${result.appointment.appointmentId}. ${when.date} at ${when.time}. Physician ${result.appointment.physician}.`,
          agent_instruction:
            "Read message to the caller. Do not send a confirmation SMS or email yourself. This backend sends the one confirmation after the booking is stored.",
        });
        if (deps.petal) {
          const parts = formatParts(
            new Date(result.appointment.startsAt),
            result.appointment.timezone,
          );
          const card = {
            appointment_id: result.appointment.appointmentId,
            patient_reference: result.appointment.patientReference,
            physician: result.appointment.physician,
            date: `${parts.year}-${parts.month}-${parts.day}`,
            time: `${parts.hour}:${parts.minute}`,
            timezone: result.appointment.timezone,
            demo,
            scheduling_provider: result.appointment.schedulingProvider,
            clinic_name: deps.config.petalClinicName,
          };
          setImmediate(() => {
            void deps.petal?.(card).catch(() => {
              logEvent("petal_card_failed", { code: "publish_failed" });
            });
          });
        }
        const shouldDispatch = deps.autoDispatch ?? deps.sendsEnabled;
        if (shouldDispatch && !result.duplicate) {
          setImmediate(() => {
            void processDueNotifications(deps).catch(() => {
              logEvent("notification_worker_failed", { code: "worker_error" });
            });
          });
        }
      } catch (error) {
        if (error instanceof BookingError) {
          logEvent("booking_rejected", {
            code: error.code,
            appointment_date: parsed.data.appointment_date,
            appointment_time: parsed.data.appointment_time,
          });
          const message =
            error.code === "date_in_past"
              ? "That date is in the past. Ask for a future date and call book_appointment again. Do not say the scheduling system is down."
              : error.code === "invalid_time"
                ? "That time cannot be booked. Ask for a time on the hour or half hour and call book_appointment again."
                : undefined;
          res.status(error.statusCode).json({ error: error.code, message });
          return;
        }
        logEvent("booking_failed", { code: "internal_error" });
        res.status(500).json({ error: "internal_error" });
      }
    },
  );

  app.get(
    "/api/appointments/:appointmentId",
    (req, res) => {
      if (!authorized(req, deps.config.bookingWebhookSecret)) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(req.params.appointmentId)) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const appointment = findAppointment(deps.db, req.params.appointmentId);
      if (!appointment) {
        res.status(404).json({ error: "not_found" });
        return;
      }
      const when = formatAppointment(
        new Date(appointment.startsAt),
        appointment.timezone,
      );
      res.status(200).json({
        appointment_id: appointment.appointmentId,
        demo: appointment.demo,
        scheduling_provider: appointment.schedulingProvider,
        juno_appointment: false,
        status: appointment.status,
        physician: appointment.physician,
        date: when.date,
        time: when.time,
        timezone: appointment.timezone,
        notifications: listJobs(deps.db, appointment.appointmentId).map((job) => ({
          channel: job.channel,
          status: job.status,
          attempt_count: job.attemptCount,
          provider_message_id: job.providerMessageId,
          last_error_code: job.lastErrorCode,
        })),
      });
    },
  );

  app.post(
    "/webhooks/elevenlabs/post-call",
    express.text({ type: "application/json", limit: "2mb" }),
    async (req, res) => {
      const rawBody = typeof req.body === "string" ? req.body : "";
      const signature = headerValue(req.headers["elevenlabs-signature"]);
      let event: unknown;
      try {
        event = await readElevenLabsEvent(
          rawBody,
          signature,
          deps.config.elevenlabsWebhookSecret,
        );
      } catch {
        logEvent("post_call_rejected", { code: "invalid_signature" });
        res.status(401).json({ error: "invalid_signature" });
        return;
      }
      const identity = postCallIdentity(event, rawBody);
      const inserted = recordProviderEvent(deps.db, {
        provider: "elevenlabs",
        eventId: identity.eventId,
        conversationId: identity.conversationId,
        eventType: identity.eventType,
        receivedAt: deps.now().toISOString(),
      });
      logEvent("post_call_received", {
        duplicate: !inserted,
        eventType: identity.eventType,
        stored: countProviderEvents(deps.db),
      });
      res.status(200).json({ received: true, duplicate: !inserted });
    },
  );

  app.post(
    "/webhooks/twilio/status",
    express.urlencoded({ extended: false, limit: "32kb" }),
    (req, res) => {
      const params = formParams(req.body);
      const signature = headerValue(req.headers["x-twilio-signature"]);
      const url = `${deps.config.appBaseUrl}/webhooks/twilio/status`;
      const valid = validateTwilioSignature(
        deps.config.twilioAuthToken,
        signature,
        url,
        params,
      );
      if (!valid) {
        logEvent("twilio_status_rejected", { code: "invalid_signature" });
        res.status(403).json({ error: "invalid_signature" });
        return;
      }
      const messageSid = params.MessageSid ?? "";
      const messageStatus = params.MessageStatus ?? "";
      if (!/^SM[0-9a-fA-F]{32}$/.test(messageSid)) {
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      const allowed = new Set([
        "accepted",
        "queued",
        "sending",
        "sent",
        "delivered",
        "undelivered",
        "failed",
      ]);
      if (!allowed.has(messageStatus)) {
        logEvent("twilio_status_ignored", { code: "unknown_status" });
        res.status(200).json({ received: true, matched: false });
        return;
      }
      const errorCode = params.ErrorCode?.trim() || null;
      const matched = applyProviderStatus(
        deps.db,
        messageSid,
        messageStatus === "accepted" || messageStatus === "sending"
          ? "queued"
          : messageStatus,
        errorCode,
        deps.now(),
      );
      logEvent("twilio_status_received", {
        matched,
        status: messageStatus,
      });
      res.status(200).json({ received: true, matched });
    },
  );

  app.use(
    (error: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(error);
        return;
      }
      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : error instanceof SyntaxError
            ? 400
            : 500;
      logEvent("request_failed", {
        code: status === 400 ? "invalid_request" : "internal_error",
      });
      res
        .status(status === 400 ? 400 : 500)
        .json({ error: status === 400 ? "invalid_request" : "internal_error" });
    },
  );

  return app;
}

function formParams(body: unknown): Record<string, string> {
  if (!body || typeof body !== "object") return {};
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") params[key] = value;
  }
  return params;
}
