// THE THING THAT TELLS YOU TO LOOK.
//
// The admin console already shows failures, stale work, latency, cost and
// per-company limits, and it shows them well. What it cannot do is reach you.
// It is a page you have to open, and the one time this service went down
// completely, the owner found it himself — after every message had been
// failing for a while.
//
// MEASURED, over the first 711 messages: ten died as
// worker_ended_before_completion with nobody told, and one full outage was
// found by the shopkeeper rather than by us.
//
// EMAIL, not WhatsApp, and that is deliberate. A business-initiated WhatsApp
// message needs an approved template and a 24-hour window; an alarm that fires
// at two in the morning would find that window shut. Email has no window.
//
// Two modes, one function:
//   ?mode=watch   every few minutes  -> writes nothing unless something is wrong
//   ?mode=digest  once a day         -> the numbers, whether or not they are bad
//
// It reads only counts and codes. No message text, no phone numbers, no
// customer names, no amounts.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

type Finding = {
  severity: 'down' | 'warn';
  code: string;
  owner: string;
  title: string;
  detail: string;
};

const WINDOW_MINUTES = 60;
const THRESHOLDS = {
  messageFailures: 3,
  providerFailures: 3,
  retrievalFailures: 2,
  toolOrDatabaseFailures: 2,
  stateFailures: 3,
  notificationFailures: 3,
  budgetFailures: 1,
  deploymentFailures: 1,
  p95LatencyMs: 15_000,
  minimumLatencySamples: 5,
} as const;

function owner(area: 'platform' | 'ai' | 'billing'): string {
  const fallback = Deno.env.get('OPS_INCIDENT_OWNER') ?? 'RISIP platform owner';
  if (area === 'ai') return Deno.env.get('OPS_AI_OWNER') ?? fallback;
  if (area === 'billing') return Deno.env.get('OPS_BILLING_OWNER') ?? fallback;
  return fallback;
}

function finding(
  severity: Finding['severity'],
  code: string,
  area: 'platform' | 'ai' | 'billing',
  title: string,
  detail: string,
): Finding {
  return { severity, code, owner: owner(area), title, detail };
}

function admin() {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('supabase env not set');
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Is the front door answering?
 *
 * An unsigned POST must come back 401. That single fact proves the module
 * parsed, booted, and reached its signature check — which is exactly what a
 * BOOT_ERROR breaks. A 503 here is the outage nobody noticed last time.
 */
async function probeWebhook(): Promise<Finding | null> {
  const base = Deno.env.get('SUPABASE_URL');
  if (!base) return null;
  const url = `${base}/functions/v1/whatsapp-webhook`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (res.status === 401) return null;
    const body = (await res.text()).slice(0, 200);
    return finding(
      'down',
      'webhook_unhealthy',
      'platform',
      `WhatsApp webhook answered ${res.status}, expected 401`,
      body.includes('BOOT_ERROR')
        ? 'BOOT_ERROR — the function failed to parse. Every incoming message is being dropped right now.'
        : `Unexpected response: ${body}`,
    );
  } catch (err) {
    return finding(
      'down',
      'webhook_unreachable',
      'platform',
      'WhatsApp webhook did not answer',
      err instanceof Error ? err.message : 'no response within 10s',
    );
  }
}

const since = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

