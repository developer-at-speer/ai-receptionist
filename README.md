# AI receptionist notifications

This service accepts an appointment request from the existing ElevenLabs receptionist, confirms it with the scheduling adapter, and then sends notifications. Demo mode uses a mock scheduler. A demo booking is synthetic and is not a Juno EMR appointment.

Notifications are sent only after this backend commits the appointment. The voice agent cannot trigger email or SMS by saying that a booking succeeded.

## What is real, mocked, or blocked

| Piece | State |
| --- | --- |
| ElevenLabs agent, inbound SMS webhook, and +12622394630 | Already yours. This service does not change them. |
| `book_appointment` webhook, validation, and bearer authentication | Real |
| Scheduling | Mock while `DEMO_MODE=true`. Appointment IDs start with `demo-`. |
| Juno EMR | Blocked. `DEMO_MODE=false` refuses the booking instead of inventing a Juno appointment. |
| Admin email through Resend | Real only when `ALLOW_LIVE_SENDS=true` and Resend is configured |
| Patient SMS through Twilio | Real only when `ALLOW_LIVE_SENDS=true`, Twilio is configured, and the patient record has an authorized mobile number |
| Automated tests | Never call Resend or Twilio |

Caller ID is ignored. SMS goes only to the mobile number stored for a patient who has authorized appointment reminders.

The admin email contains the booking reference, date, time, physician, and confirmation status. It does not contain the patient name, phone number, or visit reason.

## Setup

From this directory:

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put that value in `RECIPIENT_DATA_KEY`. Choose long random values for `BOOKING_WEBHOOK_SECRET` and `ELEVENLABS_WEBHOOK_SECRET`.

### Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `BOOKING_WEBHOOK_SECRET` | Yes | Bearer token for the booking webhook. At least 16 characters. |
| `ELEVENLABS_WEBHOOK_SECRET` | Yes | HMAC secret from the ElevenLabs post-call webhook. |
| `RECIPIENT_DATA_KEY` | Yes | 32-byte base64 key for the authorized mobile number. |
| `APP_BASE_URL` | Yes for live SMS status | Public `https` origin with no trailing slash. |
| `DATABASE_URL` | No | Defaults to `file:./data/receptionist.db`. |
| `DEMO_MODE` | No | Defaults to `true`. |
| `ADMIN_EMAIL` | No | Defaults to `mathew@speer.io`. |
| `RESEND_API_KEY` | For live email | Resend API key. |
| `EMAIL_FROM` | For live email | Verified sender, for example `Dr. Shah's Family Practice <receptionist@your-domain>`. |
| `TWILIO_ACCOUNT_SID` | For live SMS | Twilio account SID. |
| `TWILIO_AUTH_TOKEN` | For live SMS | Used to send and to validate status callbacks. |
| `TWILIO_PHONE_NUMBER` | For live SMS | Sender for booking confirmations. Use `+12622394630`. |
| `TWILIO_MESSAGING_SERVICE_SID` | No | Not used for booking SMS. Leave it empty so the sender stays +12622394630. |
| `DEMO_PATIENT_REFERENCE` | For the demo caller | Default `demo-patient-001`. |
| `DEMO_PATIENT_DOB` | For the demo caller | Default `1980-01-15`. |
| `DEMO_AUTHORIZED_SMS_E164` | For a real test SMS | Your own mobile number. This is the only SMS destination. |
| `ALLOW_LIVE_SENDS` | For real delivery | Must be the string `true`. |
| `JUNO_BASE_URL`, `JUNO_API_TOKEN` | Later | Stored for a future adapter. They do not create appointments today. |
| `PETAL_API_URL` | For Petal cards | Origin of Petal Answers, with no path. Example `http://127.0.0.1:41741`. |
| `PETAL_BOOKING_SECRET` | For Petal cards | Bearer secret shared with Petal Answers. At least 16 characters. |
| `PETAL_CLINIC_NAME` | For Petal cards | Exact Petal clinic name. Default practice in the local board is `Harbourview Family Practice`. |

Keep every secret in `.env` or the host environment. Do not put Twilio, Resend, or webhook secrets in the ElevenLabs prompt.

## Run

```bash
npm install
npm start
```

`GET /health` reports `demoMode`, `schedulingProvider`, whether live sends are enabled, and whether Petal card upload is configured.

When `PETAL_API_URL` and `PETAL_BOOKING_SECRET` are set, a confirmed booking uploads a card to the Booked column in Petal Answers. The card includes the physician, date, time, booking reference, patient reference, and whether the visit is a demo. It does not include the date of birth, phone number, or visit reason. Repeating the same booking updates nothing and does not create a second card.

```bash
npm test
```

## Send a real test email and SMS

Use a phone you control. Do not use a patient number.

1. Set `DEMO_AUTHORIZED_SMS_E164` to your mobile number.
2. Set `RESEND_API_KEY`, `EMAIL_FROM`, and the Twilio variables.
3. Set `ALLOW_LIVE_SENDS=true`.
4. Start the server with `npm start`.
5. In another terminal, from this directory, run `npm run demo:book`.

