/**
 * STAGE A — what the assistant DID with a message.
 *
 * Never what the trader wrote. No message text, no product wording, no names,
 * no prices, no balances, no model prose. Everything here is a bounded code
 * chosen from a list in this file, so merchant data cannot arrive in the
 * telemetry table by accident later.
 *
 * The point of Stage A is to stop fixing one sentence at a time. When
 * "shingapi" failed three times in a day, nothing recorded that it had. When a
 * malformed tool schema returned 400 for every call, the shop saw a template
 * reply and it looked like a stupid model. Both were invisible. After this,
 * neither is.
 */

/**
 * Identifies the interpreter, so a later regression can be attributed.
 *
 * No tool count in the name, deliberately: the surface the model is shown is
 * filtered by WHATSAPP_RECEIPTS_ENABLED, so it is 14 tools on some deployments
 * and 20 on others. A version that states a number would be wrong on one of
 * them, and a telemetry label that lies is worse than one that says less.
 */
export const PROMPT_VERSION = 'risip-agent-v3-active-question';
export const TOOL_SCHEMA_VERSION = 'tools-foundation-v1-runtime-checked';
/** Semantic runtime release written into privacy-safe operations telemetry. */
export const AI_RUNTIME_VERSION = 'whatsapp-ai-phase10-observability-v1';

/**
 * What the assistant was asked to do, derived from the tool it actually called.
 *
 * DELIBERATELY NOT a second opinion from the model. Asking Claude to label its
 * own performance produces a number that measures its self-regard. This reads
 * the tool call that really happened, and anything unmapped is `unknown` rather
 * than guessed — a wrong label is worse than a missing one, because it makes
 * the baseline look better than it is.
 */
export type SemanticIntent =
  | 'sale' | 'credit_sale' | 'expense' | 'stock_purchase' | 'customer_payment'
  | 'supplier_credit_purchase' | 'supplier_payment' | 'stock_loss' | 'owner_use'
  | 'whole_animal_procurement' | 'whole_animal_breakdown' | 'stock_count'
  | 'product_cost_setup' | 'selling_price_setup' | 'unit_setup' | 'vocabulary_teaching'
  | 'business_summary' | 'profit_query' | 'product_performance' | 'sales_trend'
  | 'stock_query' | 'receivables_query' | 'payables_query' | 'price_query'
  | 'stock_loss_query' | 'owner_use_query' | 'whole_animal_query'
  | 'cost_query' | 'price_comparison' | 'missing_selling_price' | 'advice' | 'receipts_query' | 'invoice_query'
  | 'petty_cash_query' | 'reimbursement_query' | 'businesses_query' | 'subscription_query'
  | 'approvals_query' | 'hypothetical_profit' | 'help'
  | 'conversational'
  | 'account_action'
  // A parked question answered through the model rather than by a parser.
  | 'clarification_answer'
  // Ending the trading day, and reading one day back entry by entry.
  | 'day_close'
  | 'day_records'
  // Two named days set against each other. Separate from daily_breakdown,
  // which walks a range: this one answers "tarehe 17 na 23, ipi ilikuwa bora".
  | 'day_comparison'
  | 'daily_breakdown'
  | 'debtor_history'
  | 'record_void'
  | 'price_update'
  | 'recurring_cost'
  | 'recurring_costs'
  | 'no_tool' | 'unknown';

