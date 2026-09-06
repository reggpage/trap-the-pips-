# Phase 10 pilot go/no-go — St. Ritha

No launch approval may be inferred from a successful build or deployment. The
pilot is **GO** only when every P0 gate below has evidence from the deployed
version.

## P0 gates

| Gate | Acceptance threshold | Evidence required | Current state |
|---|---|---|---|
| No silent messages | 0 messages left pending/processing over 15 minutes | Watchdog window and queue reconciliation | Monitoring code deployed; schedule pending |
| AI routing | 100% of ordinary words/sentences enter AI-first routing; deterministic handling only for an active protected choice | Golden tests plus live telemetry route/runtime | Automated tests pass; post-v313 live turn pending |
| Grounding | 0 invented products, prices, quantities, units, parties or balances | RAG/tool diagnostics and reviewed pilot corrections | Backend boundaries exist; live pilot review pending |
| Financial integrity | 0 duplicate ledger/stock effects; 100% arithmetic and permissions validated by backend | Isolated SQL rollback proof and replay tests | Rollback proof passed on production on 6 September 2026 |
| Worker authority | Worker can create and confirm their own permitted records without boss confirmation; cannot confirm another actor's or cross-company draft | Permission assertions | Passed in isolated rollback proof |
| Observability | Every new AI turn records runtime, failure layer, retrieval, state and tool outcome without raw merchant data | Admin AI Operations | Deployed; post-v313 live turn pending |
| Availability | Unsigned webhook probe reaches signature gate; no boot error | HTTP 401 probe | Passed on version 313 |
| Performance | At least 95% of AI turns under 15 seconds during pilot; investigate hourly P95 at or above 15 seconds | AI telemetry | Threshold deployed; sample window pending |
| Recovery | Duplicate delivery, uncertain write and queue recovery preserve idempotency | Automated and database drills | Duplicate confirmation proof passed; true concurrent retry drill pending |
| Restore | A non-production backup restores and migrations/rollback are rehearsed | Timestamped restore evidence | Not done |

## P1 launch targets

- AI answered/drafted success rate of at least 95% across reviewed pilot turns.
- Provider/model failures below 3 per hour.
- RAG unavailable events below 2 per hour.
- Tool/backend failures below 2 per hour.
- Proactive notification failures below 3 per hour.
- Every failure correction added to the reviewed golden dataset before release;
  live conversations do not train the model automatically.

## Decision rule

- Any failed P0 gate is **NO-GO**.
- A P1 miss may enter a time-boxed pilot only with an owner, mitigation and
  expiry date.
- Current decision: **NO-GO for public launch**. The controlled St. Ritha pilot
  may continue while the alert recipient/schedule, live v313 telemetry proof,
  concurrent recovery drill and non-production restore drill are completed.
