-- Phase 10: privacy-safe AI failure attribution for the existing platform
-- admin console. No merchant message, product, party, price or balance is
-- copied into telemetry.

alter table public.whatsapp_ai_interpretations
  add column if not exists failure_layer text,
  add column if not exists retrieval_status text,
  add column if not exists conversation_state text,
  add column if not exists tool_result_status text,
  add column if not exists tool_failure_code text,
  add column if not exists runtime_version text;

alter table public.whatsapp_ai_interpretations
  drop constraint if exists ai_interp_failure_layer_check,
  add constraint ai_interp_failure_layer_check check (
    failure_layer is null or failure_layer in (
      'none', 'input', 'model', 'tool_schema', 'tool_execution',
      'backend_validation', 'provider', 'grounding', 'retrieval', 'state',
      'budget', 'database', 'deployment', 'unknown'
    )
  ),
  drop constraint if exists ai_interp_retrieval_status_check,
  add constraint ai_interp_retrieval_status_check check (
    retrieval_status is null or retrieval_status in (
      'available', 'partial', 'unavailable', 'not_run', 'unknown'
    )
  ),
  drop constraint if exists ai_interp_conversation_state_check,
  add constraint ai_interp_conversation_state_check check (
    conversation_state is null or conversation_state in (
      'none', 'history', 'active_question', 'unknown'
    )
  ),
  drop constraint if exists ai_interp_tool_result_status_check,
  add constraint ai_interp_tool_result_status_check check (
    tool_result_status is null or tool_result_status in (
      'none', 'success', 'error', 'unknown'
    )
  ),
  drop constraint if exists ai_interp_observability_code_lengths_check,
  add constraint ai_interp_observability_code_lengths_check check (
    coalesce(length(tool_failure_code), 0) <= 96
    and coalesce(length(runtime_version), 0) <= 64
  );

comment on column public.whatsapp_ai_interpretations.failure_layer is
  'Bounded root-cause layer for platform operations; never merchant text.';
comment on column public.whatsapp_ai_interpretations.retrieval_status is
  'Aggregate availability of the company-scoped RAG lookup for this turn.';
comment on column public.whatsapp_ai_interpretations.conversation_state is
  'Whether the turn had no context, bounded history, or an active question.';
comment on column public.whatsapp_ai_interpretations.tool_result_status is
  'Aggregate tool outcome only: none, success, error, or unknown.';
comment on column public.whatsapp_ai_interpretations.tool_failure_code is
  'Bounded infrastructure or validation code; never tool output.';
comment on column public.whatsapp_ai_interpretations.runtime_version is
  'Semantic source release emitted by the deployed WhatsApp runtime.';

create index if not exists ai_interp_failure_time_idx
  on public.whatsapp_ai_interpretations (failure_layer, created_at desc);
create index if not exists ai_interp_runtime_time_idx
  on public.whatsapp_ai_interpretations (runtime_version, created_at desc);

drop function if exists public.wa_record_ai_interpretation(
  uuid, text, text, text, text, text, text, integer, integer, text, text, text,
  boolean, text, text, text, integer, integer
);