/** Every read tool maps to exactly one question the shop was asking. */
const TOOL_INTENT: Record<string, SemanticIntent> = {
  request_account_action: 'account_action',
  get_business_summary: 'business_summary',
  get_stock_loss_report: 'stock_loss_query',
  get_owner_use_report: 'owner_use_query',
  get_whole_animal_report: 'whole_animal_query',
  get_product_performance: 'product_performance',
  get_product_cost: 'cost_query',
  get_selling_price: 'price_query',
  get_product_price_comparison: 'price_comparison',
  get_products_missing_selling_price: 'missing_selling_price',
  get_business_advice: 'advice',
  get_sales_trend: 'sales_trend',
  get_hypothetical_product_profit: 'hypothetical_profit',
  get_open_debts: 'receivables_query',
  get_my_receipts: 'receipts_query',
  get_receipt_details: 'receipts_query',
  get_invoice_details: 'invoice_query',
  get_my_petty_cash_balance: 'petty_cash_query',
  get_my_reimbursements: 'reimbursement_query',
  get_my_businesses: 'businesses_query',
  get_my_subscription: 'subscription_query',
  get_pending_approvals: 'approvals_query',
  get_stock_on_hand: 'stock_query',
  search_risip_help: 'help',
  get_supplier_payables: 'payables_query',
  respond_conversationally: 'conversational',
  propose_day_close: 'day_close',
  get_day_records: 'day_records',
  get_day_comparison: 'day_comparison',
  get_daily_breakdown: 'daily_breakdown',
  get_debtor_history: 'debtor_history',
  propose_record_void: 'record_void',
  propose_price_update: 'price_update',
  propose_recurring_cost: 'recurring_cost',
  get_recurring_costs: 'recurring_costs',
  resolve_pending_clarification: 'clarification_answer',
  propose_product_cost: 'product_cost_setup',
};

/** The record kinds a proposing tool can carry, mapped to the same vocabulary. */
const KIND_INTENT: Record<string, SemanticIntent> = {
  sale: 'sale',
  debt_issued: 'credit_sale',
  expense: 'expense',
  stock_purchase: 'stock_purchase',
  customer_payment: 'customer_payment',
  supplier_payable: 'supplier_credit_purchase',
  // Stage B says these in full rather than through a legacy alias.
  credit_sale: 'credit_sale',
  supplier_credit_purchase: 'supplier_credit_purchase',
  stock_count: 'stock_count',
  supplier_payment: 'supplier_payment',
  stock_loss: 'stock_loss',
  owner_use: 'owner_use',
  whole_animal_procurement: 'whole_animal_procurement',
  whole_animal_breakdown: 'whole_animal_breakdown',
};

/**
 * The intent behind a tool call.
 *
 * A proposing tool is only as specific as its `kind`, so that is read from the
 * tool input — the one field of it this file is allowed to look at, because it
 * is an enum and not merchant text.
 */
export function semanticIntentOf(
  toolName: string | null | undefined,
  toolInput?: Record<string, unknown> | null,
): SemanticIntent {
  const name = String(toolName ?? '').trim();
  if (!name) return 'no_tool';

  if (name === 'propose_daily_record' || name === 'propose_catalogue_transaction'
    || name === 'propose_business_event' || name === 'propose_money_event') {
    const kind = String(toolInput?.kind ?? '').trim();
    return KIND_INTENT[kind] ?? 'unknown';
  }
  return TOOL_INTENT[name] ?? 'unknown';
}

/**
 * What happened to the shop after the model had spoken.
 *
 * Tool choice alone says nothing about whether anybody was served: a perfectly
 * understood sale is still rejected when the product is not in the catalogue,
 * and that is a backend rule failing rather than a model failing. Stage A has
 * to be able to tell those two apart.
 */
export type BackendOutcome =
  | 'answered'        // a read tool returned figures and the shop was told
  | 'drafted'         // a pending record was created, awaiting NDIYO
  | 'clarified'       // a question went back, nothing written
  | 'rejected'        // a business rule refused it
  | 'fallback'        // the deterministic parsers served the message instead
  | 'provider_failed' // the model could not be reached
  | 'budget_blocked'; // the company's daily AI cap was reached

/** Why the assistant did not serve the user, when it did not. */
export type FallbackReason =
  | 'model_success'
  | 'model_empty'
  | 'provider_error'
  | 'provider_timeout'
  | 'budget_block'
  | 'invalid_tool_schema'
  | 'model_reply_deferred_for_safety'
  | 'not_eligible';

