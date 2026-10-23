CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS patients (
  reference TEXT PRIMARY KEY,
  date_of_birth TEXT NOT NULL,
  sms_authorized INTEGER NOT NULL CHECK (sms_authorized IN (0, 1)),
  sms_ciphertext TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
  appointment_id TEXT PRIMARY KEY,
  scheduling_provider TEXT NOT NULL,
  demo INTEGER NOT NULL CHECK (demo IN (0, 1)),
  conversation_id TEXT,
  patient_reference TEXT NOT NULL,
  physician TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS appointments_slot
  ON appointments (patient_reference, physician, starts_at);

CREATE TABLE IF NOT EXISTS notification_jobs (
  id TEXT PRIMARY KEY,
  appointment_id TEXT NOT NULL,
  conversation_id TEXT,
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  recipient_ciphertext TEXT,
  provider_message_id TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL,
  next_attempt_at TEXT,
  locked_until TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (appointment_id, event_type, channel),
  FOREIGN KEY (appointment_id) REFERENCES appointments (appointment_id)
);

CREATE INDEX IF NOT EXISTS notification_jobs_due
  ON notification_jobs (status, next_attempt_at);

CREATE TABLE IF NOT EXISTS provider_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  conversation_id TEXT,
  event_type TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, event_id)
);