create or replace function public.wa_record_ai_interpretation(
  p_company_id uuid,
  p_wa_message_id text,
  p_model text,
  p_prompt_version text,
  p_tool_schema_version text,
  p_chosen_tool text,
  p_semantic_intent text,
  p_tool_rounds integer,
  p_latency_ms integer,
  p_backend_outcome text,
  p_rejection_code text,
  p_clarification_field text,
  p_fallback_used boolean,
  p_fallback_reason text,
  p_provider_failure_code text,
  p_route text default null,
  p_cache_read_tokens integer default null,
  p_cache_write_tokens integer default null,
  p_failure_layer text default null,
  p_retrieval_status text default null,
  p_conversation_state text default null,
  p_tool_result_status text default null,
  p_tool_failure_code text default null,
  p_runtime_version text default null
)
returns void
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
begin
  delete from public.whatsapp_ai_interpretations where expires_at < now();

  insert into public.whatsapp_ai_interpretations (
    company_id, wa_message_id, model, prompt_version, tool_schema_version,
    chosen_tool, semantic_intent, tool_rounds, latency_ms, backend_outcome,
    rejection_code, clarification_field, fallback_used, fallback_reason,
    provider_failure_code, route, cache_read_tokens, cache_write_tokens,
    failure_layer, retrieval_status, conversation_state, tool_result_status,
    tool_failure_code, runtime_version
  ) values (
    p_company_id, p_wa_message_id, left(p_model, 64), left(p_prompt_version, 48),
    left(p_tool_schema_version, 48), left(p_chosen_tool, 64),
    left(coalesce(nullif(btrim(p_semantic_intent), ''), 'unknown'), 48),
    p_tool_rounds, p_latency_ms, p_backend_outcome, left(p_rejection_code, 64),
    left(p_clarification_field, 48), coalesce(p_fallback_used, false),
    p_fallback_reason, left(p_provider_failure_code, 200), left(p_route, 32),
    greatest(0, p_cache_read_tokens), greatest(0, p_cache_write_tokens),
    left(p_failure_layer, 32), left(p_retrieval_status, 16),
    left(p_conversation_state, 24), left(p_tool_result_status, 16),
    left(p_tool_failure_code, 96), left(p_runtime_version, 64)
  )
  on conflict (wa_message_id) do update set
    model = excluded.model,
    prompt_version = excluded.prompt_version,
    tool_schema_version = excluded.tool_schema_version,
    chosen_tool = excluded.chosen_tool,
    semantic_intent = excluded.semantic_intent,
    tool_rounds = excluded.tool_rounds,
    latency_ms = excluded.latency_ms,
    backend_outcome = excluded.backend_outcome,
    rejection_code = excluded.rejection_code,
    clarification_field = excluded.clarification_field,
    fallback_used = excluded.fallback_used,
    fallback_reason = excluded.fallback_reason,
    provider_failure_code = excluded.provider_failure_code,
    route = excluded.route,
    cache_read_tokens = excluded.cache_read_tokens,
    cache_write_tokens = excluded.cache_write_tokens,
    failure_layer = excluded.failure_layer,
    retrieval_status = excluded.retrieval_status,
    conversation_state = excluded.conversation_state,
    tool_result_status = excluded.tool_result_status,
    tool_failure_code = excluded.tool_failure_code,
    runtime_version = excluded.runtime_version;
exception when others then
  -- Operations telemetry must never prevent a merchant from receiving a reply.
  null;
end $function$;

