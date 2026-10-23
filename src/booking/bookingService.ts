import { encryptString } from "../crypto/recipientCipher.js";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/database.js";
import { BookingError, isUniqueConstraint, SchedulingError } from "../errors.js";
import {
  findAppointmentBySlot,
  insertConfirmedBooking,
  type AppointmentRecord,
} from "../notifications/notificationRepository.js";
import { verifyPatient } from "../patients/patientRepository.js";
import type { SchedulingService } from "../scheduling/schedulingService.js";
import { parseClinicInstant } from "../time.js";

export type BookAppointmentInput = {
  patientReference: string;
  dateOfBirth: string;
  appointmentDate: string;
  appointmentTime: string;
  physician: string;
  conversationId?: string;
};

export type BookAppointmentResult = {
  appointment: AppointmentRecord;
  duplicate: boolean;
};

const PAST_GRACE_MS = 5 * 60 * 1000;

export async function confirmBooking(
  db: AppDatabase,
  config: AppConfig,
  scheduler: SchedulingService,
  input: BookAppointmentInput,
  now: Date,
): Promise<BookAppointmentResult> {
  if (!config.demoMode && input.physician !== config.physicianName) {
    throw new BookingError("invalid_request", 400);
  }
  const startsAt = parseClinicInstant(
    input.appointmentDate,
    input.appointmentTime,
    config.timeZone,
  );
  if (!startsAt) throw new BookingError("invalid_time", 400);
  if (startsAt.getTime() < now.getTime() - PAST_GRACE_MS) {
    throw new BookingError("date_in_past", 400);
  }

  const verified = verifyPatient(
    db,
    config.recipientDataKey,
    input.patientReference,
    input.dateOfBirth,
  );
  const patient = verified ?? (config.demoMode
    ? {
        reference: input.patientReference,
        smsAuthorized: Boolean(config.demoAuthorizedSmsE164),
        smsE164: config.demoAuthorizedSmsE164 || null,
      }
    : null);
  if (!patient) throw new BookingError("patient_not_verified", 403);

  const startsAtIso = startsAt.toISOString();
  const existing = findAppointmentBySlot(
    db,
    patient.reference,
    input.physician,
    startsAtIso,
  );
  if (existing) return { appointment: existing, duplicate: true };

  let scheduled;
  try {
    scheduled = await scheduler.book({
      patientReference: patient.reference,
      physician: input.physician,
      startsAt,
      timeZone: config.timeZone,
    });
  } catch (error) {
    if (error instanceof SchedulingError) {
      throw new BookingError("booking_failed", 502);
    }
    throw error;
  }

  const createdAt = now.toISOString();
  const appointment: AppointmentRecord = {
    appointmentId: scheduled.appointmentId,
    schedulingProvider: scheduled.provider,
    demo: scheduled.demo,
    conversationId: input.conversationId ?? null,
    patientReference: patient.reference,
    physician: input.physician,
    startsAt: startsAtIso,
    timezone: config.timeZone,
    status: "confirmed",
    createdAt,
  };

  try {
    insertConfirmedBooking(db, {
      appointment,
      conversationId: input.conversationId ?? null,
      email: { recipientRef: "admin" },
      sms:
        patient.smsAuthorized && patient.smsE164
          ? {
              recipientRef: `patient:${patient.reference}`,
              recipientCiphertext: encryptString(
                config.recipientDataKey,
                patient.smsE164,
              ),
            }
          : undefined,
      maxAttempts: config.notificationMaxAttempts,
    });
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    const raced = findAppointmentBySlot(
      db,
      patient.reference,
      input.physician,
      startsAtIso,
    );
    if (raced) return { appointment: raced, duplicate: true };
    throw error;
  }

  return { appointment, duplicate: false };
}