The script books a fictional visit for `demo-patient-001`, date of birth `1980-01-15`, with Dr. Shah. It sends a different caller-ID number on purpose. The SMS still goes to `DEMO_AUTHORIZED_SMS_E164`. The email goes to `ADMIN_EMAIL`. Both say the booking is a demo and not a Juno appointment.

If `ALLOW_LIVE_SENDS` is not `true`, the appointment is stored and the notification jobs stay `pending`. Restart after setting it to `true`; the worker sends the pending jobs. A failed email or SMS does not book the appointment again.

For Twilio's status callback, `APP_BASE_URL` must be a public HTTPS origin. A tunnel such as Cloudflare Tunnel or ngrok can forward that origin to port 3000. The message is still sent without the tunnel; delivery status stays `queued` until Twilio can reach the callback.

## ElevenLabs `book_appointment` tool

Paste this URL into the existing agent's webhook tool:

`{APP_BASE_URL}/api/appointments/book`

For local testing before you have a public host, that is `http://127.0.0.1:3000/api/appointments/book`. ElevenLabs cloud cannot reach a localhost URL; use your public `APP_BASE_URL` for a live call.

Add the tool on the existing agent. Do not create a second agent, do not add a tool that sends SMS or email, and do not change the inbound SMS webhook for +12622394630. ElevenLabs should keep handling texts sent to that number. This backend sends the one booking confirmation with a per-message status callback, which does not replace that inbound webhook.

- Name: `book_appointment`
- Description: `Book a clinic appointment after the caller gives patient_reference and date_of_birth. Read the message field to the caller. Obey agent_instruction and do not send your own confirmation text or email.`
- Method: `POST`
- URL: `{APP_BASE_URL}/api/appointments/book`
- Header name: `Authorization`
- Header value: `Bearer {BOOKING_WEBHOOK_SECRET}`

Parameters:

| Name | Type | Required | Notes |
| --- | --- | --- | --- |
| `patient_reference` | string | Yes | Demo value `demo-patient-001`. |
| `date_of_birth` | string | Yes | `YYYY-MM-DD`. Demo value `1980-01-15`. |
| `appointment_date` | string | Yes | `YYYY-MM-DD` in America/Toronto. |
| `appointment_time` | string | Yes | `HH:MM` in America/Toronto. |
| `physician` | string | Yes | `Dr. Shah` |
| `conversation_id` | string | No | Dynamic value `{{system__conversation_id}}` when available. |
| `caller_phone` | string | No | Optional dynamic value `{{system__caller_id}}`. It is not used for SMS. |
| `reason` | string | No | Ignored. It is not stored or emailed. |

The tool result includes `message` and `agent_instruction`. Read `message` to the caller. Follow `agent_instruction` by not sending a separate confirmation. In demo mode `message` says the booking is synthetic and is not in Juno. `appointment_id` is the booking reference. A non-200 response means the appointment was not booked.

Calling the same slot again, including through `/webhooks/elevenlabs/book-appointment`, returns the original appointment and does not create a second email or SMS.

## Optional post-call webhook

This does not send confirmations. It records that a signed call-completion event arrived and ignores repeats.

In ElevenLabs agent settings, set the post-call transcription webhook to:

`{APP_BASE_URL}/webhooks/elevenlabs/post-call`

Use the webhook secret as `ELEVENLABS_WEBHOOK_SECRET`. The handler checks the `ElevenLabs-Signature` header with `elevenlabs.webhooks.constructEvent` from `@elevenlabs/elevenlabs-js` and the raw request body.

## Twilio status callback

Booking texts are sent `From +12622394630`. Each outbound message sets `StatusCallback` to:

`{APP_BASE_URL}/webhooks/twilio/status`

Twilio signs that exact URL. The handler checks `X-Twilio-Signature` with the Twilio auth token and stores `queued`, `sent`, `delivered`, `undelivered`, and `failed`. An accepted Messages API response is stored as `queued` or `sent`, not as delivered.

No extra Twilio console webhook is required when the per-message callback is used. The public URL must match `APP_BASE_URL`.

## Duplicate suppression and retries

The database stores one notification per appointment, event type, and channel. The same slot for the same patient returns the original appointment and does not create another email or SMS. Two different times in one call create two appointments and two pairs of notifications.

Provider requests use the notification job ID as an idempotency key. Temporary email and SMS failures stay on the confirmed appointment and are retried with backoff, up to `NOTIFICATION_MAX_ATTEMPTS`. Invalid numbers and other permanent provider errors stop retrying. Restarting the process resumes pending work, including jobs left in progress after a crash.

## Privacy

Demo data is the only patient record this service should hold until the clinic approves the privacy and security setup. The SQLite file stores the demo date of birth and the encrypted authorized mobile number so the booking can be verified and the SMS can be retried. Delete `data/receptionist.db` to remove that demo data. Logs contain appointment IDs, channels, and error codes, not phone numbers, dates of birth, or transcripts.

A retention period is not enforced yet. Keep the database on the clinic's server and restrict access to it. Do not load a real patient roster into `patients` until that review is done.

## Juno later

`src/scheduling/junoSchedulingService.ts` is the adapter boundary. A future change can implement `book()` there and return Juno's appointment ID. Turn `DEMO_MODE` off only after that adapter returns a real committed ID. Until then, turning demo mode off fails the booking and sends nothing.