revoke all on function public.wa_record_ai_interpretation(
  uuid, text, text, text, text, text, text, integer, integer, text, text, text,
  boolean, text, text, text, integer, integer, text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.wa_record_ai_interpretation(
  uuid, text, text, text, text, text, text, integer, integer, text, text, text,
  boolean, text, text, text, integer, integer, text, text, text, text, text, text
) to service_role;

create or replace function public.platform_admin_ai_ops(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_start timestamptz := now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 180)));
begin
  perform private.require_platform_admin('read');

  return jsonb_build_object(
    'metrics', jsonb_build_object(
      'requests', (select count(*) from public.whatsapp_ai_interpretations i where i.created_at >= v_start),
      'estimatedCost', (select coalesce(sum(u.estimated_cost), 0) from public.whatsapp_ai_usage_daily u where u.usage_day >= v_start::date),
      'failures', (select count(*) from public.whatsapp_ai_interpretations i where i.created_at >= v_start and (coalesce(i.failure_layer, 'none') <> 'none' or i.backend_outcome in ('provider_failed', 'rejected'))),
      'clarifications', (select count(*) from public.whatsapp_ai_interpretations i where i.created_at >= v_start and i.backend_outcome = 'clarified'),
      'retrievalFailures', (select count(*) from public.whatsapp_ai_interpretations i where i.created_at >= v_start and (i.failure_layer = 'retrieval' or i.retrieval_status = 'unavailable')),
      'toolFailures', (select count(*) from public.whatsapp_ai_interpretations i where i.created_at >= v_start and (i.failure_layer in ('tool_schema', 'tool_execution', 'backend_validation', 'database') or i.tool_result_status = 'error')),
      'groundingFailures', (select count(*) from public.whatsapp_ai_interpretations i where i.created_at >= v_start and i.failure_layer = 'grounding'),
      'successRate', (select case when count(*) = 0 then 0 else round(100.0 * count(*) filter (where i.backend_outcome in ('answered', 'drafted') and coalesce(i.failure_layer, 'none') = 'none') / count(*), 1) end from public.whatsapp_ai_interpretations i where i.created_at >= v_start),
      'p50LatencyMs', (select round(percentile_cont(0.50) within group (order by i.latency_ms)) from public.whatsapp_ai_interpretations i where i.created_at >= v_start and i.latency_ms is not null),
      'p95LatencyMs', (select round(percentile_cont(0.95) within group (order by i.latency_ms)) from public.whatsapp_ai_interpretations i where i.created_at >= v_start and i.latency_ms is not null)
    ),
    'intents', coalesce((select jsonb_agg(jsonb_build_object('intent', x.semantic_intent, 'count', x.count) order by x.count desc) from (select semantic_intent, count(*) from public.whatsapp_ai_interpretations where created_at >= v_start group by semantic_intent) x), '[]'::jsonb),
    'tools', coalesce((select jsonb_agg(jsonb_build_object('tool', coalesce(x.chosen_tool, 'none'), 'count', x.count) order by x.count desc) from (select chosen_tool, count(*) from public.whatsapp_ai_interpretations where created_at >= v_start group by chosen_tool) x), '[]'::jsonb),
    'models', coalesce((select jsonb_agg(jsonb_build_object('model', coalesce(x.model, 'unknown'), 'promptVersion', x.prompt_version, 'toolSchemaVersion', x.tool_schema_version, 'count', x.count) order by x.count desc) from (select model, prompt_version, tool_schema_version, count(*) from public.whatsapp_ai_interpretations where created_at >= v_start group by model, prompt_version, tool_schema_version) x), '[]'::jsonb),
    'failureLayers', coalesce((select jsonb_agg(jsonb_build_object('layer', coalesce(x.failure_layer, 'legacy_unknown'), 'count', x.count) order by x.count desc) from (select failure_layer, count(*) from public.whatsapp_ai_interpretations where created_at >= v_start and (coalesce(failure_layer, 'none') <> 'none' or backend_outcome in ('provider_failed', 'rejected')) group by failure_layer) x), '[]'::jsonb),
    'retrievalHealth', coalesce((select jsonb_agg(jsonb_build_object('status', coalesce(x.retrieval_status, 'legacy_unknown'), 'count', x.count) order by x.count desc) from (select retrieval_status, count(*) from public.whatsapp_ai_interpretations where created_at >= v_start group by retrieval_status) x), '[]'::jsonb),
    'runtimeVersions', coalesce((select jsonb_agg(jsonb_build_object('version', coalesce(x.runtime_version, 'legacy_unknown'), 'count', x.count) order by x.count desc) from (select runtime_version, count(*) from public.whatsapp_ai_interpretations where created_at >= v_start group by runtime_version) x), '[]'::jsonb),
    'recentDiagnostics', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', x.id, 'companyId', x.company_id, 'companyName', x.company_name,
        'outcome', x.backend_outcome, 'intent', x.semantic_intent,
        'tool', x.chosen_tool, 'failureLayer', coalesce(x.failure_layer, 'legacy_unknown'),
        'rejectionCode', x.rejection_code, 'providerFailureCode', x.provider_failure_code,
        'retrievalStatus', coalesce(x.retrieval_status, 'legacy_unknown'),
        'conversationState', coalesce(x.conversation_state, 'legacy_unknown'),
        'toolResultStatus', coalesce(x.tool_result_status, 'legacy_unknown'),
        'toolFailureCode', x.tool_failure_code, 'runtimeVersion', coalesce(x.runtime_version, 'legacy_unknown'),
        'model', x.model, 'promptVersion', x.prompt_version,
        'toolSchemaVersion', x.tool_schema_version, 'latencyMs', x.latency_ms,
        'createdAt', x.created_at
      ) order by x.created_at desc)
      from (
        select i.*, c.name as company_name
        from public.whatsapp_ai_interpretations i
        join public.companies c on c.id = i.company_id
        where i.created_at >= v_start
          and (
            coalesce(i.failure_layer, 'none') <> 'none'
            or i.backend_outcome in ('clarified', 'rejected', 'provider_failed', 'budget_blocked')
            or i.retrieval_status in ('partial', 'unavailable')
            or i.tool_result_status = 'error'
          )
        order by i.created_at desc
        limit 100
      ) x
    ), '[]'::jsonb),
    'companies', coalesce((select jsonb_agg(jsonb_build_object(
      'id', c.id, 'name', c.name,
      'usedToday', coalesce((select sum(u.fallback_count) from public.whatsapp_ai_usage_daily u where u.company_id = c.id and u.usage_day = timezone('utc', now())::date), 0),
      'dailyLimit', coalesce(c.ai_daily_request_limit, 30),
      'usedMonth', coalesce((select sum(u.fallback_count) from public.whatsapp_ai_usage_daily u where u.company_id = c.id and u.usage_day >= date_trunc('month', timezone('utc', now())::date)::date), 0),
      'monthlyLimit', c.ai_monthly_request_limit,
      'estimatedCost', coalesce((select sum(u.estimated_cost) from public.whatsapp_ai_usage_daily u where u.company_id = c.id and u.usage_day >= v_start::date), 0)
    ) order by c.name) from public.companies c), '[]'::jsonb)
  );
end $function$;

revoke all on function public.platform_admin_ai_ops(integer) from public, anon;
grant execute on function public.platform_admin_ai_ops(integer) to authenticated, service_role;