export type Interpretation = {
  waMessageId: string;
  chosenTool: string | null;
  semanticIntent: SemanticIntent;
  toolRounds: number | null;
  latencyMs: number | null;
  backendOutcome: BackendOutcome;
  rejectionCode: string | null;
  clarificationField: string | null;
  fallbackUsed: boolean;
  fallbackReason: FallbackReason | null;
  providerFailureCode: string | null;
};

/**
 * A provider error reduced to a code.
 *
 * The raw string can be long and can quote the request, so it is squeezed to
 * status plus error type plus the first field named — enough to tell
 * "the schema is malformed" from "we are out of credit", which is the exact
 * distinction that cost a day.
 */
export function providerFailureCode(raw: string | null | undefined): string | null {
  const said = String(raw ?? '').trim();
  if (!said) return null;
  const status = /(?<![0-9])([45]\d\d)(?![0-9])/.exec(said)?.[1] ?? '';
  const type = /(invalid_request_error|authentication_error|permission_error|not_found_error|rate_limit_error|api_error|overloaded_error|credit|billing)/i.exec(said)?.[1] ?? '';
  const field = /tools\.(\d+)\.[a-z_.]+/i.exec(said)?.[0] ?? '';
  const code = [status, type, field].filter(Boolean).join('|');
  return (code || said.slice(0, 60)).slice(0, 200);
}

/**
 * Which of the three grounding guards refused a reply, kept in a readable form.
 *
 * The assistant declines its own answer for three separate reasons: a figure no
 * tool returned, unsafe profit wording, or a date caveat the tool result
 * already disproved. Each is computed with detail, and the row used to keep
 * only the first. MEASURED over sixty days: of seven refusals, three carried no
 * recorded cause at all, because they were the other two reasons and fell to
 * null on the way to the table.
 *
 * That is the difference between "the guard is too strict" and "the model is
 * inventing totals", which is the whole question anybody asks of this column.
 * The prefix is kept so the three cannot be confused with each other, and so
 * neither can be confused with a business rule's own rejection code.
 *
 * Rows written before this returned the bare shape ("2x1") with no prefix; a
 * query over both eras should allow for that.
 */
export function guardRefusalCode(failure: string | null | undefined): string | null {
  const raw = String(failure ?? '');
  const match = /^model_(ungrounded_number|profit_wording|false_date_caveat):(.+)$/.exec(raw);
  return match ? `${match[1]}:${match[2]}`.slice(0, 200) : null;
}

/**
 * The row, built from things already known at the call site.
 *
 * Returns a plain object rather than writing: the caller decides when to write,
 * and a failure to write must never reach the shop.
 */
export function buildInterpretation(input: {
  waMessageId: string;
  toolNames?: string[] | null;
  lastToolInput?: Record<string, unknown> | null;
  latencyMs?: number | null;
  backendOutcome: BackendOutcome;
  rejectionCode?: string | null;
  clarificationField?: string | null;
  fallbackReason?: FallbackReason | null;
  providerFailure?: string | null;
}): Interpretation {
  const tools = input.toolNames ?? [];
  const chosenTool = tools.length > 0 ? tools[tools.length - 1] : null;
  const reason = input.fallbackReason ?? null;
  return {
    waMessageId: input.waMessageId,
    chosenTool,
    semanticIntent: semanticIntentOf(chosenTool, input.lastToolInput),
    toolRounds: tools.length > 0 ? tools.length : null,
    latencyMs: input.latencyMs ?? null,
    backendOutcome: input.backendOutcome,
    rejectionCode: input.rejectionCode ? String(input.rejectionCode).slice(0, 64) : null,
    clarificationField: input.clarificationField ? String(input.clarificationField).slice(0, 48) : null,
    fallbackUsed: input.backendOutcome === 'fallback',
    fallbackReason: reason,
    providerFailureCode: providerFailureCode(input.providerFailure),
  };
}
