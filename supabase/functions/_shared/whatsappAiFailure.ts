/** Bounded failure attribution. Never log a provider response or merchant text. */
export type AiFailureLayer = 'input' | 'model' | 'tool_schema' | 'tool_execution' | 'backend_validation' | 'provider' | 'grounding' | 'retrieval' | 'state' | 'budget' | 'database' | 'deployment' | 'unknown';
export function aiFailureLayer(code: string): AiFailureLayer {
  if (code === 'input_too_long' || code === 'empty_user_text') return 'input';
  if (code.startsWith('tool_boundary:')) return 'tool_schema';
  if (code.startsWith('tool_execution_failed:')) return 'tool_execution';
  if (code.startsWith('backend_rejected:')) return 'backend_validation';
  if (code.startsWith('retrieval_') || code.startsWith('catalogue_retrieval_')) return 'retrieval';
  if (code.startsWith('state_')) return 'state';
  if (code.startsWith('database_')) return 'database';
  if (code.startsWith('deployment_')) return 'deployment';
  if (/^model_(ungrounded_number|profit_wording|false_date_caveat):/.test(code)) return 'grounding';
  if (code === 'budget_block') return 'budget';
  if (code.startsWith('provider_') || code === 'missing_api_key') return 'provider';
  if (['missing_required_tool_call', 'tool_round_limit', 'tool_loop_exhausted', 'turn_deadline_exceeded'].includes(code)) return 'model';
  return 'unknown';
}
