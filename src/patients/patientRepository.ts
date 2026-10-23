import { decryptString, safeEqual } from "../crypto/recipientCipher.js";
import type { AppDatabase } from "../db/database.js";

export type VerifiedPatient = {
  reference: string;
  smsAuthorized: boolean;
  smsE164: string | null;
};

export function savePatient(
  db: AppDatabase,
  patient: {
    reference: string;
    dateOfBirth: string;
    smsAuthorized: boolean;
    smsCiphertext: string | null;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO patients (
      reference, date_of_birth, sms_authorized, sms_ciphertext, created_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(reference) DO UPDATE SET
      date_of_birth = excluded.date_of_birth,
      sms_authorized = excluded.sms_authorized,
      sms_ciphertext = excluded.sms_ciphertext`,
  ).run(
    patient.reference,
    patient.dateOfBirth,
    patient.smsAuthorized ? 1 : 0,
    patient.smsCiphertext,
    patient.createdAt,
  );
}

export function verifyPatient(
  db: AppDatabase,
  key: Buffer,
  reference: string,
  dateOfBirth: string,
): VerifiedPatient | null {
  const row = db
    .prepare(
      `SELECT reference, date_of_birth, sms_authorized, sms_ciphertext
       FROM patients WHERE reference = ?`,
    )
    .get(reference);
  if (!row || typeof row.date_of_birth !== "string") return null;
  if (!safeEqual(row.date_of_birth, dateOfBirth)) return null;

  const authorized = Number(row.sms_authorized) === 1;
  if (!authorized || typeof row.sms_ciphertext !== "string") {
    return { reference, smsAuthorized: false, smsE164: null };
  }
  try {
    return {
      reference,
      smsAuthorized: true,
      smsE164: decryptString(key, row.sms_ciphertext),
    };
  } catch {
    return { reference, smsAuthorized: false, smsE164: null };
  }
}
