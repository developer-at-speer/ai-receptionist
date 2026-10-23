import { randomUUID } from "node:crypto";
import type { SqlValue } from "sql.js";
import type { AppDatabase } from "../db/database.js";
import { isUniqueConstraint } from "../errors.js";

export type AppointmentRecord = {
  appointmentId: string;
  schedulingProvider: string;
  demo: boolean;
  conversationId: string | null;
  patientReference: string;
  physician: string;
  startsAt: string;
  timezone: string;
  status: string;
  createdAt: string;
};

export type NotificationJob = {
  id: string;
  appointmentId: string;
  conversationId: string | null;
  eventType: string;
  channel: "email" | "sms";
  status: string;
  recipientRef: string;
  recipientCiphertext: string | null;
  providerMessageId: string | null;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lockedUntil: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

type Row = Record<string, SqlValue>;

function text(row: Row, key: string): string {
  const value = row[key];
  return typeof value === "string" ? value : "";
}

function nullable(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return String(value);
}

function integer(row: Row, key: string): number {
  const value = row[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function mapAppointment(row: Row): AppointmentRecord {
  return {
    appointmentId: text(row, "appointment_id"),
    schedulingProvider: text(row, "scheduling_provider"),
    demo: integer(row, "demo") === 1,
    conversationId: nullable(row, "conversation_id"),
    patientReference: text(row, "patient_reference"),
    physician: text(row, "physician"),
    startsAt: text(row, "starts_at"),
    timezone: text(row, "timezone"),
    status: text(row, "status"),
    createdAt: text(row, "created_at"),
  };
}

function mapJob(row: Row): NotificationJob {
  const channel = text(row, "channel");
  if (channel !== "email" && channel !== "sms") {
    throw new Error("unknown notification channel");
  }
  return {
    id: text(row, "id"),
    appointmentId: text(row, "appointment_id"),
    conversationId: nullable(row, "conversation_id"),
    eventType: text(row, "event_type"),
    channel,
    status: text(row, "status"),
    recipientRef: text(row, "recipient_ref"),
    recipientCiphertext: nullable(row, "recipient_ciphertext"),
    providerMessageId: nullable(row, "provider_message_id"),
    attemptCount: integer(row, "attempt_count"),
    maxAttempts: integer(row, "max_attempts"),
    nextAttemptAt: nullable(row, "next_attempt_at"),
    lockedUntil: nullable(row, "locked_until"),
    lastErrorCode: nullable(row, "last_error_code"),
    createdAt: text(row, "created_at"),
    updatedAt: text(row, "updated_at"),
  };
}

export function findAppointmentBySlot(
  db: AppDatabase,
  patientReference: string,
  physician: string,
  startsAt: string,
): AppointmentRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM appointments
       WHERE patient_reference = ? AND physician = ? AND starts_at = ?`,
    )
    .get(patientReference, physician, startsAt);
  return row ? mapAppointment(row) : null;
}

export function findAppointment(
  db: AppDatabase,
  appointmentId: string,
): AppointmentRecord | null {
  const row = db
    .prepare("SELECT * FROM appointments WHERE appointment_id = ?")
    .get(appointmentId);
  return row ? mapAppointment(row) : null;
}

export function insertConfirmedBooking(
  db: AppDatabase,
  input: {
    appointment: AppointmentRecord;
    conversationId: string | null;
    email: { recipientRef: string };
    sms?: { recipientRef: string; recipientCiphertext: string };
    maxAttempts: number;
  },
): void {
  const now = input.appointment.createdAt;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO appointments (
        appointment_id, scheduling_provider, demo, conversation_id,
        patient_reference, physician, starts_at, timezone, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.appointment.appointmentId,
      input.appointment.schedulingProvider,
      input.appointment.demo ? 1 : 0,
      input.appointment.conversationId,
      input.appointment.patientReference,
      input.appointment.physician,
      input.appointment.startsAt,
      input.appointment.timezone,
      input.appointment.status,
      input.appointment.createdAt,
    );
    insertJob(db, {
      appointmentId: input.appointment.appointmentId,
      conversationId: input.conversationId,
      channel: "email",
      recipientRef: input.email.recipientRef,
      recipientCiphertext: null,
      maxAttempts: input.maxAttempts,
      now,
    });
    if (input.sms) {
      insertJob(db, {
        appointmentId: input.appointment.appointmentId,
        conversationId: input.conversationId,
        channel: "sms",
        recipientRef: input.sms.recipientRef,
        recipientCiphertext: input.sms.recipientCiphertext,
        maxAttempts: input.maxAttempts,
        now,
      });
    }
  })();
}

function insertJob(
  db: AppDatabase,
  input: {
    appointmentId: string;
    conversationId: string | null;
    channel: "email" | "sms";
    recipientRef: string;
    recipientCiphertext: string | null;
    maxAttempts: number;
    now: string;
  },
): void {
  db.prepare(
    `INSERT INTO notification_jobs (
      id, appointment_id, conversation_id, event_type, channel, status,
      recipient_ref, recipient_ciphertext, attempt_count, max_attempts,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'appointment_confirmed', ?, 'pending', ?, ?, 0, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.appointmentId,
    input.conversationId,
    input.channel,
    input.recipientRef,
    input.recipientCiphertext,
    input.maxAttempts,
    input.now,
    input.now,
  );
}

export function listJobs(
  db: AppDatabase,
  appointmentId: string,
): NotificationJob[] {
  return db
    .prepare(
      `SELECT * FROM notification_jobs
       WHERE appointment_id = ?
       ORDER BY rowid`,
    )
    .all(appointmentId)
    .map(mapJob);
}

export function countJobs(db: AppDatabase): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM notification_jobs")
    .get();
  return integer(row ?? {}, "count");
}

export function countAppointments(db: AppDatabase): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM appointments").get();
  return integer(row ?? {}, "count");
}

