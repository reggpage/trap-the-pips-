# Phase 10 launch readiness — 6 September 2026

## Scope boundary

Phase 10 hardens the product already built. It does not redesign accounting or
put platform operations inside a merchant dashboard. Operational diagnostics
belong to the separate `risip-admin-console` Site.

## Checkpoint 1 — AI operations observability

Implemented:

- Every new AI turn records a bounded root-cause layer: input, model, tool
  schema, tool execution, backend validation, provider, grounding, retrieval,
  state, budget, database, deployment, unknown, or none.
- Retrieval is recorded as available, partial, unavailable, or not run.
- Conversation context records only none, bounded history, or active question.
- Tool status records only none, success, error, or unknown, with a bounded
  operational code.
- The semantic WhatsApp runtime release is recorded so old and new deployments
  can be separated in the admin console.
- The existing platform-admin RPC exposes aggregate failure layers, retrieval
  health, runtime versions and recent diagnostic metadata.
- No merchant message text, product, party, phone, price, total or balance is
  copied to operations telemetry.
- The existing AI Operations page in `risip-admin-console` shows success rate,
  root-cause cards, RAG health, runtime versions and a recent diagnostic trail.

Verified before production:

- Migration applied successfully inside a transaction and rolled back.
- Complete Risip suite: 178 files / 2,599 tests passed.
- Risip typecheck, production build and 20 Edge Function checks passed.
- Admin console typecheck, 4 tests and production build passed.

## Remaining Phase 10 gates

- Production migration `20260906100000` is applied and recorded; WhatsApp
  webhook version 313 is active.
- Admin console Site version 12 is published at `admin.risip.online`.
- Send controlled live WhatsApp probes and confirm new telemetry appears under
  the correct runtime version without ledger side effects.
- Alert thresholds and incident ownership now cover sustained provider, RAG,
  tool/database, state, latency, notification queue, deployment and budget
  failures. The function must still be scheduled and its alert recipient must
  be explicitly configured before this gate is operational.
- Run duplicate-delivery, retry-after-uncertain-write and queue recovery drills.
- Complete the launch role/permission evidence matrix across web and WhatsApp.
- Run backup/restore and migration rollback drills in a non-production clone.
- Establish pilot acceptance thresholds and a go/no-go checklist for St. Ritha.

This checkpoint is not launch approval. Phase 10 is complete only after the
remaining production drills have evidence and every accepted limitation is
recorded.