async function healthFindings(db: ReturnType<typeof admin>): Promise<Finding[]> {
  const found: Finding[] = [];

  // Work that started and never finished. This is the silent failure: the
  // shopkeeper typed and got nothing back.
  const { count: stuck } = await db.from('whatsapp_messages')
    .select('id', { count: 'exact', head: true })
    .in('status', ['pending', 'processing'])
    .lt('created_at', since(15));
  if ((stuck ?? 0) > 0) {
    found.push(finding(
      'down',
      'message_stuck',
      'platform',
      `${stuck} message${stuck === 1 ? '' : 's'} stuck for over 15 minutes`,
      'Someone typed and has not been answered. Check the WhatsApp ops page.',
    ));
  }

  // A burst of failures is different from the occasional one.
  const { count: failed } = await db.from('whatsapp_messages')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'failed')
    .gte('updated_at', since(60));
  if ((failed ?? 0) >= THRESHOLDS.messageFailures) {
    found.push(finding(
      'warn',
      'message_failure_burst',
      'platform',
      `${failed} messages failed in the last hour`,
      'Above the pilot threshold. Open WhatsApp ops and identify the first failing runtime.',
    ));
  }

  // Root-cause telemetry deliberately excludes message text and business data.
  // The watchdog needs the layer and latency only, never what the trader said.
  const { data: aiRows, error: aiError } = await db.from('whatsapp_ai_interpretations')
    .select('failure_layer, retrieval_status, tool_result_status, latency_ms')
    .gte('created_at', since(WINDOW_MINUTES))
    .limit(1000);

  if (aiError) {
    found.push(finding(
      'down',
      'ai_telemetry_query_failed',
      'platform',
      'AI health telemetry could not be read',
      'The watchdog cannot prove AI health. Check the Phase 10 migration and database availability.',
    ));
  } else {
    const rows = (aiRows ?? []) as Array<{
      failure_layer: string | null;
      retrieval_status: string | null;
      tool_result_status: string | null;
      latency_ms: number | null;
    }>;
    const countLayers = (layers: string[]) => rows.filter((row) =>
      row.failure_layer != null && layers.includes(row.failure_layer)).length;
    const providerFailed = countLayers(['provider', 'model']);
    const retrievalFailed = rows.filter((row) =>
      row.failure_layer === 'retrieval' || row.retrieval_status === 'unavailable').length;
    const toolOrDatabaseFailed = rows.filter((row) =>
      ['tool_schema', 'tool_execution', 'backend_validation', 'database'].includes(row.failure_layer ?? '')
      || row.tool_result_status === 'error').length;
    const stateFailed = countLayers(['state']);
    const budgetFailed = countLayers(['budget']);
    const deploymentFailed = countLayers(['deployment']);

    if (providerFailed >= THRESHOLDS.providerFailures) {
      found.push(finding(
        'warn',
        'ai_provider_failure_burst',
        'ai',
        `${providerFailed} AI model/provider failures in the last hour`,
        'Check provider status, account credit and the deployed model configuration.',
      ));
    }
    if (retrievalFailed >= THRESHOLDS.retrievalFailures) {
      found.push(finding(
        'warn',
        'rag_failure_burst',
        'ai',
        `${retrievalFailed} RAG/catalogue failures in the last hour`,
        'Check catalogue retrieval, aliases and database connectivity. Do not allow ungrounded answers.',
      ));
    }
    if (toolOrDatabaseFailed >= THRESHOLDS.toolOrDatabaseFailures) {
      found.push(finding(
        'down',
        'tool_backend_failure_burst',
        'platform',
        `${toolOrDatabaseFailed} tool/backend failures in the last hour`,
        'Inspect tool schemas and backend rejection codes before retrying writes.',
      ));
    }
    if (stateFailed >= THRESHOLDS.stateFailures) {
      found.push(finding(
        'warn',
        'conversation_state_failure_burst',
        'ai',
        `${stateFailed} conversation-state failures in the last hour`,
        'Inspect active-question expiry and expected-answer transitions in AI ops.',
      ));
    }
    if (budgetFailed >= THRESHOLDS.budgetFailures) {
      found.push(finding(
        'down',
        'ai_budget_exhausted',
        'billing',
        `${budgetFailed} AI request${budgetFailed === 1 ? '' : 's'} blocked by budget in the last hour`,
        'Check provider credit and RISIP usage limits before users lose AI access.',
      ));
    }
    if (deploymentFailed >= THRESHOLDS.deploymentFailures) {
      found.push(finding(
        'down',
        'runtime_deployment_failure',
        'platform',
        `${deploymentFailed} deployment/runtime failure${deploymentFailed === 1 ? '' : 's'} in the last hour`,
        'Compare the failing runtime version with the last known-good function version and roll back if needed.',
      ));
    }

    const latencies = rows.map((row) => row.latency_ms)
      .filter((value): value is number => Number.isFinite(value))
      .sort((a, b) => a - b);
    if (latencies.length >= THRESHOLDS.minimumLatencySamples) {
      const p95Index = Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1);
      const p95 = latencies[p95Index];
      if (p95 >= THRESHOLDS.p95LatencyMs) {
        found.push(finding(
          'warn',
          'ai_latency_high',
          'ai',
          `AI P95 latency is ${Math.round(p95 / 100) / 10}s in the last hour`,
          `Pilot threshold is ${THRESHOLDS.p95LatencyMs / 1000}s. Check provider latency, tool loops and database waits.`,
        ));
      }
    }
  }

  const { count: notificationFailed, error: notificationError } = await db
    .from('whatsapp_notification_deliveries')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'failed')
    .gte('updated_at', since(WINDOW_MINUTES));
  if (notificationError) {
    found.push(finding(
      'warn',
      'notification_queue_query_failed',
      'platform',
      'Notification queue health could not be read',
      'Check the proactive-notification migration and database availability.',
    ));
  } else if ((notificationFailed ?? 0) >= THRESHOLDS.notificationFailures) {
    found.push(finding(
      'warn',
      'notification_failure_burst',
      'platform',
      `${notificationFailed} proactive notifications failed in the last hour`,
      'Inspect delivery retries and Meta template/provider status.',
    ));
  }

  return found;
}

