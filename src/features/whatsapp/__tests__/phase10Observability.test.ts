import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runConversationalAssistant, type AssistantIdentityContext } from '../../../../supabase/functions/_shared/whatsappAssistant';
import { aiFailureLayer } from '../../../../supabase/functions/_shared/whatsappAiFailure';
import { overallRetrievalStatus, type RetrievalHealth } from '../../../../supabase/functions/_shared/whatsappRetrievalHealth';
import { AI_RUNTIME_VERSION } from '../../../../supabase/functions/_shared/whatsappTelemetry';

const context: AssistantIdentityContext = {
  identityId: 'synthetic-identity', profileId: 'synthetic-profile', companyId: 'synthetic-company',
  companyName: 'Test shop', userName: 'Test worker', role: 'worker', lang: 'sw',
  approvalFlowEnabled: false, reversalEnabled: false, payoutsEnabled: false,
};
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const migration = readFileSync(resolve(process.cwd(), 'supabase/migrations/20260906100000_phase10_ai_observability.sql'), 'utf8');
const webhook = readFileSync(resolve(process.cwd(), 'supabase/functions/whatsapp-webhook/index.ts'), 'utf8');

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('phase 10 privacy-safe root-cause attribution', () => {
  it('classifies retrieval, backend validation and deployment-safe codes', () => {
    expect(aiFailureLayer('retrieval_catalogue_unavailable')).toBe('retrieval');
    expect(aiFailureLayer('backend_rejected:get_stock_on_hand')).toBe('backend_validation');
    expect(aiFailureLayer('database_rpc_failed')).toBe('database');
    expect(aiFailureLayer('deployment_revision_mismatch')).toBe('deployment');
  });

  it('reduces four RAG sources to one operational status', () => {
    const healthy: RetrievalHealth = { vocabulary: 'available', products: 'available', units: 'available', prices: 'available' };
    expect(overallRetrievalStatus(healthy)).toBe('available');
    expect(overallRetrievalStatus({ ...healthy, prices: 'partial' })).toBe('partial');
    expect(overallRetrievalStatus({ ...healthy, products: 'unavailable', prices: 'partial' })).toBe('unavailable');
  });

  it('records an errored tool without copying its result into telemetry', async () => {
    vi.stubGlobal('Deno', { env: { get: (key: string) => key === 'ANTHROPIC_API_KEY' ? 'synthetic-key' : undefined } });
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ data: [] }))
      .mockResolvedValueOnce(json({ content: [{ type: 'tool_use', id: 'tool-1', name: 'get_stock_on_hand', input: { product_name: 'mafuta' } }] }))
      .mockResolvedValueOnce(json({ content: [{ type: 'text', text: 'Sikuweza kuthibitisha stoo kwa sasa.' }] }));
    const result = await runConversationalAssistant({
      context,
      history: [],
      userText: 'stoo ya mafuta ni kiasi gani?',
      executeTool: async () => ({
        content: 'private tool result that must never become a diagnostic code',
        isError: true,
        errorCode: 'retrieval_catalogue_unavailable',
      }),
    });
    expect(result?.toolResultStatus).toBe('error');
    expect(result?.toolFailureCode).toBe('retrieval_catalogue_unavailable');
    expect(JSON.stringify(result)).not.toContain('private tool result');
  });

  it('persists only bounded operational fields and exposes them through the existing admin console RPC', () => {
    for (const column of ['failure_layer', 'retrieval_status', 'conversation_state', 'tool_result_status', 'tool_failure_code', 'runtime_version']) {
      expect(migration).toContain(column);
    }
    expect(migration).toContain('platform_admin_ai_ops');
    expect(migration).toContain('recentDiagnostics');
    expect(migration).toContain('No merchant message, product, party, price or balance');
    expect(migration).not.toMatch(/jsonb_build_object\([^)]*message_text/i);
    expect(webhook).toContain('p_failure_layer:');
    expect(webhook).toContain('p_runtime_version: AI_RUNTIME_VERSION');
    expect(AI_RUNTIME_VERSION).toBe('whatsapp-ai-phase10-observability-v1');
  });
});