export function recoverExpiredLeases(db: AppDatabase, now: Date): void {
  const nowIso = now.toISOString();
  db.prepare(
    `UPDATE notification_jobs
     SET status = CASE WHEN attempt_count > 0 THEN 'retry' ELSE 'pending' END,
         locked_until = NULL,
         updated_at = ?
     WHERE status = 'processing' AND locked_until IS NOT NULL AND locked_until <= ?`,
  ).run(nowIso, nowIso);
}

export function claimNext(
  db: AppDatabase,
  now: Date,
  leaseMs: number,
): NotificationJob | null {
  const nowIso = now.toISOString();
  const lockedUntil = new Date(now.getTime() + leaseMs).toISOString();
  return db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id FROM notification_jobs
         WHERE status IN ('pending', 'retry')
           AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY rowid
         LIMIT 1`,
      )
      .get(nowIso);
    if (!row) return null;
    const id = text(row, "id");
    const updated = db
      .prepare(
        `UPDATE notification_jobs
         SET status = 'processing', locked_until = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'retry')`,
      )
      .run(lockedUntil, nowIso, id);
    if (updated.changes !== 1) return null;
    const claimed = db
      .prepare("SELECT * FROM notification_jobs WHERE id = ?")
      .get(id);
    return claimed ? mapJob(claimed) : null;
  })();
}

export function markAttempt(
  db: AppDatabase,
  id: string,
  attemptCount: number,
  now: Date,
): void {
  db.prepare(
    `UPDATE notification_jobs
     SET attempt_count = ?, updated_at = ?
     WHERE id = ?`,
  ).run(attemptCount, now.toISOString(), id);
}

export function markAccepted(
  db: AppDatabase,
  id: string,
  status: string,
  providerMessageId: string,
  now: Date,
): void {
  db.prepare(
    `UPDATE notification_jobs
     SET status = ?, provider_message_id = ?, locked_until = NULL,
         last_error_code = NULL, next_attempt_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(status, providerMessageId, now.toISOString(), id);
}

export function markRetry(
  db: AppDatabase,
  id: string,
  errorCode: string,
  nextAttemptAt: Date,
  now: Date,
): void {
  db.prepare(
    `UPDATE notification_jobs
     SET status = 'retry', last_error_code = ?, next_attempt_at = ?,
         locked_until = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(errorCode, nextAttemptAt.toISOString(), now.toISOString(), id);
}

export function markFailed(
  db: AppDatabase,
  id: string,
  errorCode: string,
  now: Date,
): void {
  db.prepare(
    `UPDATE notification_jobs
     SET status = 'failed', last_error_code = ?, next_attempt_at = NULL,
         locked_until = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(errorCode, now.toISOString(), id);
}

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  retry: 0,
  processing: 1,
  accepted: 2,
  queued: 2,
  sending: 3,
  sent: 4,
  delivered: 5,
  undelivered: 5,
  failed: 5,
};

export function applyProviderStatus(
  db: AppDatabase,
  providerMessageId: string,
  status: string,
  errorCode: string | null,
  now: Date,
): boolean {
  const row = db
    .prepare(
      `SELECT * FROM notification_jobs WHERE provider_message_id = ? AND channel = 'sms'`,
    )
    .get(providerMessageId);
  if (!row) return false;
  const job = mapJob(row);
  const terminal = new Set(["delivered", "undelivered", "failed"]);
  if (terminal.has(job.status)) return true;
  if ((STATUS_RANK[status] ?? -1) < (STATUS_RANK[job.status] ?? 0)) return true;
  db.prepare(
    `UPDATE notification_jobs
     SET status = ?, last_error_code = COALESCE(?, last_error_code), updated_at = ?
     WHERE id = ?`,
  ).run(status, errorCode, now.toISOString(), job.id);
  return true;
}

export function recordProviderEvent(
  db: AppDatabase,
  event: {
    provider: string;
    eventId: string;
    conversationId: string | null;
    eventType: string;
    receivedAt: string;
  },
): boolean {
  try {
    db.prepare(
      `INSERT INTO provider_events (
        provider, event_id, conversation_id, event_type, received_at
      ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      event.provider,
      event.eventId,
      event.conversationId,
      event.eventType,
      event.receivedAt,
    );
    return true;
  } catch (error) {
    if (isUniqueConstraint(error)) return false;
    throw error;
  }
}

export function countProviderEvents(db: AppDatabase): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM provider_events")
    .get();
  return integer(row ?? {}, "count");
}