/** The numbers, once a day, whether or not anything is wrong. */
async function digestLines(db: ReturnType<typeof admin>): Promise<string[]> {
  const day = since(24 * 60);
  const week = since(7 * 24 * 60);

  const [messages, failed, aiTurns, records, companies, activeCompanies] = await Promise.all([
    db.from('whatsapp_messages').select('id', { count: 'exact', head: true })
      .gte('created_at', day),
    db.from('whatsapp_messages').select('id', { count: 'exact', head: true })
      .eq('status', 'failed').gte('updated_at', day),
    db.from('whatsapp_ai_interpretations').select('id', { count: 'exact', head: true })
      .gte('created_at', day),
    db.from('daily_records').select('id', { count: 'exact', head: true })
      .eq('status', 'confirmed').gte('created_at', day),
    db.from('companies').select('id', { count: 'exact', head: true }),
    db.from('whatsapp_messages').select('company_id').gte('created_at', week),
  ]);

  // A shop that linked a number and then went quiet is churn before it is
  // anything else. For a pilot this is the line worth reading first.
  const spokeThisWeek = new Set(
    ((activeCompanies.data ?? []) as Array<{ company_id: string | null }>)
      .map((row) => row.company_id).filter(Boolean),
  );
  const quiet = Math.max(0, (companies.count ?? 0) - spokeThisWeek.size);

  return [
    `Messages handled: ${messages.count ?? 0}`,
    `Messages failed: ${failed.count ?? 0}`,
    `AI turns: ${aiTurns.count ?? 0}`,
    `Records confirmed: ${records.count ?? 0}`,
    `Shops silent 7+ days: ${quiet} of ${companies.count ?? 0}`,
  ];
}

async function sendEmail(subject: string, body: string): Promise<boolean> {
  const apiKey = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('RESEND_FROM') ?? 'Risip <onboarding@resend.dev>';
  const to = Deno.env.get('OPS_ALERT_EMAIL');
  if (!apiKey || !to) {
    console.error('ops-watch: RESEND_API_KEY or OPS_ALERT_EMAIL not set');
    return false;
  }
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text: body }),
  });
  if (!res.ok) {
    console.error('ops-watch: resend rejected', res.status);
    return false;
  }
  return true;
}

Deno.serve(async (req) => {
  // Not a public endpoint. Cron cannot carry a JWT, so it carries a secret.
  const url = new URL(req.url);
  const expected = Deno.env.get('OPS_WATCH_SECRET') ?? '';
  const given = url.searchParams.get('secret') ?? req.headers.get('x-ops-secret') ?? '';
  if (!expected || given !== expected) {
    return new Response('forbidden', { status: 403 });
  }

  const mode = url.searchParams.get('mode') === 'digest' ? 'digest' : 'watch';
  let db: ReturnType<typeof admin>;
  try { db = admin(); } catch { return new Response('misconfigured', { status: 500 }); }

  if (mode === 'digest') {
    const lines = await digestLines(db);
    const findings = await healthFindings(db);
    const body = [
      'Risip — last 24 hours',
      '',
      ...lines,
      '',
      findings.length === 0
        ? 'Nothing needs attention right now.'
        : `Needs attention:\n${findings.map((f) => `- [${f.code}] ${f.title} — owner: ${f.owner}`).join('\n')}`,
    ].join('\n');
    const sent = await sendEmail('Risip — daily digest', body);
    return Response.json({ ok: true, mode, sent, findings: findings.length });
  }

  // Probed once. Calling it twice to build the array would double every alarm
  // and, on a slow day, time the function out on its own health check.
  const probe = await probeWebhook();
  const findings: Finding[] = [
    ...(probe ? [probe] : []),
    ...(await healthFindings(db)),
  ];

  // Silence when healthy. An alarm that fires every five minutes whether or not
  // anything is wrong is an alarm nobody reads by the end of the week.
  if (findings.length === 0) return Response.json({ ok: true, mode, findings: 0 });

  const worst = findings.some((f) => f.severity === 'down') ? 'DOWN' : 'WARNING';
  const body = [
    `Risip — ${worst}`,
    '',
    ...findings.map((f) => `[${f.code}] ${f.title}\n  Owner: ${f.owner}\n  ${f.detail}`),
    '',
    'Admin console: check WhatsApp ops and AI ops.',
  ].join('\n');
  const sent = await sendEmail(`Risip ${worst}: ${findings[0].title}`, body);
  return Response.json({ ok: true, mode, findings: findings.length, sent });
});
