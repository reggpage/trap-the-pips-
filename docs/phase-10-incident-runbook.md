# Phase 10 incident runbook

## Purpose

This runbook turns AI telemetry into an operational response. It never requires
reading merchant message text, phone numbers, product names, parties or money
figures. Start from **AI Operations** in the separate RISIP admin console.

## Severity and ownership

- **DOWN** means users may receive no answer, unsafe writes may be blocked, or
  a core dependency cannot be trusted. The platform owner responds immediately.
- **WARNING** means a sustained pattern crossed a pilot threshold. The named
  owner investigates before the pattern becomes an outage.
- `OPS_INCIDENT_OWNER` is the default owner. `OPS_AI_OWNER` and
  `OPS_BILLING_OWNER` may override it for specialised incidents.

## Alert codes

| Code | Meaning | First response | Rollback trigger |
|---|---|---|---|
| `webhook_unhealthy` / `webhook_unreachable` | WhatsApp front door did not reach its signature gate | Check Edge Function status and logs | Roll back when the new function version is the first failing version |
| `message_stuck` | A received message has not completed in 15 minutes | Check queue ownership and the abandoned-message sweep | Roll back if new code continuously leaves processing rows |
| `message_failure_burst` | Three or more failed messages in one hour | Group failures by runtime and code | Roll back when failures cluster on the current runtime |
| `ai_provider_failure_burst` | Model/provider failures crossed the hourly threshold | Check provider status, model name and credit | Switch to the tested fallback or restore the last known-good runtime |
| `rag_failure_burst` | Live catalogue retrieval is unavailable repeatedly | Check database/RAG availability; keep ungrounded writes blocked | Roll back a retrieval release that caused the change |
| `tool_backend_failure_burst` | Tool schema, execution, backend validation or database failures repeated | Inspect bounded tool failure codes | Roll back if the current schema/runtime introduced them |
| `conversation_state_failure_burst` | Active-question or expected-answer state is failing repeatedly | Inspect state transitions and expiry | Roll back a state migration/runtime regression |
| `ai_budget_exhausted` | AI calls are being blocked by budget | Check provider credit and RISIP limits | No code rollback unless a limit calculation is wrong |
| `runtime_deployment_failure` | A deployed runtime could not safely execute | Compare runtime versions immediately | Roll back to the last known-good version |
| `ai_latency_high` | Hourly AI P95 is at least 15 seconds with five or more samples | Separate provider time from tool/database time | Roll back if only the current runtime is slow |
| `notification_failure_burst` | Three or more proactive notifications failed in one hour | Check retries, Meta templates and provider status | Roll back a notification release that caused the failures |

## Safe response order

1. Record the alert code, first timestamp, runtime version and owner.
2. Confirm whether the problem is still active; do not retry financial writes
   blindly after an uncertain response.
3. Use the admin console diagnostic trail to identify the layer. Do not copy
   raw merchant messages into incident notes.
4. If a deployment caused the incident, restore the last known-good Edge
   Function version, then run the unsigned webhook boot probe.
5. Reconcile pending/processing messages and notification retries using their
   idempotency keys. Never create a second sale, purchase, payment or stock
   effect as a recovery shortcut.
6. Close the incident only when fresh turns succeed and the failure rate is
   below threshold for a full observation window.

## Current operational dependency

`ops-watch` is deployed, but email delivery remains disabled until an explicit
`OPS_ALERT_EMAIL` recipient is configured and the watch schedule is installed.
The endpoint must remain protected by `OPS_WATCH_SECRET`.
