import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// BEING TOLD, NOT HAVING TO LOOK.
//
// MEASURED over the first 711 messages on the live number:
//
//   10  worker_ended_before_completion   the shopkeeper typed and got NOTHING
//    1  no_active_project
//    1  recovered_stale_pending_after_blocked_queue
//
// One in seventy messages died in silence. Silence is the worst failure this
// system has, because from the counter it is indistinguishable from being
// ignored — and the one time the service went down completely, the owner found
// it himself, after every message had been failing for a while.
//
// The admin console already shows failures, stale work, latency, cost and
// per-company limits, and shows them well. What it cannot do is reach anybody:
// it is a page you have to open. These two changes close that half.

const webhook = readFileSync(
  resolve(process.cwd(), 'supabase/functions/whatsapp-webhook/index.ts'), 'utf8');
const watch = readFileSync(
  resolve(process.cwd(), 'supabase/functions/ops-watch/index.ts'), 'utf8');

const sweep = webhook.slice(
  webhook.indexOf('const abandonedSince ='),
  webhook.indexOf('const abandonedSince =') + 2600,
);

describe('a message that dies is not left in silence', () => {
  it('reads the abandoned rows before marking them', () => {
    // Marking first would lose the phone number, which is the whole reason the
    // previous version could not apologise even in principle.
    const read = sweep.indexOf(".select('wa_message_id, phone_e164, created_at')");
    const mark = sweep.indexOf("last_error: 'worker_ended_before_completion'");
    expect(read).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(read);
  });

  it('answers the recent ones and leaves the ancient ones alone', () => {
    // The original reasoning was right and is kept: an answer to an eleven-day
    // -old question is its own kind of confusing. Two hours is the line.
    expect(sweep).toContain('age < 2 * 60 * 60_000');
    expect(sweep).toContain('an answer to an eleven-day-old question');
  });

  it('cannot apologise twice for the same message', () => {
    // Idempotent by construction rather than by a flag: the rows are already
    // 'failed' by the time the send runs, and the sweep only ever selects
    // pending or processing.
    expect(sweep).toContain(".in('status', ['pending', 'processing'])");
    expect(sweep).toContain('cannot pick them up and apologise twice');
  });

  it('cannot flood one person on a bad morning', () => {
    expect(sweep).toContain('.slice(0, 5)');
    expect(sweep).toContain('.limit(20)');
  });

  it('tells the shopkeeper what to DO, and nothing about our internals', () => {
    // Assert on the SENTENCE THEY RECEIVE, not on the code around it — the
    // surrounding code naturally mentions statuses and providers while
    // carefully keeping them out of the message.
    const message = sweep.match(/'(Samahani, ujumbe huu[^']+)'/)?.[1] ?? '';
    expect(message).toContain('Tafadhali utume tena');
    expect(message).not.toMatch(/stack|HTTP|error|500|503|anthropic|supabase|worker/i);
  });

  it('quotes the message it is apologising for', () => {
    // With several answers in flight the quote is the only thing that says
    // which message never arrived.
    expect(sweep).toContain('String(row.wa_message_id)');
  });
});

describe('the watchdog', () => {
  it('proves the front door booted, not merely that it responded', () => {
    // An unsigned POST must come back 401. That single fact proves the module
    // parsed, booted and reached its signature check — which is exactly what a
    // BOOT_ERROR breaks, and exactly the outage that went unnoticed.
    expect(watch).toContain('if (res.status === 401) return null;');
    expect(watch).toContain('BOOT_ERROR');
  });

  it('says plainly what a BOOT_ERROR means, in the alert itself', () => {
    // At two in the morning the alert has to carry its own explanation.
    expect(watch).toContain('Every incoming message is being dropped right now.');
  });

  it('catches work that started and never finished', () => {
    expect(watch).toContain("in('status', ['pending', 'processing'])");
    expect(watch).toContain('stuck for over 15 minutes');
  });

  it('is silent while everything is healthy', () => {
    // An alarm that fires every five minutes regardless is an alarm nobody
    // reads by the end of the week.
    expect(watch).toContain('if (findings.length === 0) return Response.json');
    expect(watch).toContain('Silence when healthy.');
  });

  it('uses email, and says why not WhatsApp', () => {
    // A business-initiated WhatsApp message needs a template and a 24-hour
    // window. An alarm at 2am would find that window shut.
    expect(watch).toContain('api.resend.com/emails');
    expect(watch).toMatch(/24-hour window; an alarm that fires\s*\n?\/\/ at two in the morning/);
  });

  it('is not a public endpoint', () => {
    expect(watch).toContain("Deno.env.get('OPS_WATCH_SECRET')");
    expect(watch).toContain("return new Response('forbidden', { status: 403 });");
  });

  it('probes once per run', () => {
    // Calling it twice to build the array would double every alarm.
    expect((watch.match(/await probeWebhook\(\)/g) ?? [])).toHaveLength(1);
  });

  it('reads counts and codes only — never a person or a figure', () => {
    expect(watch).toContain('No message text, no phone numbers');
    expect(watch).not.toMatch(/select\('[^']*\b(message_text|body|party_name|amount)\b/);
  });

  it('reports the shops that have gone quiet, which is churn before it is anything else', () => {
    expect(watch).toContain('Shops silent 7+ days');
  });

  it('attributes sustained AI failures instead of treating every error as provider failure', () => {
    expect(watch).toContain("['tool_schema', 'tool_execution', 'backend_validation', 'database']");
    expect(watch).toContain("row.failure_layer === 'retrieval'");
    expect(watch).toContain("countLayers(['budget'])");
    expect(watch).toContain("countLayers(['deployment'])");
    expect(watch).toContain("countLayers(['state'])");
  });

  it('has explicit pilot thresholds for bursts and latency', () => {
    expect(watch).toContain('const THRESHOLDS = {');
    expect(watch).toContain('p95LatencyMs: 15_000');
    expect(watch).toContain('minimumLatencySamples: 5');
  });

  it('puts an owner and stable code on every incident', () => {
    expect(watch).toContain("Deno.env.get('OPS_INCIDENT_OWNER')");
    expect(watch).toContain('code: string;');
    expect(watch).toContain('owner: string;');
    expect(watch).toContain('Owner: ${f.owner}');
  });

  it('checks proactive delivery failures without reading their private payloads', () => {
    expect(watch).toContain("from('whatsapp_notification_deliveries')");
    expect(watch).toContain(".select('id', { count: 'exact', head: true })");
    expect(watch).not.toMatch(/whatsapp_notification_deliveries[^;]+select\('[^']*(phone_e164_snapshot|parameters|last_error)/s);
  });
});
