// whatsapp-webhook · Meta WhatsApp Cloud API webhook for receipt capture.
//
//   GET  → Meta's subscription challenge (hub.verify_token / hub.challenge).
//   POST → message events. We verify the signature against the RAW body, record
//          the message idempotently, and return 200. Receipt images are queued;
//          linked free text may use the bounded conversational AI tool loop.
//
// Two message shapes matter:
//   "LINK <token>" text → binds this WhatsApp number to a Risip profile.
//   image               → queued as a job for whatsapp-worker.
//
// verify_jwt = false — this is a public webhook. Security is the HMAC signature
// plus the fact that an unlinked number can do nothing but read a help message.
//
// Env: WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_ACCESS_TOKEN,
//      WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_API_VERSION?, RISIP_PUBLIC_APP_URL,
//      SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';
import {
  billingAskProvider,
  billingPushFailed,
  billingPushSent,
  parseBillingAnswer,
} from '../_shared/billingMessages.ts';
import {
  createSnippePayment,
  providerForPhone,
  splitName,
} from '../_shared/snippePayment.ts';
import {
  buildUnlinkedReply,
  evaluateLinkToken,
  linkFailureMessage,
  maskPhone,
  normalizeE164,
  parseBareLinkToken,
  parseLinkToken,
  sha256Hex,
  verifyMetaSignature,
} from '../_shared/whatsapp.ts';
import { clearTypingSeal, sendWhatsAppText, showTyping, whatsAppDisplayNumber } from '../_shared/whatsappApi.ts';
import {
  markWhatsAppTurnProcessing,
  releaseWhatsAppTurn,
  startWhatsAppTypingHeartbeat,
  startWhatsAppTurnHeartbeat,
  waitForWhatsAppTurn,
} from '../_shared/whatsappTurn.ts';
import { looksLikeMachineText } from '../_shared/whatsappMachineText.ts';
import {
  isProactiveNotificationStop,
  notificationStoppedReply,
} from '../_shared/whatsappNotifications.ts';
import {
  detectLanguage,
  isHelp,
  isCancel,
  isConfirm,
  isPendingEscape,
  pendingEscapeHint,
  languageCommandRemainder,
  parseLanguageCommand,
  parseProjectChoice,
  routeIntent,
  t,
  type Lang,
  type ProjectRef,
} from '../_shared/whatsappIntent.ts';
import {
  buildDailyRecordCancelled,
  buildDailyRecordConfirmation,
  buildDailyRecordConfirmationChunks,
  buildDailyRecordConfirmed,
  buildDailyRecordPending,
  dailyRecordStorageDescription,
  isDailyRecordCandidate,
  normalizeNumberWords,
  isDailyRecordConfirmation,
  isDailyRecordRejection,
  parseDailyRecordPriceChoice,
  parseDailyRecord,
  resumeDailyRecordClarification,
  splitWhatsAppText,
  detectDailyRecordPriceAnomalies,
  type DailyRecordClarification,
  type DailyRecordParse,
  type DailyRecordConversation,
  type ParsedDailyRecord,
} from '../_shared/whatsappDailyRecords.ts';
import {
  buildDailyRecordBatchConfirmation,
  buildDailyRecordBatchConfirmed,
  buildDailyRecordBatchPending,
  parseDailyRecordBatch,
  resumeDailyRecordBatchClarification,
  type DailyRecordBatchClarification,
  type DailyRecordBatchParse,
  type DailyRecordBatchConversation,
} from '../_shared/whatsappDailyRecordBatch.ts';
import {
  advanceOnboarding,
  businessList,
  findInviteCode,
  isLoginRequest,
  isSwitchRequest,
  parseBusinessChoice,
  startOnboarding,
  type OnboardingStep,
  type OnboardingResult,
} from '../_shared/whatsappOnboarding.ts';
import {
  findSignupCode,
  draftIsClaimable,
  draftLang,
  draftToCreateAction,
  badCodeReply,
  type WebSignupDraftRow,
} from '../_shared/webSignupDraft.ts';
import { waSyntheticEmail } from '../_shared/waIdentityEmail.ts';
import {
  costConfirmation,
  costSaved,
  parseProductCost,
  productCostErrorMessage,
  productCostReply,
  normaliseUnit,
  validateProductCostCandidate,
  type ProductCost,
} from '../_shared/whatsappProductCosts.ts';
import {
  aggregateProducts,
  parseProductAnalyticsFollowUp,
  parseProductAnalyticsRequest,
  periodStart,
  productAnalyticsReply,
  rankProducts,
  type ProductAggregate,
  type ProductAnalyticsContext,
  type ProductAnalyticsRequest,
  type ProductCostPoint,
  type ProductSaleLine,
} from '../_shared/whatsappProductAnalytics.ts';
import { interpretDailyRecordWithAi, MAX_INTERPRETATION_CHARS, validateAiCandidate } from '../_shared/whatsappDailyRecordsAi.ts';
import { validateAiTransactionCandidate } from '../_shared/whatsappTransactionAi.ts';
import { buildKnowledgeReply } from '../_shared/risipKnowledge.ts';
import { findNameWarnings, nameWarningText, productKey } from '../_shared/whatsappProductNames.ts';
import {
  ambiguousProductQuestion,
  formatCatalogueContext,
  isSemanticallyAmbiguousProduct,
  unitChoiceQuestion,
  type CatalogueContextProduct,
} from '../_shared/whatsappCatalogueContext.ts';
import {
  missingSellingPriceReply,
  productPriceComparisonReply,
  type ProductPriceRead,
} from '../_shared/whatsappProductPriceReads.ts';
import {
  parseSellingPriceBatch,
  addPriceTier,
  sellingPriceBatchCancelled,
  sellingPriceBatchConfirmation,
  sellingPriceBatchCostWarnings,
  sellingPriceBatchSaved,
  sellingPriceBatchUnknownProducts,
  type SellingPriceBatch,
  type SellingPrice,
} from '../_shared/whatsappSellingPriceBatch.ts';
import {
  inviteCancelled,
  inviteLanguageQuestion,
  inviteNotAllowed,
  inviteReady,
  inviteForwardMessage,
  inviteRoleQuestion,
  parseInviteRequest,
  parseInviteRole,
} from '../_shared/whatsappInvite.ts';
import {
  addProductNameQuestion,
  addProductNeedsCost,
  isAddProductStart,
  parseAddProduct,
  parseAddProductName,
  productAlreadyExists,
  productLooksLikeExisting,
} from '../_shared/whatsappAddProduct.ts';
import {
  newProductCancelled,
  newProductConfirmation,
  newProductQuantityIncomplete,
  newProductQuantityQuestion,
  newProductRegistrationConfirmation,
  newProductOffer,
  newProductPricingIncomplete,
  newProductSaleOffer,
  newProductSaleWorkerBlocked,
  newProductSaved,
  parseNewProductPricing,
  type NewProductStock,
  type NewProductPricing,
} from '../_shared/whatsappNewProduct.ts';
import {
  matchDeclaredSaleUnit,
  matchPortionMissingQuantity,
  parsePortionSetupOffer,
  parsePortionQuantityAnswer,
  portionSetupCancelled,
  portionSetupConfirmation,
  portionSetupSaved,
  portionSizeQuestion,
  portionQuantityQuestion,
  portionUnitRequired,
  resumePortionSetup,
  type DeclaredSaleUnit,
  type PortionSetupDraft,
  type PortionSetupReady,
  type PortionQuantityPrompt,
} from '../_shared/whatsappPortions.ts';
import {
  parsePortionYield,
  portionYieldPieces,
  portionYieldSaved,
} from '../_shared/whatsappPortionYield.ts';
import {
  parseStockLoss,
  ownerUseConfirmation,
  spoilageClarification,
  stockLossConfirmation,
} from '../_shared/whatsappStockLoss.ts';
import {
  aliasConfirmation,
  forgetConfirmation,
  parseVocabularyTeaching,
  semanticConfirmation,
  vocabularyConflict,
  vocabularyContext,
  vocabularyForgotten,
  vocabularyNotAllowed,
  vocabularySaved,
  type VocabularyPending,
} from '../_shared/whatsappVocabulary.ts';
import {
  derivedUnitCost,
  packagingConfirmation,
  parseProductSetup,
  productSetupConfirmation,
  productSetupSaved,
  setupSaleUnits,
  type ProductSetupPending,
} from '../_shared/whatsappProductSetup.ts';
import {
  canonicalPaymentWording,
  extractPaymentMethod,
  parsePaymentMethodAnswer,
  paymentWordingQuestion,
} from '../_shared/whatsappPaymentMethod.ts';
// Who sees a message first: the line between a sentence and a protocol answer.
import { answersPendingQuestion, isProtectedSystemCommand, messageGoesToModel, protectedPriceBandAnswer, protectedSaleProductAnswer } from '../_shared/whatsappRouting.ts';
import { catalogueProposalBlocked, overallRetrievalStatus, retrievalHealthContext, type RetrievalHealth } from '../_shared/whatsappRetrievalHealth.ts';
import { aiFailureLayer } from '../_shared/whatsappAiFailure.ts';
import { mergeStockAnswers, pendingConversationContext, type StockAnswer } from '../_shared/whatsappPendingContext.ts';
import {
  classifyAssistantFailure,
  MAX_ASSISTANT_USER_CHARS,
  type AssistantFailureClass,
} from '../_shared/whatsappAssistant.ts';
import {
  asBand,
  checkCanonicalValue,
  checkNumber,
  describePending,
  validateClarificationAnswers,
  type PendingClarification,
} from '../_shared/whatsappClarification.ts';
import type { MessageRoute } from '../_shared/whatsappRouting.ts';
// STAGE B — the wide language contract. The model sends the trader's words;
// these decide what they are worth.
import {
  numberQuestion,
  validateBusinessEvent,
  validateMoneyEvent,
  readNumber,
} from '../_shared/whatsappBusinessEvent.ts';
import type { ValidatedBusinessEvent } from '../_shared/whatsappBusinessEvent.ts';
import type { DailyRecordPaymentMethod } from '../_shared/whatsappDailyRecords.ts';
import type { WholeAnimalPaymentMethod } from '../_shared/whatsappWholeAnimalProcurement.ts';
import {
  AI_RUNTIME_VERSION,
  PROMPT_VERSION,
  TOOL_SCHEMA_VERSION,
  buildInterpretation,
  guardRefusalCode,
  type BackendOutcome,
  type FallbackReason,
} from '../_shared/whatsappTelemetry.ts';
import {
  parseWholeAnimalProcurement,
  wholeAnimalProcurementConfirmation,
} from '../_shared/whatsappWholeAnimalProcurement.ts';
import {
  stockPurchaseCostCancelled,
  stockPurchaseCostChoice,
  stockPurchaseCostQuestion,
  stockPurchaseNewCostQuestion,
  type StockPurchaseCostPending,
} from '../_shared/whatsappStockPurchaseCost.ts';
import {
  parseSupplierCreditPurchase,
  parseSupplierBalanceQuestion,
  parseSupplierPayment,
  supplierPaymentConfirmation,
  type SupplierCreditPurchase,
  type SupplierPayment,
} from '../_shared/whatsappSupplierPayables.ts';
import {
  parseWholeAnimalBreakdown,
  parseWholeAnimalSourceChoice,
  wholeAnimalBreakdownConfirmation,
  wholeAnimalSourceQuestion,
  type WholeAnimalBreakdownCandidate,
  type WholeAnimalBreakdownConfirmationState,
  type WholeAnimalBreakdownOutput,
  type WholeAnimalBreakdownReading,
  type WholeAnimalBreakdownSourceSelection,
} from '../_shared/whatsappWholeAnimalBreakdown.ts';
import { parseCreditQuantitySale } from '../_shared/whatsappCreditSale.ts';
import {
  parseQuantityAnswer,
  parseSaleMissingQuantity,
  quantityNotUnderstood,
  quantityQuestion,
  quantityUnitQuestion,
  type QuantityWanted,
} from '../_shared/whatsappMissingQuantity.ts';
import { lowStockNotice, type StockLevel } from '../_shared/whatsappLowStock.ts';
import {
  formatBarcode, isScanRequest, isSellScanRequest, parseBarcodeMessage,
} from '../_shared/barcode.ts';
import {
  businessReady,
  businessWelcome,
  firstProductsPrompt,
  invitedMemberReady,
  workerOffer,
} from '../_shared/whatsappStarterExamples.ts';
import {
  parseBareExpense,
  parseBareQuantityList,
  parseQuantityOnlySale,
  priceLine,
  quantitySaleConfirmation,
  type QuantitySaleItem,
  quantitySaleMissingPrices,
  type PricedLine,
  type ProductPricing,
  type QuantitySale,
} from '../_shared/whatsappQuantitySale.ts';
import {
  alignPriceBandAnswers,
  applyPriceBands,
  type Band,
  needsBandChoice,
  isPriceBandCancelChoice,
  priceBandCancelled,
  type PriceBandChoice,
  priceBandQuestion,
} from '../_shared/whatsappPriceBand.ts';
import {
  type ComboCandidate,
  type ComboPiece,
  type ComboSplit,
  type SavedCombo,
  applyOrderQuantity,
  comboAmbiguous,
  comboKey,
  comboNotice,
  comboQuestion,
  comboQuestions,
  comboSaveNotAllowed,
  comboSaveOffer,
  comboSaved,
  comboVariantQuestion,
  parseComboAnswer,
  parseComboVariant,
  splitCombo,
} from '../_shared/whatsappCombos.ts';
import {
  cataloguePrefixResolution,
  catalogueTokenResolution,
  nearestCatalogueName,
  normalizeProductReadResolution,
  parseProductChoiceAnswer,
  productChoiceCancelled,
  productReadClarification,
  replaceAskedProduct,
  productReadMatchNotice,
  type ProductReadResolution,
} from '../_shared/whatsappProductResolver.ts';
import {
  buildHypotheticalProfitReply,
  buildPortionHypotheticalProfitReply,
  parseHypotheticalProfitRequest,
  parseHypotheticalQuantity,
} from '../_shared/whatsappHypotheticalProfit.ts';
import {
  hypotheticalPortionQuestion,
  matchHypotheticalPortionAnswer,
  parseQuantityMeaningAnswer,
  quantityMeaningQuestion,
  stockPurchaseNeedsPrices,
  wantsToRegisterNewProducts,
  type HypotheticalPortionChoice,
  type ParkedQuantityMeaning,
} from '../_shared/whatsappConversationMemory.ts';
import {
  parseProductRename,
  productRenameCancelled,
  productRenameConfirmation,
  productRenameSaved,
  type ProductRenamePreview,
} from '../_shared/whatsappProductRename.ts';
import { parseTypedVerificationCode, typedCodeRejected } from '../_shared/typedCode.ts';
import {
  type StockCountBatch,
  parseStockCountBatch,
  stockCountBatchCancelled,
  stockCountBatchConfirmation,
  stockCountBatchSaved,
} from '../_shared/whatsappStockBatch.ts';
import { validateAiEventDirection } from '../_shared/whatsappAiDirection.ts';
import { shopMayAlreadyStock } from '../_shared/whatsappKnownProduct.ts';
import {
  parseSellingPrice,
  priceBandNotice,
  sellingPriceSaved,
} from '../_shared/whatsappSellingPrice.ts';
import {
  sellingPriceReply,
} from '../_shared/whatsappSellingPriceQuestion.ts';
import {
  findUnregisteredMeasure,
  normalizeVoidTarget,
  unregisteredMeasureQuestion,
  voidCancelled,
  voidChoiceQuestion,
  voidConfirmation,
  voidDone,
  voidKindMatches,
  voidNotAllowed,
  voidNothingFound,
  type VoidPending,
  type VoidTarget,
} from '../_shared/whatsappVoid.ts';
import {
  ADVISOR_VOICE,
  advisorBrief,
  advisorEvidence,
  salesTrendReply,
  type AdvisorPayload,
  type TrendProduct,
} from '../_shared/whatsappAdvisor.ts';
import { compareWithTra, fetchTraReceipt } from '../_shared/traVerify.ts';
import { qrCorrectionReply } from '../_shared/qrFollowUp.ts';
import {
  ambiguousStockChangeReply,
  parseAmbiguousStockChange,
  parseStockCount,
  parseOutOfStockQuestion,
  parseStockQuestion,
  outOfStockReply,
  stockCountConfirmation,
  stockListReply,
  stockReply,
} from '../_shared/whatsappStock.ts';
import {
  type ProductCostBatch,
  costBatchCancelled,
  costBatchConfirmation,
  costBatchFailed,
  costBatchSaved,
  parseProductCostBatch,
} from '../_shared/whatsappCostBatch.ts';
import {
  hasExplicitPriceUpdateEvidence,
  validatePriceUpdateCandidate,
} from '../_shared/whatsappPriceUpdateContract.ts';
import {
  type CostPrompt,
  costAccepted,
  costQuestion,
  costSkipped,
  costUnclear,
  isSkip,
  parseCostAnswer,
  toCostPrompt,
} from '../_shared/whatsappCostPrompt.ts';
import {
  dateWordingStatus, type ResolvedRange, isFuture, rangeLabel, resolveDateRange,
  resolveTransactionDate, withinTimeOfDay,
} from '../_shared/whatsappDateRange.ts';
import {
  type LogoutState,
  logoutCancelled,
  logoutConfirmation,
  logoutDisambiguation,
  logoutDone,
  logoutFailed,
  logoutNotLinked,
  logoutReask,
  parseDisambiguationChoice,
  parseLogoutIntent,
} from '../_shared/whatsappLogout.ts';
import {
  accountDeletionDone,
  accountDeletionReask,
  accountDeletionWarning,
  isAccountDeletionCancel,
  isAccountDeletionConfirmation,
  isAccountDeletionRequest,
  type AccountDeletionState,
} from '../_shared/whatsappAccountDeletion.ts';
import {
  canReadCompanyReporting,
  canUseCompanyFinanceReads,
  runConversationalAssistant,
  shouldDeferRecordLikeReply,
  type AssistantHistoryMessage,
  type AssistantIdentityContext,
  sanitizeAssistantFirstName,
  type AssistantToolExecution,
} from '../_shared/whatsappAssistant.ts';
import {
  aiBudgetMessage,
  normalizeAiBudgetDecision,
  type AiBudgetDecision,
} from '../_shared/whatsappAiBudget.ts';
import {
  buildBusinessesReply,
  buildPlansReply,
  buildSubscriptionReply,
  buildBusinessSummaryReply,
  businessSummaryFacts,
  buildDebtorDetailReply,
  buildDebtorsReply,
  buildOwedToMeReply,
  buildPendingApprovalsReply,
  buildPettyCashReply,
  buildProfitReply,
  buildReceiptDetailReply,
  buildReceiptsReply,
  buildInvoiceDetailReply,
  periodDates,
  calculateBusinessSummary,
  calculateDebtors,
  calculateProfitEstimate,
  type ReadDailyLine,
  type ReadDailyRow,
  type ReadProductCost,
  type ReadRequest,
  type ReceiptDetail,
  type InvoiceDetail,
} from '../_shared/whatsappReadTools.ts';
import { buchaReportFacts, buildBuchaReportReply, type BuchaReportingSnapshot } from '../_shared/whatsappBuchaReports.ts';
import {
  type Obligation,
  obligationFacts,
  obligationListReply,
  obligationName,
  obligationSetReply,
} from '../_shared/whatsappObligations.ts';
import {
  type QueuedRecord,
  type RecordQueuePending,
  queueDiscardedReply,
  queueFlushReply,
  queueSavedReply,
  queueTickReply,
} from '../_shared/whatsappRecordQueue.ts';
import {
  calculateDebtorHistories,
  debtorAgeingFacts,
  debtorAgeingReply,
  debtorHistoryFacts,
  debtorHistoryReply,
} from '../_shared/whatsappDebtors.ts';
import {
  type CloseLine,
  type CloseWorker,
  type DayCloseFacts,
  batchHintReply,
  closeReminderReply,
  dayClosedReply,
  dayDraftReply,
  nothingToCloseReply,
  type DayFigures,
  dailyBreakdownFacts,
  trendShapeFacts,
  dailyBreakdownReply,
  ownerDayListReply,
} from '../_shared/whatsappDayClose.ts';
import {
  isProjectSetupState,
  parseProjectSetupChoice,
  parseProjectSetupConfirmation,
  projectSetupConfirmation,
  projectSetupCreatedReply,
  projectSetupNamePrompt,
  projectSetupPrompt,
  projectSetupWorkerReply,
  canCreateProject,
  sanitizeProjectName,
  type ProjectSetupState,
} from '../_shared/whatsappProjectSetup.ts';

type Admin = ReturnType<typeof createClient>;

type ResolvedWhatsAppIdentity = {
  id: string;
  identity_id: string;
  profile_id: string;
  company_id: string;
  company_name: string;
  profile_name: string | null;
  role: string;
  lang: Lang;
  approval_flow_enabled: boolean;
  reversal_enabled: boolean;
  payouts_enabled: boolean;
  revoked_at: string | null;
};

type NewProductSaleSetup = {
  kind: 'new_product_sale_setup';
  missingProducts: string[];
  sale: QuantitySale;
  sourceMessageId: string;
  credit?: { party: string } | null;
  paymentMethod?: QuantityWanted['paymentMethod'];
  occurredAt?: string | null;
};

/**
 * The original sale stays alive when one or more catalogue prices are missing.
 * This lets a later name correction replay the sale instead of making the AI
 * reconstruct it from history alone.
 */
type MissingSalePricesPending = {
  kind: 'sale_missing_prices';
  missingProducts: string[];
  sale: QuantitySale;
  sourceMessageId: string;
  credit?: { party: string } | null;
  paymentMethod?: QuantityWanted['paymentMethod'];
  occurredAt?: string | null;
};

type NewProductOfferSetup = {
  kind: 'new_product_offer_setup';
  missingProducts: string[];
  sourceMessageId: string;
  originalText?: string;
  /**
   * What the trader had already chosen, and every line they typed.
   *
   * MEASURED, and it is why these two fields exist: a message with nine known
   * products and two new ones, answered MANUNUZI, sent only the two new names
   * onward. The other nine were dropped in silence — not refused, not asked
   * about, simply gone, because this state had nowhere to keep them and no
   * memory of what the person had asked for.
   *
   * The rule the owner gave, twice: do the work that can be done, then stop for
   * the part that needs him. Registration is a blockage being cleared, not the
   * end of the road, so what comes after it has to survive it.
   */
  pendingDirection?: 'sale' | 'stock_purchase' | 'stock_count' | 'ask';
  pendingSale?: QuantitySale;
};

/**
 * A sale held while one question is answered: which of the two prices.
 *
 * The whole sale is parked, not just the open lines, because the answer changes
 * the total and the total is what gets confirmed. Nothing is written until the
 * usual NDIYO.
 */
/**
 * A sale held while one combination is explained: which measure, how many.
 *
 * Asked once. What comes back is offered for saving, so a kijiwe answers
 * "chips kuku" one time in its life and never sees the question again.
 */
type ComboPending = {
  kind: 'combo_clarification';
  sale: QuantitySale;
  split: ComboSplit;
  /** Already-settled combinations from earlier turns of the same sale. */
  known: ComboSplit[];
  units: [string, string[]][];
  orders: number;
  sourceMessageId: string;
  credit?: { party: string } | null;
  paymentMethod?: QuantityWanted['paymentMethod'];
  occurredAt?: string | null;
};

/** Offered after the sale is confirmed, to owner and accountant only. */
type ComboSavePending = {
  kind: 'combo_save';
  splits: ComboSplit[];
};

/** "Mishikaki ipi — wa ngombe au wa kuku?" with the sale held behind it. */
type ComboVariantPending = {
  kind: 'combo_variant';
  sale: QuantitySale;
  phrase: string;
  token: string;
  candidates: string[];
  known: ComboSplit[];
  sourceMessageId: string;
  credit?: { party: string } | null;
  paymentMethod?: QuantityWanted['paymentMethod'];
  occurredAt?: string | null;
};

/** Which of two similarly named products he meant, waiting for a number. */
type ProductChoicePending = {
  kind: 'product_read_choice';
  asked: string;
  candidates: string[];
  /** His sentence, replayed once the ambiguity is settled. */
  originalText: string;
  sourceMessageId: string;
  recovery?: { sale: QuantitySale; credit: { party: string } | null; paymentMethod: DailyRecordPaymentMethod | null; occurredAt: string | null };
};

type PriceBandPending = {
  kind: 'price_band_choice';
  sale: QuantitySale;
  choices: PriceBandChoice[];
  /** Bands already settled by an earlier, partial answer. */
  answered: (Band | null)[];
  /** Lines that already had one unambiguous price when this question opened. */
  settled?: PricedLine[];
  sourceMessageId: string;
  credit?: { party: string } | null;
  paymentMethod?: QuantityWanted['paymentMethod'];
  occurredAt?: string | null;
};

/**
 * One confirmation for a message that states both acquisition cost and selling
 * prices.  The old implementation parked these in the same database slot as
 * two unrelated drafts; whichever tool finished last won, which is how a
 * reply of `1` could save cost=5000 instead of the selling prices 8000/7500.
 */
type PriceAndCostPending = {
  kind: 'price_and_cost_pending';
  prices: SellingPrice[];
  costs: ProductCost[];
  unreadable: string[];
  clarification?: {
    reason: 'purchase_unit' | 'product_identity' | 'purchase_unit_and_product_identity';
    product: string;
    unitOptions: string[];
    productCandidates: string[];
  };
};

type NewProductPricingState = {
  kind: 'new_product_pricing';
  products: NewProductPricing[];
  pendingSale?: QuantitySale;
  sourceMessageId?: string;
  credit?: { party: string } | null;
  paymentMethod?: QuantityWanted['paymentMethod'];
  occurredAt?: string | null;
  /**
   * What the trader answered before the registration interrupted them.
   *
   * MEASURED, and the owner found it by asking rather than by being burned:
   * "kama hapa nikijibu manunuzi je ai itajua manunuzi kwa bidhaa zote au hizo
   * mpya?" Neither. It knew about all of them and would have written every one
   * of them down as a SALE — priceQuantitySale builds `kind: 'sale'`, and the
   * resume path had no idea a direction had ever been chosen.
   *
   * A registration is an interruption. Everything the person had already
   * decided has to survive it, and the decision is the part that says whether
   * money came in or went out.
   */
  pendingDirection?: 'sale' | 'stock_purchase' | 'stock_count' | 'ask';
};

type NewProductQuantityState = Omit<NewProductPricingState, 'kind'> & {
  kind: 'new_product_quantity';
};

type NewProductRegistrationConfirmationState = Omit<NewProductPricingState, 'kind'> & {
  kind: 'new_product_registration_confirmation';
  stock: NewProductStock[];
};

function transactionDateQuestion(reason: 'future' | 'range', lang: Lang): string {
  if (reason === 'future') {
    return lang === 'sw'
      ? 'Siwezi kurekodi mauzo ya tarehe ya baadaye. Taja tarehe iliyopita au leo.'
      : 'I cannot record a sale in the future. State a past date or today.';
  }
  return lang === 'sw'
    ? 'Taja siku moja kamili ya mauzo haya, kwa mfano: jana au tarehe 7 Mei 2025.'
    : 'State one exact day for this sale, for example: yesterday or 7 May 2025.';
}

/**
 * Prices a quantities-only sale from the shop's own price list.
 *
 * Every name is resolved the same forgiving way a read is, so "nguvu ya sala"
 * typed six different ways still finds the price that was set for it. A product
 * with no price is named on its own — the sale is refused whole rather than
 * saved half-priced, because a sale missing a line is a sale nobody can audit.
 */
async function priceQuantitySale(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  sale: QuantitySale,
  lang: Lang,
  /**
   * Combinations already settled in this conversation.
   *
   * Consulted before the catalogue, so an answer given a moment ago is not
   * asked for again: without this, re-pricing after "kuku nusu" would read
   * "chips kuku" from scratch and ask which measure all over again.
   */
  known: ComboSplit[] = [],
  /**
   * Set when the goods left on credit.
   *
   * The ONLY thing it changes is how the record is classified and whose name
   * goes on it. Which product, which measure and what it is worth are worked
   * out identically either way — a sale on deni is a sale of the same goods at
   * the same price, and pricing it down a second path would be how the two
   * quietly drift apart.
   */
  credit: { party: string } | null = null,
  occurredAt: string | null = null,
): Promise<
  | { kind: 'priced'; record: ParsedDailyRecord; lines: PricedLine[]; notCounted: string[]; combos: ComboSplit[] }
  | { kind: 'blocked'; message: string; choice?: { asked: string; candidates: string[] } }
  | { kind: 'unknown'; products: string[]; sale: QuantitySale; resolvedProducts: string[] }
  // Both prices registered, the line named neither, and the quantity does not
  // settle it. Guessing here is guessing at the takings.
  | { kind: 'band'; choices: PriceBandChoice[]; sale: QuantitySale; settled?: PricedLine[] }
  // "chips kuku" — the shop sells chicken by robo, nusu and kilo, and the order
  // named none of them. Three thousand or ten thousand for the same word.
  | { kind: 'combo_question'; splits: ComboSplit[]; sale: QuantitySale; units: [string, string[]][] }
  // "mishikaki" where the shop sells wa ngombe and wa kuku. Which one is the
  // price, so which one is asked.
  | { kind: 'combo_variant'; phrase: string; token: string; candidates: string[]; sale: QuantitySale }
  | { kind: 'skip' }
> {
  const { data: declaredRows, error: declaredError } = await db.rpc('wa_company_product_sale_units', {
    p_company_id: identity.company_id,
  });
  // Rolling deploy safety: if the DB migration is not visible yet, ordinary
  // one-unit products keep using the old pricing path. Portion sales simply do
  // not activate until both halves are present.
  const declaredUnits: DeclaredSaleUnit[] = (declaredError
    ? []
    : (declaredRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    productKey: String(row.product_key),
    productName: String(row.product_name),
    unitKey: String(row.unit_key),
    unitName: String(row.unit_name),
    baseQuantity: Number(row.base_quantity),
    retail: row.retail_price == null ? null : Number(row.retail_price),
    wholesale: row.wholesale_price == null ? null : Number(row.wholesale_price),
    wholesaleMinQty: row.wholesale_min_qty == null ? null : Number(row.wholesale_min_qty),
  }));
  const resolvedItems: {
    key: string;
    name: string;
    quantity: number;
    band: QuantitySaleItem['band'];
    declared: DeclaredSaleUnit | null;
    /** Where this came from in the message, so an answer lands on the right line. */
    at: number;
    /** Set when this line is one piece of a combination such as "chips yai". */
    piece?: ComboPiece;
  }[] = [];
  // Named back to the shopkeeper, never silently dropped: a line missing from a
  // till roll is money they believe they took and Risip does not.
  const unknown: string[] = [];
  /** Phrases read as several products, shown back before anything is saved. */
  const combos: ComboSplit[] = [];
  for (const [at, item] of sale.items.entries()) {
    // ── a measure the trader said out loud ────────────────────────────────
    //
    // "vifuko 4 vya mbwa" arrives here as goods "mbwa" with the measure
    // "kifuko" beside it. The alias resolver turns the wording into the
    // catalogue's own name, and then the SAME declared-unit matcher that has
    // always handled "nyama ya ngombe mishikaki" finds the configured measure.
    // No second lookup, no Bucha branch.
    if (item.spokenUnit && item.productWithoutUnit) {
      const named = await resolveProductForRead(db, identity, item.productWithoutUnit);
      if (!named.error && named.resolution.kind === 'matched') {
        const canonical = named.resolution.match;
        const viaUnit = matchDeclaredSaleUnit(
          `${canonical.productName} ${item.spokenUnit}`, declaredUnits);
        if (viaUnit.kind === 'matched') {
          resolvedItems.push({
            key: viaUnit.unit.productKey,
            name: viaUnit.unit.productName,
            quantity: item.quantity,
            band: item.band,
            declared: viaUnit.unit,
            at,
          });
          continue;
        }
      }
    }
    const portion = matchDeclaredSaleUnit(item.product, declaredUnits);
    if (portion.kind === 'unit_required') {
      return {
        kind: 'blocked',
        message: portionUnitRequired(portion.productName, portion.units, lang),
      };
    }
    if (portion.kind === 'matched') {
      resolvedItems.push({
        key: portion.unit.productKey,
        name: portion.unit.productName,
        quantity: item.quantity,
        band: item.band,
        declared: portion.unit,
        at,
      });
      continue;
    }
    const resolved = await resolveProductForRead(db, identity, item.product);
    if (resolved.error) return { kind: 'skip' };
    if (resolved.resolution.kind === 'ambiguous') {
      return {
        kind: 'blocked',
        message: productReadClarification(resolved.resolution, lang),
        // Carried out so the caller can park it and read the number himself.
        choice: {
          asked: resolved.resolution.asked,
          candidates: resolved.resolution.candidates.slice(0, 3).map((one) => one.productName),
        },
      };
    }
    if (resolved.resolution.kind === 'not_found') {
      // "chips yai", "chipssosej", "zege" — goods the shop DOES sell, written
      // the way they are shouted across a counter. Only tried once the ordinary
      // lookup has failed, and only against this company's own catalogue, so it
      // can never invent a product nobody sells.
      const reading = known.find((split) => comboKey(split.phrase) === comboKey(item.product))
        ?? await readCombo(db, identity, item.product);
      if (reading && 'token' in reading) {
        // "mishikaki" where the shop registered wa ngombe AND wa kuku. Which
        // one decides the price, so it is asked — and only ever asked where the
        // shop really did register more than one.
        return reading.candidates.length > 1
          ? { kind: 'combo_variant', phrase: item.product, token: reading.token, candidates: reading.candidates, sale }
          : { kind: 'blocked', message: comboAmbiguous(item.product, reading.token, lang) };
      }
      if (reading) {
        // Where the number belongs: "chips yai mbili" is one plate with two
        // eggs in it, while "zege mbili" is two zege. See applyOrderQuantity.
        const counted = applyOrderQuantity(reading, item.quantity);
        combos.push(counted.split);
        for (const piece of counted.split.pieces) {
          resolvedItems.push({
            key: piece.key,
            name: piece.name,
            quantity: counted.orders * piece.quantity,
            band: item.band,
            declared: piece.unit
              ? declaredUnits.find((unit) =>
                unit.productKey === piece.key && comboKey(unit.unitName) === comboKey(piece.unit ?? '')) ?? null
              : null,
            at,
            piece,
          });
        }
        continue;
      }
      unknown.push(item.product);
      continue;
    }
    // ── no measure stated, and the shop configured some ───────────────────
    //
    // "za mbwa 3" says how many and not of what measure. Where the shop has
    // declared exactly ONE way of selling this product there is nothing to
    // guess — that is the only answer it could be. Where it declared several,
    // the difference between a kilo and a piece is the difference between two
    // thousand shillings and two hundred, so it is asked.
    //
    // Nothing here is inferred from the KIND of business. It is inferred from
    // what this shop configured, or not at all.
    const forProduct = declaredUnits.filter(
      (unit) => unit.productKey === resolved.resolution.match.productKey);
    if (!item.spokenUnit && forProduct.length > 1) {
      return {
        kind: 'blocked',
        message: portionUnitRequired(
          resolved.resolution.match.productName, forProduct.map((unit) => unit.unitName), lang),
      };
    }
    if (!item.spokenUnit && forProduct.length === 1) {
      resolvedItems.push({
        key: forProduct[0].productKey,
        name: forProduct[0].productName,
        quantity: item.quantity,
        band: item.band,
        declared: forProduct[0],
        at,
      });
      continue;
    }
    resolvedItems.push({
      key: resolved.resolution.match.productKey,
      name: resolved.resolution.match.productName,
      quantity: item.quantity,
      // Carried through. Without this the word somebody typed at the end of the
      // line — "jumla" — is read, understood, and then quietly dropped here.
      band: item.band,
      declared: null,
      at,
    });
  }

  // A catalogue miss is never converted into an anonymous sale and never
  // omitted from a multi-line sale. Registration and its own confirmation come
  // first; the original sale is resumed afterwards.
  if (unknown.length > 0) {
    return {
      kind: 'unknown',
      products: unknown,
      sale,
      // Keep the lines the backend did resolve visible to the next response.
      // The unresolved lines still block the draft, so this is acknowledgement
      // rather than a partial financial write.
      resolvedProducts: [...new Set(resolvedItems.map((item) => item.name))],
    };
  }

  // A combination that left something unsaid is asked about ONCE, before any
  // price is worked out — and the answer is what gets remembered.
  const openCombos = combos.filter((split) => comboQuestions(split).length > 0);
  if (openCombos.length > 0) {
    const units = new Map<string, string[]>();
    for (const unit of declaredUnits) {
      units.set(unit.productKey, [...(units.get(unit.productKey) ?? []), unit.unitName]);
    }
    return { kind: 'combo_question', splits: openCombos, sale, units: [...units.entries()] };
  }

  // ── a declared measure with no price of its own ──────────────────────────
  //
  // A kifuko that holds a kilo carries no price, because the kilo has one.
  // wa_price_sale_unit (0126) derives it — quantity x conversion x the base
  // unit's price — with ONE formula that serves boxes, packets and bags alike.
  //
  // Called here rather than computed here. The webhook never divides or
  // multiplies money: it asks the database what a measure is worth and puts
  // the answer on the line.
  for (const item of resolvedItems) {
    if (!item.declared || (occurredAt === null && item.declared.retail !== null)) continue;
    const { data: derived } = await db.rpc('wa_price_sale_unit', {
      p_company_id: identity.company_id,
      p_product: item.declared.productName,
      p_unit: item.declared.unitName,
      p_quantity: item.quantity,
      ...(occurredAt ? { p_priced_at: occurredAt } : {}),
    });
    const row = ((derived ?? []) as Array<Record<string, unknown>>)[0];
    const unitPrice = row?.unit_price == null ? null : Number(row.unit_price);
    if (unitPrice !== null && Number.isFinite(unitPrice) && unitPrice > 0) {
      item.declared = {
        ...item.declared,
        retail: unitPrice,
        wholesale: row?.wholesale_price == null ? null : Number(row.wholesale_price),
        wholesaleMinQty: row?.wholesale_min_qty == null ? null : Number(row.wholesale_min_qty),
      };
    } else if (occurredAt) {
      item.declared = { ...item.declared, retail: null, wholesale: null, wholesaleMinQty: null };
    }
  }

  const { data, error } = await db.rpc('wa_product_pricing', {
    p_company_id: identity.company_id,
    p_product_keys: resolvedItems.filter((item) => !item.declared).map((item) => item.key),
    ...(occurredAt ? { p_priced_at: occurredAt } : {}),
  });
  if (error) return { kind: 'skip' };

  const pricing = new Map<string, ProductPricing>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    pricing.set(String(row.product_key), {
      retail: row.retail_price == null ? null : Number(row.retail_price),
      wholesale: row.wholesale_price == null ? null : Number(row.wholesale_price),
      wholesaleMinQty: row.wholesale_min_qty == null ? null : Number(row.wholesale_min_qty),
    });
  }

  const lines: PricedLine[] = [];
  const missing: string[] = [];
  // Lines where the shop has two prices and the message picked neither.
  const open: PriceBandChoice[] = [];
  for (const item of resolvedItems) {
    const known = item.declared
      ? {
        retail: item.declared.retail,
        wholesale: item.declared.wholesale,
        wholesaleMinQty: item.declared.wholesaleMinQty,
      }
      : pricing.get(item.key) ?? { retail: null, wholesale: null, wholesaleMinQty: null };
    if (needsBandChoice(item.band, known, item.quantity)) {
      open.push({
        index: item.at,
        product: item.name,
        quantity: item.quantity,
        retail: known.retail as number,
        wholesale: known.wholesale as number,
        ...(item.declared ? { unit: item.declared.unitName } : {}),
      });
    }
    const line = priceLine({
      product: item.name,
      quantity: item.quantity,
      band: item.band,
      ...(item.declared ? { unit: item.declared.unitName } : {}),
    }, known);
    if (!line) { if (!missing.includes(item.name)) missing.push(item.name); continue; }
    if (item.declared) line.baseQuantity = item.declared.baseQuantity;
    // Merged only now, and only across lines that reached the SAME price. Two
    // sales of the same product at two different prices are two facts, and
    // adding them before pricing is what turned four retail sales of daftari
    // into one wholesale sale of forty-eight.
    const at = lines.findIndex((seen) => seen.product === line.product
      && seen.unitPrice === line.unitPrice && (seen.unit ?? null) === (line.unit ?? null));
    if (at >= 0) lines[at] = { ...lines[at], quantity: lines[at].quantity + line.quantity };
    else lines.push(line);
  }
  if (missing.length > 0 || lines.length === 0) {
    const message = occurredAt
      ? (lang === 'sw'
        ? `Hakuna bei halali ya ${missing.map((name) => `*${name}*`).join(', ')} kwa tarehe hiyo. Weka bei ya tarehe hiyo kwanza; sijatumia bei ya leo.`
        : `There is no valid price for ${missing.map((name) => `*${name}*`).join(', ')} on that date. Add a price effective on that date first; I did not use today's price.`)
      : quantitySaleMissingPrices(missing, lang);
    return { kind: 'blocked', message };
  }
  // Asked after the missing-price check, because a product with no price at all
  // is the bigger problem and its message says so. One question, listing only
  // the open lines — never one question per line.
  // The owner's instruction, and it is about not wasting his work: "isikatishe
  // bidhaa nyingine ifanye mahesabu then ndio isime hizi bidhaa zina bei
  // mbili." Two prices on two products is not a reason to go silent about the
  // other seven. Everything that priced cleanly is carried into the question
  // with its total, so he can see the arithmetic happened and only has to
  // think about the ones that genuinely need him.
  if (open.length > 0) {
    const settled = lines.filter(
      (line) => !open.some((choice) => choice.product === line.product),
    );
    return { kind: 'band', choices: open, sale, settled };
  }

  const amount = Math.round(lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0) * 100) / 100;
  return {
    kind: 'priced',
    lines,
    notCounted: [],
    combos,
    record: {
      // A credit sale differs here and nowhere else in this function.
      kind: credit ? 'debt_issued' : 'sale',
      amount,
      partyName: credit?.party ?? null,
      description: null,
      lines: lines.map((line) => ({
        description: line.product,
        quantity: line.quantity,
        unit_amount: line.unitPrice,
        ...(line.unit ? { unit: line.unit } : {}),
      })),
      confidence: 0.99,
      occurredAt,
    },
  };
}

/**
 * Reads a phrase as several of THIS company's products, or null.
 *
 * The catalogue is the dictionary, so a split can only ever produce goods the
 * shop actually sells. Portion units come along because "kuku" priced by robo,
 * nusu and kilo cannot be read without knowing which one was meant.
 */
async function readCombo(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  phrase: string,
): Promise<ComboSplit | { kind: 'ambiguous'; token: string; candidates: string[] } | null> {
  const [names, units, saved] = await Promise.all([
    db.rpc('company_product_names', { p_company_id: identity.company_id }),
    db.rpc('wa_company_product_sale_units', { p_company_id: identity.company_id }),
    db.rpc('wa_company_combos', { p_company_id: identity.company_id }),
  ]);
  if (names.error) return null;

  const unitsByProduct = new Map<string, string[]>();
  for (const row of (units.error ? [] : units.data ?? []) as Array<Record<string, unknown>>) {
    const key = String(row.product_key);
    unitsByProduct.set(key, [...(unitsByProduct.get(key) ?? []), String(row.unit_name)]);
  }

  const catalogue: ComboCandidate[] = ((names.data ?? []) as Array<Record<string, unknown>>)
    .map((row) => String(row.product_name ?? '').trim())
    .filter(Boolean)
    .map((name) => {
      const key = productKey(name);
      return { key, name, ...(unitsByProduct.has(key) ? { units: unitsByProduct.get(key) } : {}) };
    });

  const nicknames: SavedCombo[] = ((saved.error ? [] : saved.data ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({
      name: String(row.name ?? ''),
      pieces: (Array.isArray(row.pieces) ? row.pieces : []) as SavedCombo['pieces'],
    }))
    // A one-piece recipe is a PORTION, not a nickname: "mshikaki = nyama ya
    // ngombe, kilo 0.055". 0114 required two pieces because a nickname for a
    // single product is just that product renamed — but a portion is a
    // different thing, and forty skewers must take 2.2 kilos off the shelf.
    // splitCombo returns a saved nickname before its own two-piece rule, so
    // this filter was the last gate standing in the way (see 0119).
    .filter((combo) => combo.name && combo.pieces.length >= 1);

  return splitCombo(phrase, catalogue, nicknames);
}

/**
 * The offer to add what could not be priced, appended to a sale confirmation.
 *
 * Naming a product Risip cannot price was already better than dropping it, but
 * it left the shopkeeper to work out on their own that they now had to go and
 * invent a price somewhere else before that sale could ever be recorded. This
 * finishes the sentence.
 */
function offerNewProducts(notCounted: string[], lang: Lang): string {
  return notCounted.length === 0 ? '' : newProductOffer(notCounted, lang);
}

/**
 * Has the person moved on to something else entirely?
 *
 * A question Risip asked keeps the conversation until it is answered, which is
 * right until somebody simply wants to do something different. Then it becomes
 * a trap: every message is read as a wrong answer and the same question comes
 * back, which is what "change language to kiswahili" got.
 *
 * Only unmistakable topic changes count. A vague reply is still a bad answer to
 * the question, and re-asking it is the correct thing to do.
 */
/**
 * Should a parked NDIYO/HAPANA question let go of this message?
 *
 * MEASURED FAILURE, four times in four different branches. Each parked state
 * treated every message that was not its own answer as a bad answer and re-sent
 * the same question — the invite did it, the portion setup did it, the new
 * product did it, and a pending price list answered "duster ziko ngapi stoo"
 * with a price list. Fixing them one at a time was the mistake; this is the
 * rule, and every branch uses it.
 *
 * A confirmation, a rejection or a cancel is always an answer, whatever else it
 * may look like. Everything else that plainly starts another subject releases.
 */
function releasesParkedQuestion(text: string): boolean {
  if (isDailyRecordConfirmation(text) || isDailyRecordRejection(text) || isCancel(text)) return false;
  // Everything else releases. This used to ask startsAnotherTopic — "is this
  // one of the subjects I recognise?" — and a correction that named no product
  // and no known subject was on no list, so the shop was asked the same
  // question again, and again. There is no list to maintain here: a message
  // that is not the answer is a new turn, and new turns belong to the model.
  return true;
}

/**
 * A model outage must not become a fake conversation turn. Give the trader a
 * useful, context-aware next question and keep this operational message out of
 * assistant history, so a future model call does not learn the wrong context.
 */
function assistantClarificationQuestion(
  lang: Lang,
  body: string | null | undefined,
  pending: PendingClarification | null,
): string {
  if (pending?.field === 'price_band') {
    return lang === 'sw'
      ? 'Nimepokea jibu lako, lakini sijaliunganisha na bei ya mauzo. Chagua (a) *REJAREJA*, (b) *JUMLA*, au (c) *GHAIRI*.'
      : 'I received your answer, but could not attach it to the selling price. Choose (a) *RETAIL*, (b) *WHOLESALE*, or (c) *CANCEL*.';
  }
  if (pending?.field === 'quantity') {
    const product = pending.product ? ` ya *${pending.product}*` : '';
    return lang === 'sw'
      ? `Nimepokea ujumbe wako kuhusu quantity${product}, lakini sijapata kiasi na kipimo salama. Andika kwa mfano: *${pending.product ?? 'bidhaa'} vipande 5*, *kilo 2.5* au *lita 0.5*.`
      : `I received your quantity message${product}, but could not identify a safe amount and unit. Write for example: *${pending.product ?? 'product'} 5 pieces*, *2.5 kilos* or *0.5 litres*.`;
  }
  if (pending?.field === 'event_type') {
    return lang === 'sw'
      ? 'Nimeona orodha ya bidhaa, lakini sijui unataka nifanye nini: (a) *MAUZO*, (b) *ONGEZA STOCK*, au (c) *SAJILI BIDHAA*?'
      : 'I see a product list, but I need the action: (a) *SALES*, (b) *ADD STOCK*, or (c) *REGISTER PRODUCTS*?';
  }
  const excerpt = String(body ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return lang === 'sw'
    ? `Nimepokea “${excerpt}”, lakini sitaki kukisia hatua unayotaka. Unataka (a) kurekodi mauzo, (b) kuongeza stock, (c) kusajili bidhaa, au (d) kupata taarifa?`
    : `I received “${excerpt}”, but I do not want to guess the action. Do you want (a) record a sale, (b) add stock, (c) register products, or (d) get information?`;
}


/**
 * Decide "total or each?" from the shop's own price list instead of asking.
 *
 * "nimeuza ugali 2 3000" has two readings — 3,000 each, or 3,000 for both. A
 * shopkeeper who priced ugali last week finds the question absurd, and they are
 * right: only one of the two readings matches what they charge.
 *
 * Null means the question still deserves asking. That is the case when the
 * product is unknown, when it has no saved price, when BOTH readings match
 * (a price of exactly half the total is a real coincidence, not a decision to
 * make on somebody's behalf), and when neither does.
 */
async function settlePriceAmbiguity(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  draft: DailyRecordClarification,
): Promise<DailyRecordParse | null> {
  const sale = draft.sale;
  if (!sale || !(sale.quantity > 1) || !(sale.amount > 0)) return null;

  const resolved = await resolveProductForRead(db, identity, sale.description);
  if (resolved.error || resolved.resolution.kind !== 'matched') return null;

  const { data, error } = await db.rpc('wa_product_pricing', {
    p_company_id: identity.company_id,
    p_product_keys: [resolved.resolution.match.productKey],
  });
  if (error) return null;
  const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
  if (!row) return null;

  const prices = [row.retail_price, row.wholesale_price]
    .filter((value) => value != null)
    .map((value) => Number(value))
    .filter((value) => value > 0);
  if (prices.length === 0) return null;

  // Two percent, so a rounded price still lands. Anything looser starts
  // agreeing with numbers the shop never chose.
  const matches = (value: number) => prices.some((price) => Math.abs(value - price) <= price * 0.02);
  const perItemReading = matches(sale.amount);
  const totalReading = matches(sale.amount / sale.quantity);
  if (perItemReading === totalReading) return null;

  return resumeDailyRecordClarification(draft, perItemReading ? 'unit_price' : 'total');
}

/**
 * What the sale just emptied, if anything.
 *
 * Only the products that sale touched. A warning listing everything low in the
 * shop, every time, is a warning nobody reads by the third day. Best effort
 * throughout: a sale is recorded whether or not this can be worked out.
 */
async function lowStockNoticeFor(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  record: ParsedDailyRecord,
  lang: Lang,
): Promise<string> {
  if (record.kind !== 'sale' || record.lines.length === 0) return '';
  try {
    const levels: StockLevel[] = [];
    for (const line of record.lines.slice(0, 12)) {
      const resolved = await resolveProductForRead(db, identity, line.description);
      if (resolved.error || resolved.resolution.kind !== 'matched') continue;
      const { data } = await db.rpc('wa_stock_on_hand', {
        p_company_id: identity.company_id,
        p_product: resolved.resolution.match.productKey,
      });
      const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
      if (!row) continue;
      levels.push({
        productName: String(row.product_name ?? resolved.resolution.match.productName),
        onHand: Number(row.on_hand ?? 0),
        unit: row.unit ? String(row.unit) : null,
        hasCount: Boolean(row.has_count),
        producedSince: Number(row.produced_since ?? 0),
      });
    }
    return lowStockNotice(levels, lang);
  } catch {
    return '';
  }
}

async function resolveProductForRead(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  asked: string,
): Promise<{ resolution: ProductReadResolution; error: boolean }> {
  const { data, error } = await db.rpc('wa_resolve_company_product_read', {
    p_profile_id: identity.profile_id,
    p_company_id: identity.company_id,
    p_name: asked,
  });
  const resolution = normalizeProductReadResolution(data, asked);
  if (error || resolution.kind !== 'not_found') return { resolution, error: Boolean(error) };

  // The database found nothing. Before saying so, try the shop's own list for a
  // name one keystroke away — "altasi" for atlasi, "gunid" for gundi. See
  // nearestCatalogueName: one edit, one candidate, or nothing.
  const { data: catalogue } = await db.rpc('company_product_names', { p_company_id: identity.company_id });
  const names = ((catalogue ?? []) as Array<Record<string, unknown>>)
    .map((row) => String(row.product_name ?? '').trim())
    .filter(Boolean);
  const near = nearestCatalogueName(asked, names);
  if (near) {
    return {
      resolution: {
        kind: 'matched',
        asked,
        match: { productKey: productKey(near), productName: near, matchKind: 'trigram', matchScore: 0.99 },
      },
      error: false,
    };
  }

  // A short word can be a perfectly good company-scoped reference even when
  // it is not an edit of the full catalogue name: "feni" should resolve to
  // the one product whose name starts with it. The shared helper deliberately
  // returns ambiguity when the same prefix names two real products, so this
  // can never turn a partial name into a guess.
  const byPrefix = cataloguePrefixResolution(asked, names);
  if (byPrefix) return { resolution: { ...byPrefix, asked }, error: false };

  // Last rung before "I do not have that". A trader almost never types a
  // product's full registered name — they type the word they call it by, and
  // that word is usually one of the words IN the name. "Antoni" for "Anton wa
  // Padua". Ambiguity comes back as ambiguity, never as the closest guess.
  const byToken = catalogueTokenResolution(asked, names);
  if (byToken) return { resolution: { ...byToken, asked }, error: false };

  return { resolution, error: false };
}

function admin(): Admin {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) throw new Error('server misconfigured');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function resolveWhatsAppContext(
  db: Admin,
  rawIdentity: { id: string; revoked_at?: string | null } | null,
): Promise<ResolvedWhatsAppIdentity | null> {
  if (!rawIdentity?.id) return null;
  const { data, error } = await db.rpc('wa_resolve_context', { p_identity_id: rawIdentity.id });
  if (error || !data || typeof data !== 'object') return null;
  const value = data as Record<string, unknown>;
  if (!value.profile_id || !value.company_id || !value.identity_id) return null;
  return {
    id: String(value.identity_id),
    identity_id: String(value.identity_id),
    profile_id: String(value.profile_id),
    company_id: String(value.company_id),
    company_name: String(value.company_name ?? 'Risip business'),
    profile_name: typeof value.profile_name === 'string' ? value.profile_name : null,
    role: String(value.role ?? 'worker'),
    lang: value.lang === 'sw' ? 'sw' : 'en',
    approval_flow_enabled: value.approval_flow_enabled === true,
    reversal_enabled: value.reversal_enabled === true,
    payouts_enabled: value.payouts_enabled === true,
    revoked_at: rawIdentity.revoked_at ?? null,
  };
}

/**
 * The shop's own words, fetched once per assistant turn and capped.
 *
 * Bounded on purpose: aliases are cheap and are the whole point, but a
 * catalogue dump would grow every request for every company for ever. Words
 * only — the financial values stay behind tools.
 */
async function loadVocabularyContext(db: Admin, identity: ResolvedWhatsAppIdentity): Promise<{ vocabulary: string; catalogue: string; health: RetrievalHealth }> {
  const [vocabularyRows, productRows, unitRows] = await Promise.all([
    db.rpc('wa_company_vocabulary', { p_company_id: identity.company_id }),
    db.rpc('company_product_names', { p_company_id: identity.company_id }),
    db.from('product_units')
      .select('product_key, product_name, unit_name, base_quantity, is_base, can_purchase, can_sell, can_count')
      .eq('company_id', identity.company_id)
      .limit(500),
  ]);
  const vocabulary = vocabularyRows.error ? '' : vocabularyContext(((vocabularyRows.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    kind: String(row.kind ?? ''),
    term: String(row.term ?? ''),
    productName: row.product_name ? String(row.product_name) : null,
    meaning: row.meaning ? String(row.meaning) : null,
  })));
  const productRowsData = (productRows.error ? [] : (productRows.data ?? []) as Array<Record<string, unknown>>);
  const products = productRowsData
    .map((row) => String(row.product_name ?? '').trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 60);
  const catalogue = products.length > 0
    ? `Products registered by this business (names only):\n${products.map((name) => `- ${name}`).join('\n')}`
    : '';

  const namesByKey = new Map(products.map((name) => [productKey(name), name]));
  const unitProducts = new Map<string, CatalogueContextProduct>();
  for (const product of products) {
    const key = productKey(product);
    if (key) unitProducts.set(key, { product, units: [] });
  }
  for (const row of (unitRows.error ? [] : (unitRows.data ?? []) as Array<Record<string, unknown>>)) {
    const key = productKey(String(row.product_key ?? row.product_name ?? ''));
    const product = namesByKey.get(key) ?? String(row.product_name ?? '').trim();
    if (!key || !product) continue;
    const current = unitProducts.get(key) ?? { product, units: [] };
    current.units.push({
      name: String(row.unit_name ?? '').trim(),
      canPurchase: row.can_purchase === true,
      canSell: row.can_sell === true,
      canCount: row.can_count !== false,
      baseQuantity: Number(row.base_quantity ?? 0),
      isBase: row.is_base === true,
    });
    unitProducts.set(key, current);
  }

  const { data: pricingRows, error: pricingError } = await db.rpc('wa_product_pricing', {
    p_company_id: identity.company_id,
    p_product_keys: products.map((name) => productKey(name)),
  });
  for (const row of (pricingError ? [] : (pricingRows ?? []) as Array<Record<string, unknown>>)) {
    const key = productKey(String(row.product_key ?? ''));
    const product = namesByKey.get(key);
    if (!key || !product) continue;
    const current = unitProducts.get(key) ?? { product, units: [] };
    current.retailPrice = row.retail_price == null ? null : Number(row.retail_price);
    current.wholesalePrice = row.wholesale_price == null ? null : Number(row.wholesale_price);
    current.wholesaleMinQty = row.wholesale_min_qty == null ? null : Number(row.wholesale_min_qty);
    current.unitCost = row.unit_cost == null ? null : Number(row.unit_cost);
    unitProducts.set(key, current);
  }
  const catalogueRag = formatCatalogueContext([...unitProducts.values()], {
    includeCosts: canUseCompanyFinanceReads(identity.role),
  });
  const health: RetrievalHealth = {
    vocabulary: vocabularyRows.error ? 'unavailable' : 'partial',
    products: productRows.error ? 'unavailable' : productRowsData.length > products.length ? 'partial' : 'available',
    units: unitRows.error ? 'unavailable' : (unitRows.data?.length ?? 0) >= 500 ? 'partial' : 'available',
    prices: pricingError ? 'unavailable' : 'partial',
  };
  return {
    vocabulary: [vocabulary, catalogue].filter(Boolean).join('\n\n').slice(0, 6000),
    catalogue: [retrievalHealthContext(health), catalogueRag].filter(Boolean).join('\n\n'),
    health,
  };
}

function assistantIdentityContext(
  identity: ResolvedWhatsAppIdentity,
  vocabulary?: string,
  // A model cannot recognise the answer to a question it was never shown. That
  // is exactly why "reja" used to need a parser standing in front of it.
  pending?: PendingClarification | null,
  catalogueContext?: string,
): AssistantIdentityContext {
  return {
    identityId: identity.id,
    profileId: identity.profile_id,
    companyId: identity.company_id,
    companyName: identity.company_name,
    userName: sanitizeAssistantFirstName(identity.profile_name),
    role: identity.role,
    lang: identity.lang,
    approvalFlowEnabled: identity.approval_flow_enabled,
    reversalEnabled: identity.reversal_enabled,
    payoutsEnabled: identity.payouts_enabled,
    ...(vocabulary ? { vocabulary } : {}),
    ...(catalogueContext ? { catalogueContext } : {}),
    ...(pending ? { pendingClarification: describePending(pending) ?? undefined } : {}),
  };
}

function normalizedChoice(value: string): string {
  return productKey(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function chooseClarificationValue(body: string, choices: string[]): string | null {
  const text = body.trim();
  const number = /^(?:choice\s*)?(\d{1,2})$/iu.exec(text);
  if (number) {
    const selected = choices[Number(number[1]) - 1];
    if (selected) return selected;
  }
  const key = normalizedChoice(text);
  return choices.find((choice) => normalizedChoice(choice) === key) ?? null;
}

async function purchaseUnitsForProducts(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
): Promise<Map<string, string[]>> {
  const { data, error } = await db.from('product_units')
    .select('product_key, unit_name, can_purchase')
    .eq('company_id', identity.company_id)
    .eq('can_purchase', true)
    .limit(500);
  if (error) return new Map();
  const units = new Map<string, string[]>();
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const product = productKey(String(row.product_key ?? ''));
    const unit = String(row.unit_name ?? '').trim().slice(0, 40);
    if (!product || !unit) continue;
    const current = units.get(product) ?? [];
    if (!current.some((item) => normalizedChoice(item) === normalizedChoice(unit))) current.push(unit);
    units.set(product, current);
  }
  return units;
}

function priceAndCostClarificationText(
  clarification: NonNullable<PriceAndCostPending['clarification']>,
  lang: Lang,
): string {
  const productQuestion = clarification.productCandidates.length > 0
    ? ambiguousProductQuestion(clarification.product, clarification.productCandidates, lang)
    : isSemanticallyAmbiguousProduct(clarification.product)
      ? ambiguousProductQuestion(clarification.product, [], lang)
      : '';
  if (productQuestion && clarification.unitOptions.length > 0) {
    return `${productQuestion}\n\n${lang === 'sw'
      ? 'Baada ya kuchagua bidhaa, tutauliza pia kipimo cha kununulia.'
      : 'After choosing the product, I will also ask for its purchase unit.'}`;
  }
  if (productQuestion) return productQuestion;
  return unitChoiceQuestion(clarification.product, clarification.unitOptions, lang);
}

function priceAndCostConfirmation(pending: PriceAndCostPending, lang: Lang): string {
  const batch: SellingPriceBatch = {
    kind: 'selling_price_batch',
    prices: pending.prices,
    unreadable: pending.unreadable,
  };
  const priceQuestion = sellingPriceBatchConfirmation(batch, lang);
  if (pending.costs.length === 0) return priceQuestion;
  const costSummary = (lang === 'sw' ? '\n\nBei za kununua zilizotajwa pia zitawekwa:\n' : '\n\nThe stated buying costs will also be saved:\n')
    + pending.costs.map((cost) => `• ${cost.product} — TSh ${Math.round(cost.unitCost).toLocaleString('en-US')}${cost.unit ? ` kwa ${cost.unit}` : ''}`).join('\n');
  return priceQuestion.replace(/\n\nNihifadhi zote\?/u, `${costSummary}\n\nNihifadhi zote?`);
}

async function loadAssistantHistory(db: Admin, identity: ResolvedWhatsAppIdentity): Promise<AssistantHistoryMessage[]> {
  const { data: thread } = await db.from('whatsapp_ai_threads')
    .select('identity_id')
    .eq('identity_id', identity.id)
    .eq('company_id', identity.company_id)
    .gte('expires_at', new Date().toISOString())
    .maybeSingle();
  if (!thread) return [];
  const { data, error } = await db.from('whatsapp_ai_messages')
    .select('role, content, created_at')
    .eq('identity_id', identity.id)
    .eq('company_id', identity.company_id)
    .gte('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(12);
  if (error) return [];
  return (data ?? []).reverse().flatMap((row: { role: string; content: string }) =>
    row.role === 'user' || row.role === 'assistant'
      ? [{ role: row.role, content: String(row.content) } as AssistantHistoryMessage]
      : []);
}

async function storeAssistantExchange(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  waMessageId: string,
  userText: string,
  assistantText: string,
  memory: { topic: string | null; entities: Record<string, unknown>; lastTool: string | null },
): Promise<boolean> {
  const { error } = await db.rpc('wa_store_ai_exchange', {
    p_identity_id: identity.id,
    p_company_id: identity.company_id,
    p_wa_message_id: waMessageId,
    p_user_text: userText,
    p_assistant_text: assistantText,
    p_topic: memory.topic,
    p_entities: memory.entities,
    p_last_tool: memory.lastTool,
  });
  return !error;
}

async function clearAssistantMemory(db: Admin, identity: ResolvedWhatsAppIdentity): Promise<void> {
  await db.rpc('wa_clear_ai_context', {
    p_identity_id: identity.id,
    p_company_id: identity.company_id,
  });
}


function appUrl(): string {
  return Deno.env.get('RISIP_PUBLIC_APP_URL') || 'https://risip.online';
}

function isStopCommand(text: string | null | undefined): boolean {
  return isPendingEscape(text);
}

/** Live conversation state, or null when nothing is pending or it has expired. */
async function loadConversation(db: Admin, identityId: string) {
  const { data, error } = await db
    .from('whatsapp_conversations')
    .select('awaiting, receipt_id, options, expires_at, updated_at')
    .eq('identity_id', identityId)
    .maybeSingle();
  // A failed read is not evidence of an empty conversation. Fail closed so
  // a follow-up cannot be reinterpreted as a new transaction after a DB outage.
  if (error) throw new Error('conversation_read_failed');
  if (!data) return null;
  if (new Date(data.expires_at as string).getTime() < Date.now()) {
    // Do not erase a newer question created while this expired row was read.
    await db.from('whatsapp_conversations').delete().eq('identity_id', identityId)
      .eq('updated_at', data.updated_at);
    return null;
  }
  return data;
}

async function clearConversation(db: Admin, identityId: string): Promise<void> {
  await db.from('whatsapp_conversations').delete().eq('identity_id', identityId);
}

/**
 * Asks what a just-sold product costs to buy, when there is one worth asking
 * about. Everything here is best-effort: the sale is already saved, and a
 * failure means only that the question is not asked.
 */
/**
 * Once a day, and only when the pattern is already visible: one message can
 * carry the whole till roll.
 *
 * MEASURED, and it is the largest cost lever Risip has. The cached prefix is
 * paid per MESSAGE, not per item, so twenty items in one message cost 9.6x less
 * than twenty separate messages. The shopkeeper has no way to know that.
 *
 * Everything here is best-effort and silent on failure: the sale is already
 * saved, and a hint that fails must cost nobody anything. It also refuses to
 * interrupt — if the save left a question parked, the hint waits for tomorrow,
 * because two messages where one was expected is how a helpful line becomes
 * noise people stop reading.
 */
async function batchHintFor(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  lang: Lang,
): Promise<string | null> {
  try {
    const parked = await loadConversation(db, identity.id as string);
    if (parked) return null;

    const day = shopDay();
    const { data: sales } = await db.from('daily_records')
      .select('id')
      .eq('company_id', identity.company_id)
      .eq('recorded_by', identity.profile_id)
      .eq('status', 'confirmed')
      .in('kind', ['sale', 'debt_issued'])
      .gte('occurred_at', day.from.toISOString())
      .lt('occurred_at', day.to.toISOString())
      .limit(50);
    const soFar = (sales ?? []).length;
    if (soFar < 5) return null;

    const { data: claimed } = await db.rpc('wa_claim_daily_nudge', {
      p_identity_id: identity.id,
      p_business_date: day.date,
      p_kind: 'batch_hint',
    });
    if (claimed !== true) return null;

    // The remaining allowance turns the ceiling into something a shopkeeper can
    // plan around instead of a surprise at the end of the month. Omitted
    // entirely when no ceiling is set, rather than shown as a fake number.
    const { data: company } = await db.from('companies')
      .select('ai_monthly_request_limit').eq('id', identity.company_id).maybeSingle();
    const limit = company?.ai_monthly_request_limit == null
      ? null : Number(company.ai_monthly_request_limit);
    let remaining: number | null = null;
    if (limit !== null) {
      const monthStart = `${day.date.slice(0, 7)}-01`;
      const { data: usage } = await db.from('whatsapp_ai_usage_daily')
        .select('fallback_count').eq('company_id', identity.company_id)
        .gte('usage_day', monthStart).limit(40);
      const used = (usage ?? []).reduce((sum, row) => sum + Number(row.fallback_count ?? 0), 0);
      remaining = Math.max(0, limit - used);
    }

    return batchHintReply(soFar, remaining, limit, lang);
  } catch {
    // A hint is never worth failing a saved sale for.
    return null;
  }
}

async function askForBuyingPrice(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  phone: string,
  dailyRecordId: string,
  waMessageId: string,
  lang: Lang,
): Promise<void> {
  try {
    const { data, error } = await db.rpc('wa_next_cost_prompt', {
      p_phone: phone,
      p_daily_record_id: dailyRecordId,
    });
    if (error) return;
    const prompt = toCostPrompt(data);
    if (!prompt) return;

    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id,
      company_id: identity.company_id,
      profile_id: identity.profile_id,
      awaiting: 'product_cost',
      receipt_id: null,
      options: prompt,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });

    await sendReplyText(phone, costQuestion(prompt, lang), waMessageId);
    await audit(db, identity, waMessageId, 'product_cost', 'asked', prompt.productKey);
  } catch {
    /* Never let an optional question disturb a saved record. */
  }
}

/**
 * A sale line that went out under every price the shop set for itself.
 *
 * Only "below" is worth interrupting a confirmation for. A wholesale sale is the
 * shop working as intended, and saying so on every trade sale would teach people
 * to scroll past the line — and then the one that mattered gets scrolled past
 * too. Best-effort: a price check is never worth failing a confirmation over.
 */
async function belowOwnPriceNotice(
  db: Admin,
  companyId: string,
  record: ParsedDailyRecord,
  lang: Lang,
): Promise<string> {
  if (record.kind !== 'sale' || record.lines.length === 0) return '';
  try {
    const bands = await Promise.all(record.lines.map(async (line) => {
      const { data } = await db.rpc('price_band', {
        p_company: companyId,
        p_key: line.description,
        p_unit_price: line.unit_amount,
        p_quantity: line.quantity,
      });
      return { product: line.description, unitPrice: line.unit_amount, band: String(data ?? 'unpriced') };
    }));
    return priceBandNotice(bands, lang);
  } catch {
    return '';
  }
}

/** Parks the logout question on the ordinary timer, so an abandoned one expires. */
async function parkLogout(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  step: LogoutState['step'],
): Promise<void> {
  const state: LogoutState = { kind: 'logout', step, businessName: identity.company_name };
  await db.from('whatsapp_conversations').upsert({
    identity_id: identity.id,
    company_id: identity.company_id,
    profile_id: identity.profile_id,
    awaiting: 'logout_confirm',
    receipt_id: null,
    options: state,
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'identity_id' });
}

async function loadOwnedBusinesses(db: Admin, profileId: string): Promise<Array<{ id: string; name: string }>> {
  const { data: memberships, error: membershipError } = await db
    .from('company_members')
    .select('company_id')
    .eq('profile_id', profileId)
    .eq('role', 'owner');
  if (membershipError) throw membershipError;
  const ids = [...new Set((memberships ?? []).map((row) => String(row.company_id)))];
  if (!ids.length) return [];
  const { data: companies, error: companyError } = await db
    .from('companies')
    .select('id, name')
    .in('id', ids);
  if (companyError) throw companyError;
  return (companies ?? []).map((company) => ({ id: String(company.id), name: String(company.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function parkAccountDeletion(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  ownedCompanies: Array<{ id: string; name: string }>,
): Promise<void> {
  const state: AccountDeletionState = { kind: 'account_delete', step: 'confirm', ownedCompanies };
  await db.from('whatsapp_conversations').upsert({
    identity_id: identity.id,
    company_id: identity.company_id,
    profile_id: identity.profile_id,
    awaiting: 'account_delete_confirm',
    receipt_id: null,
    options: state,
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'identity_id' });
}

/**
 * Unlinks the number. The conversation row is deleted by wa_logout itself, so
 * the state is cleared by the same transaction that revokes the identity — a
 * failure cannot leave a stale "are you sure?" behind an already-live number.
 */
async function performLogout(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  phone: string,
  lang: Lang,
): Promise<{ reply: string; outcome: string }> {
  const { error } = await db.rpc('wa_logout', { p_phone: phone });
  if (error) {
    // Either way the question has been answered, so it must not stay parked:
    // a stale "are you sure?" in front of a still-live number is worse than
    // making them ask again.
    await clearConversation(db, identity.id as string);
    const notLinked = String(error.message ?? '').includes('not linked');
    return {
      reply: notLinked ? logoutNotLinked(lang) : logoutFailed(lang),
      outcome: notLinked ? 'not_linked' : 'failed',
    };
  }
  return { reply: logoutDone(identity.company_name, lang), outcome: 'applied' };
}

/**
 * Turns a shop's own word into the catalogue's name, once, on the way in.
 *
 * Aliases resolve inside wa_resolve_company_product_read, so every READ already
 * found them. A drafted record was different: a fully-priced sale writes the
 * words the trader typed straight onto its lines, which meant "za mbwa kilo 3
 * kwa 6000" would have created a second product literally called "za mbwa",
 * sitting beside the real one and splitting its history in half.
 *
 * ONLY exact alias matches are rewritten. A trigram near-miss is deliberately
 * left exactly as typed, because that is what every existing vertical relies on
 * today — a chips shop writing "chipsi" still records "chipsi" and still gets
 * the near-name warning it has always had. Nothing here changes for a shop that
 * has taught no words.
 *
 * One place, not one per parser: sales, credit sales, purchases, losses and
 * owner use all draft through here.
 */
async function canonicaliseAliasLines(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  record: ParsedDailyRecord,
): Promise<ParsedDailyRecord> {
  if (record.lines.length === 0) return record;
  let changed = false;
  const lines = [];
  for (const line of record.lines) {
    try {
      const resolved = await resolveProductForRead(db, identity, line.description);
      if (!resolved.error
          && resolved.resolution.kind === 'matched'
          && resolved.resolution.match.matchKind === 'alias') {
        lines.push({ ...line, description: resolved.resolution.match.productName });
        changed = true;
        continue;
      }
    } catch {
      // Best effort. A resolver that is briefly unavailable must not stop a
      // shop recording its day.
    }
    lines.push(line);
  }
  return changed ? { ...record, lines } : record;
}

async function createDailyRecordDraft(
  db: Admin,
  identity: any,
  messageId: string,
  record: import('../_shared/whatsappDailyRecords.ts').ParsedDailyRecord,
  lang: Lang,
  /**
   * What the trader typed, so a payment method they stated is not lost between
   * the parser that ignored it and the ledger that has a column for it.
   *
   * Applied here, once, rather than in each of the seven parsers that build a
   * record — and only when the record does not already carry one, so a flow
   * that asked "ulilipwaje?" and got an answer always wins.
   */
  said?: string,
): Promise<{ id: string | null; error: any }> {
  const canonical = await canonicaliseAliasLines(db, identity, record);
  const withPayment = canonical.paymentMethod === undefined || canonical.paymentMethod === null
    ? (() => {
      // Credit is never a payment method: a sale on deni was not paid at all.
      const stated = extractPaymentMethod(said);
      return stated ? { ...canonical, paymentMethod: stated.method } : canonical;
    })()
    : canonical;
  const { data, error } = await db.rpc('wa_create_daily_record_draft', {
    p_profile_id: identity.profile_id,
    p_company_id: identity.company_id,
    p_kind: withPayment.kind,
    p_amount: withPayment.amount,
    p_party_name: withPayment.partyName,
    p_description: dailyRecordStorageDescription(withPayment, lang),
    p_occurred_at: withPayment.occurredAt ?? new Date().toISOString(),
    p_source_message_id: messageId,
    p_lines: withPayment.lines,
    // Phase 1 gave the ledger these two. A record that states neither sends
    // null, and null keeps meaning "the trader did not say" rather than being
    // filled in with a plausible guess.
    p_payment_method: withPayment.paymentMethod ?? null,
    p_loss_reason: withPayment.lossReason ?? null,
  });
  return { id: data ? String(data) : null, error };
}

async function createSupplierCreditPurchaseDraft(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  messageId: string,
  purchase: SupplierCreditPurchase,
  occurredAt: string | null | undefined,
): Promise<{ id: string | null; record: ParsedDailyRecord | null; error: any; clarification?: string }> {
  const lines: Array<{ description: string; quantity: number; unit: string | null }> = [];
  for (const line of purchase.lines) {
    const resolved = await resolveProductForWrite(db, identity, line.description);
    if (resolved.kind === 'ambiguous') {
      return {
        id: null,
        record: null,
        error: null,
        clarification: productReadClarification(resolved, 'sw'),
      };
    }
    lines.push({
      description: resolved.kind === 'matched' ? resolved.match.productName : line.description,
      quantity: line.quantity,
      unit: line.unit,
    });
  }
  const { data, error } = await db.rpc('wa_create_supplier_credit_purchase_draft', {
    p_profile_id: identity.profile_id,
    p_company_id: identity.company_id,
    p_supplier_name: purchase.supplierName,
    p_lines: lines,
    p_amount: purchase.amount,
    p_occurred_at: occurredAt ?? new Date().toISOString(),
    p_source_message_id: messageId,
  });
  if (error || !data) return { id: data ? String(data) : null, record: null, error };
  const id = String(data);
  const [{ data: row, error: rowError }, { data: storedLines, error: linesError }] = await Promise.all([
    db.from('daily_records').select('kind, amount, party_name, description, payment_method, occurred_at').eq('id', id).maybeSingle(),
    db.from('daily_record_lines').select('description, quantity, unit_amount, unit').eq('daily_record_id', id).order('line_number', { ascending: true }),
  ]);
  if (rowError || linesError || !row) return { id, record: null, error: rowError ?? linesError };
  const record: ParsedDailyRecord = {
    kind: 'supplier_payable',
    amount: Number(row.amount),
    partyName: row.party_name ? String(row.party_name) : null,
    description: row.description ? String(row.description) : 'Ununuzi wa bidhaa kwa deni',
    lines: ((storedLines ?? []) as Array<Record<string, unknown>>).map((line) => ({
      description: String(line.description ?? ''),
      quantity: Number(line.quantity),
      unit_amount: Number(line.unit_amount),
      unit: line.unit ? String(line.unit) : null,
    })),
    paymentMethod: null,
    occurredAt: row.occurred_at ? String(row.occurred_at) : occurredAt,
    confidence: 0.99,
  };
  return { id, record, error: null };
}

async function createSupplierPaymentDraft(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  messageId: string,
  payment: SupplierPayment,
  occurredAt: string | null | undefined,
): Promise<{ id: string | null; record: ParsedDailyRecord | null; error: any }> {
  const { data, error } = await db.rpc('wa_create_supplier_payment_draft', {
    p_profile_id: identity.profile_id,
    p_company_id: identity.company_id,
    p_supplier_name: payment.supplierName,
    p_amount: payment.amount,
    p_payment_method: payment.paymentMethod,
    p_occurred_at: occurredAt ?? new Date().toISOString(),
    p_source_message_id: messageId,
  });
  if (error || !data) return { id: data ? String(data) : null, record: null, error };
  const id = String(data);
  const { data: row, error: rowError } = await db.from('daily_records')
    .select('kind, amount, party_name, description, payment_method, occurred_at').eq('id', id).maybeSingle();
  if (rowError || !row) return { id, record: null, error: rowError };
  return {
    id,
    error: null,
    record: {
      kind: 'supplier_payment',
      amount: Number(row.amount),
      partyName: row.party_name ? String(row.party_name) : null,
      description: row.description ? String(row.description) : 'Malipo kwa supplier',
      lines: [],
      paymentMethod: row.payment_method as ParsedDailyRecord['paymentMethod'],
      occurredAt: row.occurred_at ? String(row.occurred_at) : occurredAt,
      confidence: 0.99,
    },
  };
}

async function supplierBalanceReply(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  question: { supplierName: string | null },
  lang: Lang,
): Promise<string> {
  if (!canUseCompanyFinanceReads(identity.role)) {
    return lang === 'sw'
      ? 'Salio la supplier linaonekana kwa owner au accountant tu.'
      : 'Supplier balances are available only to an owner or accountant.';
  }
  const { data, error } = await db.rpc('wa_supplier_balances', {
    p_profile_id: identity.profile_id,
    p_company_id: identity.company_id,
    p_supplier_name: question.supplierName,
  });
  if (error) throw error;
  const rows = (data ?? []) as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    return question.supplierName
      ? (lang === 'sw' ? `Sina deni lililothibitishwa kwa ${question.supplierName}.` : `There is no confirmed amount owed to ${question.supplierName}.`)
      : (lang === 'sw' ? 'Sina madeni ya suppliers yaliyothibitishwa kwa sasa.' : 'There are no confirmed supplier payables right now.');
  }
  if (question.supplierName) {
    const row = rows[0];
    return lang === 'sw'
      ? `Biashara inamdaiwa ${row.supplier_name}: *TSh ${Number(row.outstanding).toLocaleString('en-US')}*. Ununuzi wa mkopo: TSh ${Number(row.payable).toLocaleString('en-US')}; tumelipa: TSh ${Number(row.payments).toLocaleString('en-US')}.`
      : `The business owes ${row.supplier_name}: *TZS ${Number(row.outstanding).toLocaleString('en-US')}*. Credit purchases: TZS ${Number(row.payable).toLocaleString('en-US')}; paid: TZS ${Number(row.payments).toLocaleString('en-US')}.`;
  }
  return (lang === 'sw' ? 'Madeni ya suppliers yaliyothibitishwa:\n' : 'Confirmed supplier payables:\n')
    + rows.map((row) => `${row.supplier_name}: ${lang === 'sw' ? 'TSh' : 'TZS'} ${Number(row.outstanding).toLocaleString('en-US')}`).join('\n');
}

function breakdownCandidatesFor(
  candidates: WholeAnimalBreakdownCandidate[],
  reading: Extract<WholeAnimalBreakdownReading, { kind: 'parsed' }>,
  message: string,
): WholeAnimalBreakdownCandidate[] {
  let filtered = candidates;
  if (reading.source.purchaseTotal !== null) {
    filtered = filtered.filter((candidate) => candidate.purchaseTotal === reading.source.purchaseTotal);
  }
  if (reading.source.relativeDate === 'yesterday') {
    const wanted = resolveTransactionDate(message);
    if (wanted.kind === 'historical' && wanted.occurredAt) {
      const day = wanted.occurredAt.slice(0, 10);
      filtered = filtered.filter((candidate) => candidate.occurredAt.slice(0, 10) === day);
    }
  }
  return filtered;
}

async function createWholeAnimalBreakdownDraft(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  reading: Extract<WholeAnimalBreakdownReading, { kind: 'parsed' }>,
  source: WholeAnimalBreakdownCandidate,
  messageId: string,
): Promise<{
  id: string | null;
  error: unknown;
  outputs: WholeAnimalBreakdownOutput[];
  clarification: string | null;
}> {
  const outputs: WholeAnimalBreakdownOutput[] = [];
  for (const output of reading.outputs) {
    const resolved = await resolveProductForWrite(db, identity, output.productName);
    if (resolved.kind === 'ambiguous') {
      return {
        id: null, error: null, outputs: [],
        clarification: productReadClarification(resolved, identity.lang),
      };
    }
    if (resolved.kind !== 'matched') {
      return {
        id: null, error: null, outputs: [],
        clarification: identity.lang === 'sw'
          ? `Sijaipata bidhaa “${output.productName}” kwenye katalogi ya kampuni. Iweke kwanza kama bidhaa iliyosanidiwa; hakuna output iliyohifadhiwa.`
          : `I could not find “${output.productName}” in the company catalogue. Configure it first; no output was saved.`,
      };
    }
    outputs.push({ ...output, productName: resolved.match.productName });
  }

  const { data, error } = await db.rpc('wa_create_whole_animal_breakdown_draft', {
    p_profile_id: identity.profile_id,
    p_company_id: identity.company_id,
    p_source_procurement_daily_record_id: source.dailyRecordId,
    p_outputs: outputs.map((output) => ({
      product_key: productKey(output.productName),
      product_name: output.productName,
      quantity: output.quantity,
      unit: output.unit,
    })),
    p_occurred_at: new Date().toISOString(),
    p_source_message_id: messageId,
  });
  return { id: data ? String(data) : null, error, outputs, clarification: null };
}

async function listWholeAnimalBreakdownSources(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
): Promise<WholeAnimalBreakdownCandidate[]> {
  const { data, error } = await db.rpc('wa_list_available_whole_animal_procurements', {
    p_profile_id: identity.profile_id,
    p_company_id: identity.company_id,
  });
  if (error) return [];
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    dailyRecordId: String(row.daily_record_id),
    animalType: String(row.animal_type ?? "ng'ombe"),
    animalCount: Number(row.animal_count ?? 1),
    purchaseTotal: Number(row.purchase_total ?? 0),
    occurredAt: String(row.occurred_at ?? ''),
  })).filter((candidate) => candidate.dailyRecordId && candidate.purchaseTotal > 0 && candidate.occurredAt);
}

async function createDailyRecordBatchDrafts(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  messageId: string,
  records: ParsedDailyRecord[],
  lang: Lang,
): Promise<{ ids: string[]; error: unknown }> {
  const payload = records.map((record) => ({
    kind: record.kind,
    amount: record.amount,
    party_name: record.partyName,
    description: dailyRecordStorageDescription(record, lang),
    lines: record.lines,
    occurred_at: record.occurredAt ?? null,
  }));
  const { data, error } = await db.rpc('wa_create_daily_record_batch_drafts', {
    p_profile_id: identity.profile_id,
    p_company_id: identity.company_id,
    p_source_message_id: messageId,
    p_records: payload,
  });
  return { ids: Array.isArray(data) ? data.map(String) : [], error };
}

async function addHistoricalPriceWarnings(db: Admin, companyId: string, record: ParsedDailyRecord): Promise<ParsedDailyRecord> {
  if (record.lines.length === 0) return record;
  const { data: historicalRecords } = await db.from('daily_records')
    .select('id').eq('company_id', companyId).eq('status', 'confirmed').order('occurred_at', { ascending: false }).limit(200);
  const ids = (historicalRecords ?? []).map((row) => String((row as { id: string }).id));
  if (ids.length === 0) return record;
  const { data: historicalLines } = await db.from('daily_record_lines')
    .select('description, unit_amount').in('daily_record_id', ids).limit(1000);
  const warnings = detectDailyRecordPriceAnomalies(record, (historicalLines ?? []) as { description: string; unit_amount: number }[]);
  return warnings.length > 0 ? { ...record, warnings } : record;
}

/**
 * A product name one edit away from something already sold.
 *
 * 0091 folds away splits caused by punctuation or spacing on its own. A real
 * difference in letters — "Bibilia" against "Biblia" — it deliberately leaves
 * alone, because folding those automatically would eventually merge two products
 * that are genuinely different. So the confirmation asks, and the trader decides:
 * they know whether it is the same thing, and nothing here does.
 */
async function nearNameNotice(
  db: Admin,
  companyId: string,
  record: ParsedDailyRecord,
  lang: Lang,
): Promise<string> {
  if (record.kind !== 'sale' || record.lines.length === 0) return '';
  try {
    const { data } = await db.rpc('company_product_names', { p_company_id: companyId });
    const existing = Array.isArray(data) ? (data as { product_name: string }[]).map((row) => row.product_name) : [];
    if (existing.length === 0) return '';
    return nameWarningText(findNameWarnings(record.lines.map((line) => line.description), existing), lang);
  } catch {
    // A suggestion is never worth failing a confirmation over.
    return '';
  }
}

async function consumeAiBudget(db: Admin, identity: ResolvedWhatsAppIdentity, inputChars: number): Promise<AiBudgetDecision> {
  const { data, error } = await db.rpc('consume_whatsapp_ai_budget', {
    p_company_id: identity.company_id,
    p_identity_id: identity.id,
    p_input_chars: Math.min(Math.max(1, inputChars), MAX_INTERPRETATION_CHARS),
  });
  return normalizeAiBudgetDecision(data, error);
}

async function productAnalytics(
  db: Admin,
  companyId: string,
  request: import('../_shared/whatsappProductAnalytics.ts').ProductAnalyticsRequest,
): Promise<{ replyData: ProductSaleLine[]; costs: ProductCostPoint[] }> {
  const from = request.range?.from ?? periodStart(request.period).toISOString();
  const to = request.range?.to ?? new Date().toISOString();
  const { data: records } = await db.from('daily_records')
    .select('id, occurred_at')
    .eq('company_id', companyId)
    .eq('kind', 'sale')
    .eq('status', 'confirmed')
    .gte('occurred_at', from)
    .lt('occurred_at', to)
    .order('occurred_at', { ascending: true })
    .limit(2000);
  const rows = (records ?? []) as Array<{ id: string; occurred_at: string }>;
  if (rows.length === 0) return { replyData: [], costs: [] };
  const byId = new Map(rows.map((row) => [row.id, row.occurred_at]));
  const { data: lines } = await db.from('daily_record_lines')
    .select('daily_record_id, description, quantity, line_total, unit')
    .in('daily_record_id', rows.map((row) => row.id))
    .limit(10000);
  const replyData = ((lines ?? []) as Array<{ daily_record_id: string; description: string; quantity: number; line_total: number; unit: string | null }>)
    .map((line) => ({
      description: String(line.description ?? '').trim(),
      quantity: Number(line.quantity),
      lineTotal: Number(line.line_total),
      occurredAt: byId.get(line.daily_record_id) ?? new Date().toISOString(),
      unit: line.unit,
    }))
    .filter((line) => line.description && line.quantity > 0 && line.lineTotal > 0);
  const { data: costs } = await db.from('product_costs')
    .select('product_key, unit_cost, effective_from')
    .eq('company_id', companyId)
    .order('effective_from', { ascending: true })
    .limit(5000);
  return {
    replyData,
    costs: ((costs ?? []) as Array<{ product_key: string; unit_cost: number; effective_from: string }>).map((cost) => ({
      productKey: String(cost.product_key), unitCost: Number(cost.unit_cost), effectiveFrom: String(cost.effective_from),
    })),
  };
}

async function rememberProductAnalytics(
  db: Admin,
  identity: any,
  request: ProductAnalyticsRequest,
  items: ProductAggregate[],
): Promise<void> {
  const firstRanked = rankProducts(items, request.rankBy, request.compareNames, request.direction)[0]?.product;
  const focusNames = (request.compareNames.length > 0 ? request.compareNames : firstRanked ? [firstRanked] : []).slice(0, 2);
  if (focusNames.length === 0) return;
  const context: ProductAnalyticsContext = { kind: 'product_analytics_context', request, focusNames };
  await db.from('whatsapp_conversations').upsert({
    identity_id: identity.id,
    company_id: identity.company_id,
    profile_id: identity.profile_id,
    awaiting: 'product_analytics',
    receipt_id: null,
    options: context,
    expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'identity_id' });
}

async function answerProductAnalytics(
  db: Admin,
  identity: any,
  phone: string,
  request: ProductAnalyticsRequest,
  lang: Lang,
  replyToMessageId?: string | null,
): Promise<void> {
  await sendReplyText(phone, await productAnalyticsToolReply(db, identity, request, lang), replyToMessageId);
}

async function productAnalyticsToolReply(
  db: Admin,
  identity: any,
  request: ProductAnalyticsRequest,
  lang: Lang,
): Promise<string> {
  if (!canReadCompanyReporting(String(identity.role ?? 'worker'))) {
    return lang === 'sw'
      ? 'Taarifa za mauzo ya bidhaa za kampuni nzima zinaonekana kwa owner au accountant tu.'
      : 'Company-wide product sales information is available only to an owner or accountant.';
  }
  const resolvedNames: string[] = [];
  const notices: string[] = [];
  for (const asked of request.compareNames) {
    const resolved = await resolveProductForRead(db, identity, asked);
    if (resolved.error) {
      return lang === 'sw' ? 'Sikuweza kutafuta bidhaa hiyo sasa.' : 'I could not look up that product right now.';
    }
    if (resolved.resolution.kind === 'ambiguous') {
      return productReadClarification(resolved.resolution, lang);
    }
    if (resolved.resolution.kind === 'not_found') {
      return lang === 'sw'
        ? `Sikupata bidhaa “${asked}” kwenye orodha ya biashara hii.`
        : `I could not find “${asked}” in this business's product catalogue.`;
    }
    resolvedNames.push(resolved.resolution.match.productName);
    const notice = productReadMatchNotice(resolved.resolution, lang).trim();
    if (notice) notices.push(notice);
  }
  const resolvedRequest: ProductAnalyticsRequest = {
    ...request,
    compareNames: [...new Set(resolvedNames)],
  };
  const { replyData, costs } = await productAnalytics(db, identity.company_id, resolvedRequest);
  const items = aggregateProducts(replyData, costs);
  await rememberProductAnalytics(db, identity, resolvedRequest, items);
  return [...notices, productAnalyticsReply(resolvedRequest, items, lang)].filter(Boolean).join('\n');
}

/**
 * Everything the adviser is allowed to know, gathered once.
 *
 * All of it comes back from queries that already exist and are already trusted
 * elsewhere in this file — the same product aggregation the ranking uses, the
 * same shelf RPC the stock questions use, the same confirmed ledger rows the
 * summary uses. Nothing new is computed about money here; the adviser's job is
 * to put verified facts in the order that changes a decision.
 */
/**
 * The trading day, in the shop's own timezone.
 *
 * Africa/Dar_es_Salaam is a fixed +03:00 with no daylight saving, and has been
 * since 1960 — so the local calendar date is read through Intl (which is
 * authoritative) and the UTC bounds are derived from it arithmetically. Doing
 * it the other way round, guessing the date from a UTC timestamp, puts every
 * sale made between midnight and 3am on the wrong day.
 */
const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;

function shopDay(now = new Date()): { date: string; from: Date; to: Date } {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const [year, month, day] = date.split('-').map(Number);
  const midnightLocal = Date.UTC(year, month - 1, day) - EAT_OFFSET_MS;
  return { date, from: new Date(midnightLocal), to: new Date(midnightLocal + 86_400_000) };
}

/**
 * A day the trader named, or today when they named none.
 *
 * `understood` is the important half. This used to fall back to today whenever
 * the wording did not resolve, which meant a question about the 23rd was
 * answered with today's totals under today's heading and nothing anywhere said
 * the date had been dropped. A wrong day carrying a confident total is worse
 * than no answer: the figures are all real, so there is nothing to notice.
 */
function resolveShopDay(
  wording: string | null,
): { date: string; from: Date; to: Date; understood: boolean } {
  if (!wording) return { ...shopDay(), understood: true };
  const range = resolveDateRange(wording);
  if (!range) return { ...shopDay(), understood: false };
  const last = new Date(range.to.getTime() - 1);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(last);
  const [year, month, day] = date.split('-').map(Number);
  const midnightLocal = Date.UTC(year, month - 1, day) - EAT_OFFSET_MS;
  return {
    date,
    from: new Date(midnightLocal),
    to: new Date(midnightLocal + 86_400_000),
    understood: true,
  };
}

function shopClock(value: Date, lang: Lang): string {
  return new Intl.DateTimeFormat(lang === 'sw' ? 'sw-TZ' : 'en-GB', {
    timeZone: 'Africa/Dar_es_Salaam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(value);
}

function shopDateLabel(date: string, lang: Lang): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Intl.DateTimeFormat(lang === 'sw' ? 'sw-TZ' : 'en-GB', {
    timeZone: 'Africa/Dar_es_Salaam', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}

/**
 * Everything recorded today, gathered once, for the four messages a closing
 * produces: the draft, the confirmation, the owner's report and the list.
 *
 * Cost of goods comes from calculateProfitEstimate, which prices each sold line
 * at the buying cost that was effective when it was sold. That is the only
 * implementation of it in Risip, and this deliberately does not add a second.
 */
async function buildDayCloseFacts(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  lang: Lang,
  /** "jana", "juzi", "tarehe 27" — the trader's own words, or null for today. */
  dayWording: string | null = null,
): Promise<DayCloseFacts> {
  const day = resolveShopDay(dayWording);
  if (dayWording && !day.understood) {
    throw new Error('unresolved_explicit_date');
  }
  const companyId = identity.company_id as string;

  const [{ data: todayRows }, { data: allRows }, { data: rawCosts }, { data: shelfRows }] =
    await Promise.all([
      db.from('daily_records')
        .select('id, kind, status, amount, party_name, occurred_at, recorded_by, source')
        .eq('company_id', companyId).eq('status', 'confirmed')
        .gte('occurred_at', day.from.toISOString()).lt('occurred_at', day.to.toISOString())
        .order('occurred_at', { ascending: true }).limit(5000),
      // Debt is all-time: a debt does not stop being owed because a day ended.
      db.from('daily_records').select('kind, status, amount, party_name, occurred_at')
        .eq('company_id', companyId).eq('status', 'confirmed').limit(10000),
      db.from('product_costs').select('product_key, unit_cost, effective_from')
        .eq('company_id', companyId).order('effective_from', { ascending: true }).limit(10000),
      db.rpc('wa_stock_on_hand', { p_company_id: companyId, p_product: null }),
    ]);

  type RawRow = {
    id: string; kind: string; status: string; amount: number;
    party_name: string | null; occurred_at: string; recorded_by: string | null; source: string | null;
  };
  const today = (todayRows ?? []) as RawRow[];
  const ids = today.map((row) => row.id);

  const { data: rawLines } = ids.length > 0
    ? await db.from('daily_record_lines')
      .select('daily_record_id, description, quantity, line_total')
      .in('daily_record_id', ids).order('line_number', { ascending: true }).limit(20000)
    : { data: [] as Array<Record<string, unknown>> };

  const recorders = [...new Set(today.map((row) => row.recorded_by).filter(Boolean))] as string[];
  const { data: people } = recorders.length > 0
    ? await db.from('profiles').select('id, full_name').in('id', recorders)
    : { data: [] as Array<{ id: string; full_name: string | null }> };
  const nameOf = new Map((people ?? []).map((row) => [row.id as string, String(row.full_name ?? '').trim()]));

  const rows: ReadDailyRow[] = today.map((row) => ({
    kind: row.kind, status: row.status, amount: Number(row.amount),
    partyName: row.party_name, occurredAt: row.occurred_at,
  }));
  const occurredById = new Map(today.map((row) => [row.id, row.occurred_at]));
  const lines: ReadDailyLine[] = ((rawLines ?? []) as Array<Record<string, unknown>>).map((line) => ({
    description: String(line.description ?? ''),
    quantity: Number(line.quantity ?? 0),
    lineTotal: Number(line.line_total ?? 0),
    occurredAt: occurredById.get(String(line.daily_record_id)) ?? day.from.toISOString(),
  }));
  const costs: ReadProductCost[] = ((rawCosts ?? []) as Array<Record<string, unknown>>).map((cost) => ({
    productKey: String(cost.product_key ?? ''),
    unitCost: Number(cost.unit_cost ?? 0),
    effectiveFrom: String(cost.effective_from ?? ''),
  }));

  const profit = calculateProfitEstimate(rows, lines, costs);
  const total = (kind: string) => today
    .filter((row) => row.kind === kind)
    .reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const count = (kind: string) => today.filter((row) => row.kind === kind).length;

  // One block per person who recorded, in the order they first recorded, each
  // carrying its own lines. The owner asked for the name against the entry.
  const byRecorder = new Map<string, CloseWorker>();
  const linesByRecord = new Map<string, CloseLine[]>();
  for (const line of ((rawLines ?? []) as Array<Record<string, unknown>>)) {
    const key = String(line.daily_record_id);
    const bucket = linesByRecord.get(key) ?? [];
    bucket.push({
      description: String(line.description ?? ''),
      quantity: Number(line.quantity ?? 0),
      lineTotal: Number(line.line_total ?? 0),
      kind: '',
    });
    linesByRecord.set(key, bucket);
  }
  for (const row of today) {
    const key = row.recorded_by ?? 'unknown';
    const worker = byRecorder.get(key) ?? {
      name: nameOf.get(key) || (lang === 'sw' ? 'Haijulikani' : 'Unknown'),
      source: row.source === 'whatsapp' ? 'WhatsApp' : String(row.source ?? 'Risip'),
      firstAt: shopClock(new Date(row.occurred_at), lang),
      lines: [],
    };
    const own = linesByRecord.get(row.id) ?? [];
    if (own.length > 0) {
      for (const line of own) {
        worker.lines.push({ ...line, kind: row.kind, partyName: row.party_name });
      }
    } else {
      // An amount with no product lines — an expense, a repayment — still
      // belongs on the list, or the totals will not add up for the reader.
      worker.lines.push({
        description: row.party_name || kindLabelFor(row.kind, lang),
        quantity: 1,
        lineTotal: Number(row.amount ?? 0),
        kind: row.kind,
        partyName: row.party_name,
      });
    }
    byRecorder.set(key, worker);
  }

  const newDebtors = new Map<string, number>();
  for (const row of today) {
    if (row.kind !== 'debt_issued') continue;
    const who = String(row.party_name ?? '').trim();
    if (!who) continue;
    newDebtors.set(who, (newDebtors.get(who) ?? 0) + Number(row.amount ?? 0));
  }

  const allTime: ReadDailyRow[] = ((allRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    kind: String(row.kind ?? ''), status: String(row.status ?? ''),
    amount: Number(row.amount ?? 0), partyName: (row.party_name ?? null) as string | null,
    occurredAt: String(row.occurred_at ?? ''),
  }));
  const debtors = calculateDebtors(allTime);
  const outOfStock = ((shelfRows ?? []) as Array<Record<string, unknown>>)
    .filter((row) => Boolean(row.has_count) && Number(row.on_hand ?? 0) <= 0)
    .map((row) => String(row.product_name ?? ''))
    .filter(Boolean);
  const lowStock = ((shelfRows ?? []) as Array<Record<string, unknown>>)
    .filter((row) => Boolean(row.has_count) && Number(row.on_hand ?? 0) > 0 && Number(row.on_hand ?? 0) <= 5)
    .map((row) => ({ name: String(row.product_name ?? ''), quantity: Number(row.on_hand ?? 0) }))
    .filter((row) => Boolean(row.name));

  return {
    businessName: identity.company_name as string,
    businessDate: day.date,
    dateLabel: shopDateLabel(day.date, lang),
    isToday: day.date === shopDay().date,
    sales: profit.sales,
    cogs: profit.cogs,
    grossProfit: profit.grossProfit,
    expenses: profit.expenses,
    profit: profit.estimatedProfit,
    purchases: total('stock_purchase'),
    newDebt: total('debt_issued'),
    debtPaid: total('customer_payment'),
    saleCount: count('sale'),
    purchaseCount: count('stock_purchase'),
    newDebtCount: count('debt_issued'),
    debtPaidCount: count('customer_payment'),
    recordCount: today.length,
    workers: [...byRecorder.values()],
    newDebtors: [...newDebtors.entries()]
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount),
    outstandingDebt: debtors.reduce((sum, debtor) => sum + debtor.balance, 0),
    outstandingDebtors: debtors.length,
    outOfStock,
    lowStock,
    profitCoveragePct: Math.round(profit.coverage * 100),
  };
}

function kindLabelFor(kind: string, lang: Lang): string {
  const sw = lang === 'sw';
  switch (kind) {
    case 'expense': return sw ? 'Matumizi' : 'Expense';
    case 'customer_payment': return sw ? 'Malipo ya deni' : 'Debt repayment';
    case 'supplier_payment': return sw ? 'Malipo kwa muuzaji' : 'Supplier payment';
    case 'sale': return sw ? 'Mauzo' : 'Sale';
    default: return sw ? 'Muamala' : 'Record';
  }
}

/**
 * Every trading day in a period, each with its own sales and profit.
 *
 * Costed the same way every other profit figure in Risip is costed: each sold
 * line priced at the buying cost that was effective when it was sold, through
 * calculateProfitEstimate. Running it once per day rather than once per period
 * is the only difference, and it is the whole point — a total hides the shape.
 */
async function readObligations(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
): Promise<Obligation[]> {
  const { data } = await db.rpc('wa_recurring_obligations', {
    p_company_id: identity.company_id,
  });
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    kind: String(row.kind ?? 'other'),
    label: (row.label ?? null) as string | null,
    amount: Number(row.amount ?? 0),
    periodMonths: Number(row.period_months ?? 1),
    nextDueOn: String(row.next_due_on ?? ''),
    daysUntilDue: Number(row.days_until_due ?? 0),
    paidForCurrentPeriod: Number(row.paid_for_current_period ?? 0),
    outstanding: Number(row.outstanding ?? 0),
    lastPaidOn: (row.last_paid_on ?? null) as string | null,
    previousAmount: row.previous_amount == null ? null : Number(row.previous_amount),
  }));
}

/**
 * How often, from the trader's own words.
 *
 * The MODEL copies the phrase; this maps it. Deliberately not a wide parser —
 * it reads a period, which is one of six values, and anything it cannot place
 * becomes a question rather than a guess. A wrong period would silently shift
 * every future due date.
 */
function periodMonthsFromWording(wording: unknown): number | null {
  const said = String(wording ?? '').toLocaleLowerCase('sw-TZ');
  if (!said) return null;
  if (/(mwaka|annual|yearly|year)/.test(said)) return 12;
  if (/(nusu mwaka|half.?year)/.test(said)) return 6;
  const digits = said.match(/(d{1,2})/);
  const words: Record<string, number> = {
    moja: 1, mbili: 2, tatu: 3, nne: 4, sita: 6, kumi: 10,
    one: 1, two: 2, three: 3, four: 4, six: 6, twelve: 12,
  };
  const named = Object.keys(words).find((word) => said.includes(word));
  const count = digits ? Number(digits[1]) : named ? words[named] : null;
  if (/(miezi|month)/.test(said) && count && [1, 2, 3, 4, 6, 12].includes(count)) return count;
  if (/(mwezi|monthly|month)/.test(said)) return 1;
  return null;
}

/**
 * When the next payment falls, from what they said or from today.
 *
 * A day of the month that has already passed means NEXT month — somebody who
 * says "tarehe 5" on the tenth is talking about the fifth that is coming, not
 * the one that went.
 */
function nextDueFromWording(wording: unknown, months: number): string {
  const day = shopDay();
  const [year, month, date] = day.date.split('-').map(Number);
  const said = String(wording ?? '').toLocaleLowerCase('sw-TZ');
  const asked = said.match(/(d{1,2})/);
  if (/(mwisho|end)/.test(said)) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const target = new Date(Date.UTC(year, month - 1, last));
    if (last < date) target.setUTCMonth(target.getUTCMonth() + 1);
    return target.toISOString().slice(0, 10);
  }
  if (asked) {
    const wanted = Math.min(28, Math.max(1, Number(asked[1])));
    const target = new Date(Date.UTC(year, month - 1, wanted));
    if (wanted < date) target.setUTCMonth(target.getUTCMonth() + 1);
    return target.toISOString().slice(0, 10);
  }
  // Nothing said: one whole period from today, which is what somebody who has
  // just paid and is now telling Risip about it means.
  const target = new Date(Date.UTC(year, month - 1 + months, date));
  return target.toISOString().slice(0, 10);
}

async function buildDailyBreakdown(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  lang: Lang,
  periodWording: string | null,
): Promise<{ days: DayFigures[]; periodLabel: string }> {
  const companyId = identity.company_id as string;
  const range = periodWording ? resolveDateRange(periodWording) : null;
  const today = shopDay();
  // Default to this month, which is the window a shopkeeper means by "lini".
  const from = range ? range.from : new Date(Date.UTC(
    Number(today.date.slice(0, 4)), Number(today.date.slice(5, 7)) - 1, 1,
  ) - EAT_OFFSET_MS);
  const to = range ? range.to : today.to;
  const periodLabel = range
    ? (lang === 'sw' ? range.sw : range.en)
    : (lang === 'sw' ? 'mwezi huu' : 'this month');

  const [{ data: rawRows }, { data: rawCosts }] = await Promise.all([
    db.from('daily_records').select('id, kind, status, amount, party_name, occurred_at')
      .eq('company_id', companyId).eq('status', 'confirmed')
      .gte('occurred_at', from.toISOString()).lt('occurred_at', to.toISOString())
      .order('occurred_at', { ascending: true }).limit(10000),
    db.from('product_costs').select('product_key, unit_cost, effective_from')
      .eq('company_id', companyId).order('effective_from', { ascending: true }).limit(10000),
  ]);

  type Raw = { id: string; kind: string; status: string; amount: number; party_name: string | null; occurred_at: string };
  const rows = (rawRows ?? []) as Raw[];
  const ids = rows.map((row) => row.id);
  const { data: rawLines } = ids.length > 0
    ? await db.from('daily_record_lines')
      .select('daily_record_id, description, quantity, line_total')
      .in('daily_record_id', ids).limit(40000)
    : { data: [] as Array<Record<string, unknown>> };

  const costs: ReadProductCost[] = ((rawCosts ?? []) as Array<Record<string, unknown>>).map((cost) => ({
    productKey: String(cost.product_key ?? ''),
    unitCost: Number(cost.unit_cost ?? 0),
    effectiveFrom: String(cost.effective_from ?? ''),
  }));

  const dayOf = (iso: string) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso));
  const occurredById = new Map(rows.map((row) => [row.id, row.occurred_at]));
  const dayById = new Map(rows.map((row) => [row.id, dayOf(row.occurred_at)]));

  const rowsByDay = new Map<string, ReadDailyRow[]>();
  const linesByDay = new Map<string, ReadDailyLine[]>();
  for (const row of rows) {
    const day = dayById.get(row.id)!;
    const bucket = rowsByDay.get(day) ?? [];
    bucket.push({
      kind: row.kind, status: row.status, amount: Number(row.amount),
      partyName: row.party_name, occurredAt: row.occurred_at,
    });
    rowsByDay.set(day, bucket);
  }
  for (const line of ((rawLines ?? []) as Array<Record<string, unknown>>)) {
    const day = dayById.get(String(line.daily_record_id));
    if (!day) continue;
    const bucket = linesByDay.get(day) ?? [];
    bucket.push({
      description: String(line.description ?? ''),
      quantity: Number(line.quantity ?? 0),
      lineTotal: Number(line.line_total ?? 0),
      occurredAt: occurredById.get(String(line.daily_record_id)) ?? from.toISOString(),
    });
    linesByDay.set(day, bucket);
  }

  // Every calendar day in the window, including the silent ones — a day with
  // no records is not a day with no sales, and the difference matters.
  const days: DayFigures[] = [];
  for (let at = new Date(from.getTime()); at < to; at = new Date(at.getTime() + 86_400_000)) {
    const date = dayOf(at.toISOString());
    if (days.some((day) => day.date === date)) continue;
    const dayRows = rowsByDay.get(date) ?? [];
    const estimate = calculateProfitEstimate(dayRows, linesByDay.get(date) ?? [], costs);
    const [year, month, dayNumber] = date.split('-').map(Number);
    days.push({
      date,
      label: new Intl.DateTimeFormat(lang === 'sw' ? 'sw-TZ' : 'en-GB', {
        timeZone: 'Africa/Dar_es_Salaam', weekday: 'short', day: 'numeric',
      }).format(new Date(Date.UTC(year, month - 1, dayNumber, 12))),
      sales: estimate.sales,
      profit: estimate.estimatedProfit,
      recordCount: dayRows.length,
      profitUnknown: dayRows.length > 0 && estimate.coverage === 0,
    });
  }
  return { days, periodLabel };
}

async function buildAdvisorPayload(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  lang: Lang,
): Promise<AdvisorPayload> {
  const request: ProductAnalyticsRequest = {
    rankBy: 'revenue', direction: 'best', period: 'month', compareNames: [], range: null,
  };
  const periodLabel = lang === 'sw' ? 'mwezi huu' : 'this month';
  const from = periodStart('month').toISOString();

  const [{ replyData, costs }, { data: shelfRows }, { data: ledger }, { data: catalogue }] = await Promise.all([
    productAnalytics(db, identity.company_id, request),
    db.rpc('wa_stock_on_hand', { p_company_id: identity.company_id, p_product: null }),
    db.from('daily_records').select('kind, amount, party_name, occurred_at')
      .eq('company_id', identity.company_id).eq('status', 'confirmed').limit(10000),
    db.rpc('company_product_names', { p_company_id: identity.company_id }),
  ]);

  // What the shop charges TODAY against what it pays today. Nothing to do with
  // what past sales achieved: a price raised this morning fixes the future and
  // cannot fix yesterday, and the adviser has to be able to tell the two apart.
  const { data: pricingRows } = await db.rpc('wa_product_pricing', {
    p_company_id: identity.company_id,
    p_product_keys: ((catalogue ?? []) as Array<Record<string, unknown>>)
      .map((row) => String(row.product_name ?? '').trim()).filter(Boolean),
  });
  const priceBelowCost = ((pricingRows ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({
      name: String(row.product_key ?? ''),
      retail: row.retail_price == null ? null : Number(row.retail_price),
      cost: row.unit_cost == null ? null : Number(row.unit_cost),
    }))
    .filter((row): row is { name: string; retail: number; cost: number } =>
      Boolean(row.name) && row.retail !== null && row.cost !== null
      && row.retail > 0 && row.cost > 0 && row.retail < row.cost)
    .sort((a, b) => (a.retail - a.cost) - (b.retail - b.cost));

  const items = aggregateProducts(replyData, costs);
  // Margin already carries the buying cost, so this is revenue - COGS -
  // expenses over rows we have in hand: the same arithmetic as
  // calculateProfitEstimate, without a second round trip.
  const costedItems = items.filter((item) => item.costed && item.margin !== null);
  const soldRevenue = items.reduce((sum, item) => sum + item.revenue, 0);
  const costedRevenue = costedItems.reduce((sum, item) => sum + item.revenue, 0);
  const grossMargin = costedItems.reduce((sum, item) => sum + (item.margin ?? 0), 0);
  const sold = new Set(items.map((item) => productKey(item.product)));
  const byRevenue = rankProducts(items, 'revenue', [], 'best');
  const belowCost = rankProducts(items, 'margin', [], 'worst').filter((item) => (item.margin ?? 0) < 0);

  const shelf = ((shelfRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    name: String(row.product_name ?? ''),
    onHand: Number(row.on_hand ?? 0),
    unit: row.unit ? String(row.unit) : null,
    hasCount: Boolean(row.has_count),
  })).filter((row) => row.name);

  // Confirmed rows only, and the debt figure is all-time: a debt does not stop
  // being owed because the month turned over.
  const rows = (ledger ?? []) as Array<{ kind: string; amount: number; party_name: string | null; occurred_at: string }>;
  const inPeriod = rows.filter((row) => row.occurred_at >= from);
  const total = (kind: string) => inPeriod
    .filter((row) => row.kind === kind)
    .reduce((sum, row) => sum + Number(row.amount ?? 0), 0);
  const owed = new Map<string, number>();
  for (const row of rows) {
    const party = (row.party_name ?? '').trim();
    if (!party) continue;
    const amount = Number(row.amount ?? 0);
    if (row.kind === 'debt_issued') owed.set(party, (owed.get(party) ?? 0) + amount);
    if (row.kind === 'customer_payment') owed.set(party, (owed.get(party) ?? 0) - amount);
  }
  const debtors = [...owed.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, amount]) => ({ name, amount }));

  return {
    businessName: identity.company_name,
    periodLabel,
    periodDates: periodDates('month', null),
    revenue: total('sale'),
    expenses: total('expense'),
    estimatedProfit: costedItems.length > 0
      ? Math.round(grossMargin - total('expense'))
      : null,
    profitCoverage: soldRevenue > 0 ? Math.round((costedRevenue / soldRevenue) * 100) / 100 : 0,
    debtIssued: total('debt_issued'),
    customerPayments: total('customer_payment'),
    topMovers: byRevenue.slice(0, 3).map((item) => ({
      name: item.product, quantity: item.quantity, revenue: item.revenue, margin: item.margin,
    })),
    belowCost: belowCost.map((item) => ({
      name: item.product, quantity: item.quantity, revenue: item.revenue, margin: item.margin,
    })),
    priceBelowCost,
    // Counted, still on the shelf, and not sold once this period. That is
    // capital lying down, and it is invisible in every other answer.
    deadStock: shelf
      .filter((row) => row.hasCount && row.onHand > 0 && !sold.has(productKey(row.name)))
      .sort((a, b) => b.onHand - a.onHand)
      .slice(0, 4)
      .map((row) => ({ name: row.name, onHand: row.onHand, unit: row.unit })),
    outOfStock: shelf.filter((row) => row.hasCount && row.onHand <= 0).map((row) => row.name),
    runningLow: shelf
      .filter((row) => row.hasCount && row.onHand > 0 && row.onHand <= 5)
      .sort((a, b) => a.onHand - b.onHand)
      .slice(0, 4)
      .map((row) => ({ name: row.name, onHand: row.onHand, unit: row.unit })),
    uncosted: items.filter((item) => !item.costed).map((item) => item.product).slice(0, 6),
    outstandingDebt: debtors.reduce((sum, debtor) => sum + debtor.amount, 0),
    topDebtors: debtors.slice(0, 3),
  };
}

/**
 * The product a WRITE is about, resolved against the shop's own catalogue.
 *
 * MEASURED FAILURE, the owner's own thread: "Bei ya velvet badilisha iwe 4500"
 * created a PRODUCT called "velvet badilisha" priced at 4,500, sitting beside
 * the real Velvet napkin. They had typed one word of the name and a verb, and
 * nothing checked the list before writing.
 *
 * Read paths have resolved names for months; write paths never did, which is
 * backwards — a bad read is a wrong answer, a bad write is a wrong catalogue
 * forever. This walks the same ladder the read path walks, and then one rung
 * further: if the whole phrase finds nothing, it drops the trailing word and
 * tries again, because "velvet badilisha" is "velvet" with a verb stuck to it.
 *
 * Returns `not_found` only when nothing in the catalogue is close, which is
 * what registering a genuinely new product looks like.
 */
async function resolveProductForWrite(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  asked: string,
): Promise<ProductReadResolution> {
  const direct = await resolveProductForRead(db, identity, asked);
  if (direct.error) return { kind: 'not_found', asked };
  if (direct.resolution.kind !== 'not_found') return direct.resolution;

  const { data: catalogue } = await db.rpc('company_product_names', { p_company_id: identity.company_id });
  const names = ((catalogue ?? []) as Array<Record<string, unknown>>)
    .map((row) => String(row.product_name ?? '').trim())
    .filter(Boolean);
  if (names.length === 0) return { kind: 'not_found', asked };

  const words = asked.trim().split(/\s+/).filter(Boolean);
  for (let take = words.length; take >= 1; take -= 1) {
    const attempt = words.slice(0, take).join(' ');
    const near = nearestCatalogueName(attempt, names);
    if (near) {
      return {
        kind: 'matched',
        asked,
        match: { productKey: productKey(near), productName: near, matchKind: 'trigram', matchScore: 0.95 },
      };
    }
    const byPrefix = cataloguePrefixResolution(attempt, names);
    if (byPrefix) return byPrefix.kind === 'matched' ? { ...byPrefix, asked } : { ...byPrefix, asked };
  }
  return { kind: 'not_found', asked };
}

/**
 * This period against the one before it, and the products that explain the gap.
 *
 * Both windows are the same length and both come from the same confirmed
 * ledger, so the comparison is arithmetic rather than impression. A product that
 * sold last week and not this one is named separately, because "it stopped" is a
 * different fact from "it fell".
 */
async function salesTrendToolReply(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  period: 'week' | 'month',
  lang: Lang,
): Promise<string> {
  if (!canReadCompanyReporting(identity.role)) {
    return lang === 'sw'
      ? 'Ulinganisho wa mauzo ya biashara nzima unaonekana kwa owner au accountant tu.'
      : 'A whole-business sales comparison is available only to an owner or accountant.';
  }
  const now = new Date();
  const start = periodStart(period, now);
  const span = now.getTime() - start.getTime();
  const previousStart = new Date(start.getTime() - span);

  const windowFor = (from: Date, to: Date) => ({
    from: from.toISOString(), to: to.toISOString(), sw: '', en: '',
  });
  const [current, previous] = await Promise.all([
    productAnalytics(db, identity.company_id, {
      rankBy: 'revenue', direction: 'best', period, compareNames: [], range: windowFor(start, now),
    }),
    productAnalytics(db, identity.company_id, {
      rankBy: 'revenue', direction: 'best', period, compareNames: [], range: windowFor(previousStart, start),
    }),
  ]);

  const after = new Map(aggregateProducts(current.replyData, current.costs)
    .map((item) => [productKey(item.product), item]));
  const before = new Map(aggregateProducts(previous.replyData, previous.costs)
    .map((item) => [productKey(item.product), item]));

  const moved: TrendProduct[] = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(key)?.revenue ?? 0;
    const is = after.get(key)?.revenue ?? 0;
    if (was === is) continue;
    moved.push({
      name: after.get(key)?.product ?? before.get(key)?.product ?? key,
      before: was,
      after: is,
      delta: is - was,
    });
  }

  const label = period === 'week'
    ? (lang === 'sw' ? 'wiki hii' : 'this week')
    : (lang === 'sw' ? 'mwezi huu' : 'this month');
  const previousLabel = period === 'week'
    ? (lang === 'sw' ? 'wiki iliyopita' : 'last week')
    : (lang === 'sw' ? 'mwezi uliopita' : 'last month');

  // The owner's complaint, in his words: "haijui siku kabisa, inasema juma,
  // sasa hii ndio nini". "Wiki hii" against "wiki iliyopita" is two windows
  // with no dates on either, so the shop cannot check a figure against a day.
  const asDay = (value: Date) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
  const daySpan = (from: Date, to: Date) => {
    const first = asDay(from);
    const last = asDay(new Date(to.getTime() - 1));
    return first === last ? first : `${first}..${last}`;
  };

  return salesTrendReply({
    periodLabel: `${label} (${daySpan(start, now)})`,
    previousLabel: `${previousLabel} (${daySpan(previousStart, start)})`,
    revenue: [...after.values()].reduce((sum, item) => sum + item.revenue, 0),
    previousRevenue: [...before.values()].reduce((sum, item) => sum + item.revenue, 0),
    fell: moved.filter((item) => item.delta < 0).sort((a, b) => a.delta - b.delta),
    rose: moved.filter((item) => item.delta > 0).sort((a, b) => b.delta - a.delta),
    stopped: moved.filter((item) => item.after === 0 && item.before > 0).map((item) => item.name),
  }, lang);
}

async function hypotheticalProfitToolReply(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  asked: string,
  lang: Lang,
  /** How many the question named, when it named one. Null means the shelf. */
  askedQuantity: number | null = null,
  priceBand: 'retail' | 'wholesale' | null = null,
): Promise<{ text: string; pending: HypotheticalPortionChoice | null }> {
  if (!canReadCompanyReporting(identity.role)) {
    return { text: lang === 'sw'
      ? 'Makisio ya faida ya kampuni yanaonekana kwa owner au accountant tu.'
      : 'Company profit estimates are available only to an owner or accountant.', pending: null };
  }
  const productName = asked.trim().slice(0, 100);
  if (productName.length < 2 || !/[\p{L}]/u.test(productName)) {
    return { text: lang === 'sw' ? 'Unataka kukadiria faida ya bidhaa gani?' : 'Which product profit do you want to estimate?', pending: null };
  }

  const { data: declaredRows, error: declaredError } = await db.rpc('wa_company_product_sale_units', {
    p_company_id: identity.company_id,
  });
  const declaredUnits: DeclaredSaleUnit[] = (declaredError ? [] : (declaredRows ?? []) as Array<Record<string, unknown>>)
    .map((row) => ({
      productKey: String(row.product_key),
      productName: String(row.product_name),
      unitKey: String(row.unit_key),
      unitName: String(row.unit_name),
      baseQuantity: Number(row.base_quantity),
      retail: row.retail_price == null ? null : Number(row.retail_price),
      wholesale: row.wholesale_price == null ? null : Number(row.wholesale_price),
      wholesaleMinQty: row.wholesale_min_qty == null ? null : Number(row.wholesale_min_qty),
    }));
  const portion = matchDeclaredSaleUnit(productName, declaredUnits);
  if (portion.kind === 'unit_required') {
    const pending: HypotheticalPortionChoice = {
      kind: 'hypothetical_portion_choice',
      productName: portion.productName,
      units: portion.units,
    };
    return { text: hypotheticalPortionQuestion(pending, lang), pending };
  }
  const askedProduct = portion.kind === 'matched' ? portion.unit.productName : productName;
  const resolved = await resolveProductForRead(db, identity, askedProduct);
  if (resolved.error) {
    return { text: lang === 'sw' ? 'Sikuweza kutafuta bidhaa hiyo sasa.' : 'I could not look up that product right now.', pending: null };
  }
  if (resolved.resolution.kind === 'ambiguous') return { text: productReadClarification(resolved.resolution, lang), pending: null };
  if (resolved.resolution.kind === 'not_found') {
    return { text: lang === 'sw'
      ? `Sikupata bidhaa “${productName}” kwenye orodha ya biashara hii.`
      : `I could not find “${productName}” in this business's product catalogue.`, pending: null };
  }

  const match = resolved.resolution.match;
  const [stockResult, costResult, priceResult] = await Promise.all([
    db.rpc('wa_stock_on_hand', { p_company_id: identity.company_id, p_product: match.productKey }),
    db.from('product_costs').select('unit_cost, base_unit_cost, base_unit').eq('company_id', identity.company_id)
      .eq('product_key', match.productKey).order('effective_from', { ascending: false })
      .order('created_at', { ascending: false }).limit(1).maybeSingle(),
    db.rpc('wa_product_pricing', { p_company_id: identity.company_id, p_product_keys: [match.productKey] }),
  ]);
  if (stockResult.error || costResult.error || priceResult.error) {
    return { text: lang === 'sw'
      ? `Sikuweza kusoma vipande vya makisio ya ${match.productName} sasa.`
      : `I could not load the inputs for the ${match.productName} estimate right now.`, pending: null };
  }
  const stock = ((stockResult.data ?? []) as Array<Record<string, unknown>>)[0] ?? null;
  const cost = costResult.data as { unit_cost?: number; base_unit_cost?: number | null; base_unit?: string | null } | null;
  const price = ((priceResult.data ?? []) as Array<Record<string, unknown>>)[0] ?? null;
  const notice = productReadMatchNotice(resolved.resolution, lang);
  if (portion.kind === 'matched') {
    if (askedQuantity !== null) {
      return { text: lang === 'sw' ? 'Makisio ya kiasi maalum kwa kipimo hiki bado hayajawezeshwa. Sijahesabu stock yote badala yake, wala kurekodi mauzo.' : 'A specific-quantity estimate for this portion is not supported yet. I have not substituted all stock or recorded a sale.', pending: null };
    }
    return { text: notice + buildPortionHypotheticalProfitReply({
      productName: match.productName,
      onHandBase: stock ? Number(stock.on_hand) : null,
      hasCount: Boolean(stock?.has_count),
      baseUnit: String(stock?.unit ?? cost?.base_unit ?? 'base unit'),
      baseUnitCost: cost?.base_unit_cost == null
        ? (cost?.unit_cost === undefined ? null : Number(cost.unit_cost))
        : Number(cost.base_unit_cost),
      saleUnit: portion.unit.unitName,
      unitBaseQuantity: portion.unit.baseQuantity,
      retailPrice: portion.unit.retail,
      wholesalePrice: portion.unit.wholesale,
    }, lang), pending: null };
  }
  return { text: notice + buildHypotheticalProfitReply({
    askedQuantity,
    priceBand,
    wholesaleMinQty: price?.wholesale_min_qty == null ? null : Number(price.wholesale_min_qty),
    productName: match.productName,
    onHand: stock ? Number(stock.on_hand) : null,
    hasCount: Boolean(stock?.has_count),
    unit: stock?.unit ? String(stock.unit) : null,
    unitCost: cost?.base_unit_cost == null
      ? (cost?.unit_cost === undefined ? null : Number(cost.unit_cost))
      : Number(cost.base_unit_cost),
    retailPrice: price?.retail_price == null ? null : Number(price.retail_price),
    wholesalePrice: price?.wholesale_price == null ? null : Number(price.wholesale_price),
    avgUnitPrice: price?.avg_unit_price == null ? null : Number(price.avg_unit_price),
  }, lang), pending: null };
}

/**
 * The window a question is about.
 *
 * A named range ("juzi", "wiki iliyopita", "tarehe 7 Mei 2025") wins; otherwise
 * one of the four coarse defaults is used. Both now start at midnight in
 * Africa/Dar_es_Salaam rather than UTC — three hours apart, which is enough to
 * file an evening sale on the wrong day.
 */
function readPeriodBounds(request: ReadRequest): { from: string; to: string } {
  const now = new Date();
  if (request.range) {
    return { from: request.range.from.toISOString(), to: request.range.to.toISOString() };
  }
  const fallback = resolveDateRange(
    request.period === 'today' ? 'leo'
      : request.period === 'week' ? 'wiki hii'
      : request.period === 'month' ? 'mwezi huu' : 'mwaka huu',
    now,
  )!;
  return { from: fallback.from.toISOString(), to: now.toISOString() };
}

/**
 * A1 tools are read-only and tenant-scoped from the already-resolved WhatsApp
 * identity. No user text is used as a company id, and no branch in this helper
 * writes a row or calls a finance mutation RPC.
 */
async function readOnlyToolReply(db: Admin, identity: any, request: ReadRequest, lang: Lang): Promise<string> {
  if (request.invalidTime) {
    return lang === 'sw'
      ? 'Sijaweza kutambua tarehe hiyo kwa usalama. Tafadhali andika tarehe kamili, kwa mfano *tarehe 23 Agosti 2026*.'
      : 'I could not resolve that date safely. Please write the full date, for example *23 August 2026*.';
  }
  // There are no records from the future. Saying so is better than quietly
  // returning zero, which reads as "your shop sold nothing".
  if (request.range && isFuture(request.range)) {
    const label = rangeLabel(request.range, lang);
    return lang === 'sw'
      ? `${label.charAt(0).toUpperCase()}${label.slice(1)} bado haijafika, kwa hiyo hakuna rekodi zake. Ungependa nikuonyeshe za leo?`
      : `${label} has not happened yet, so there are no records for it. Would you like today instead?`;
  }
  const { from, to } = readPeriodBounds(request);
  const companyId = String(identity.company_id);
  const profileId = String(identity.profile_id);
  const workerReadableCompanyReports = new Set([
    'ai_business_summary', 'ai_business_summary_facts', 'ai_debtors', 'ai_debtor_detail',
    'daily_profit_estimate', 'ai_stock_loss', 'ai_owner_use', 'ai_whole_animals',
  ]);
  const financeOnly = new Set(['ai_pending_approvals']);
  if ((workerReadableCompanyReports.has(request.tool) && !canReadCompanyReporting(String(identity.role ?? 'worker')))
    || (financeOnly.has(request.tool) && !canUseCompanyFinanceReads(String(identity.role ?? 'worker')))) {
    return lang === 'sw'
      ? 'Taarifa za kampuni nzima zinaonekana kwa owner au accountant tu. Unaweza kuniuliza kuhusu risiti zako, petty cash yako au reimbursement yako.'
      : 'Company-wide financial information is available only to an owner or accountant. You can ask about your own receipts, petty cash, or reimbursement.';
  }

  if (request.tool === 'ai_my_businesses') {
    const { data: memberships, error } = await db.from('company_members')
      .select('company_id, role').eq('profile_id', profileId).is('deactivated_at', null);
    if (error) return lang === 'sw' ? 'Sikuweza kupata orodha ya biashara zako sasa.' : 'I could not load your businesses right now.';
    const ids = (memberships ?? []).map((row: { company_id: string }) => row.company_id);
    if (ids.length === 0) return buildBusinessesReply([], lang);
    const { data: companies, error: companyError } = await db.from('companies').select('id, name').in('id', ids);
    if (companyError) return lang === 'sw' ? 'Sikuweza kupata orodha ya biashara zako sasa.' : 'I could not load your businesses right now.';
    const names = new Map((companies ?? []).map((row: { id: string; name: string }) => [row.id, row.name]));
    return buildBusinessesReply((memberships ?? []).map((row: { company_id: string; role: string }) => ({
      companyId: row.company_id, companyName: names.get(row.company_id) ?? 'Business', role: row.role,
    })), lang);
  }

  if (request.tool === 'ai_petty_cash_balance') {
    const { data, error } = await db.from('petty_cash_accounts').select('current_balance')
      .eq('company_id', companyId).eq('user_id', profileId).maybeSingle();
    return error ? buildPettyCashReply(null, lang) : buildPettyCashReply(data ? Number(data.current_balance) : null, lang);
  }

  if (request.tool === 'ai_owed_to_me') {
    const { data, error } = await db.from('receipts').select('total_amount')
      .eq('company_id', companyId).eq('uploaded_by', profileId).eq('status', 'confirmed')
      .eq('payment_method', 'cash_personal').is('reimbursed_at', null).limit(5000);
    if (error) return lang === 'sw' ? 'Sikuweza kupata taarifa ya madai yako sasa.' : 'I could not load what Risip owes you right now.';
    const amount = (data ?? []).reduce((sum: number, row: { total_amount: number | null }) => sum + Number(row.total_amount ?? 0), 0);
    return buildOwedToMeReply(amount, (data ?? []).length, lang);
  }

  if (request.tool === 'ai_my_receipts') {
    let query = db.from('receipts').select('id, status, total_amount, vendor_name, created_at')
      .eq('company_id', companyId).eq('uploaded_by', profileId).gte('created_at', from).lt('created_at', to)
      .order('created_at', { ascending: false }).limit(10);
    if (request.status) query = query.eq('status', request.status);
    const { data, error } = await query;
    if (error) return lang === 'sw' ? 'Sikuweza kupata risiti zako sasa.' : 'I could not load your receipts right now.';
    return buildReceiptsReply((data ?? []).map((row: { id: string; status: string; total_amount: number | null; vendor_name: string | null; created_at: string }) => ({
      id: row.id, status: row.status, amount: row.total_amount === null ? null : Number(row.total_amount), vendor: row.vendor_name, createdAt: row.created_at,
    })), lang, appUrl());
  }

  if (request.tool === 'ai_pending_approvals') {
    const { count, error } = await db.from('receipts').select('id', { count: 'exact', head: true })
      .eq('company_id', companyId).in('status', ['pending_review', 'submitted']);
    return error ? (lang === 'sw' ? 'Sikuweza kupata approvals zinazosubiri.' : 'I could not load pending approvals.') : buildPendingApprovalsReply(count ?? 0, lang);
  }

  const snapshotTools = new Set(['ai_business_summary', 'ai_business_summary_facts', 'ai_debtors', 'daily_profit_estimate', 'ai_stock_loss', 'ai_owner_use', 'ai_whole_animals']);
  if (snapshotTools.has(request.tool)) {
    const allTime = request.tool === 'ai_debtors';
    const { data, error } = await db.rpc('wa_bucha_reporting_snapshot', {
      p_profile_id: profileId,
      p_company_id: companyId,
      p_from: allTime ? null : from,
      p_to: allTime ? null : to,
    });
    if (error) return lang === 'sw' ? 'Sikuweza kupata report hiyo sasa.' : 'I could not load that report right now.';
    // The model reads evidence; the paragraph is what the shop sees only if the
    // model cannot finish.
    if (request.tool === 'ai_business_summary_facts') {
      return buchaReportFacts(data as BuchaReportingSnapshot, request.period, lang, request.range);
    }
    return buildBuchaReportReply(data as BuchaReportingSnapshot, request.tool, request.period, lang, request.range);
  }

  const rangeQuery = db.from('daily_records').select('id, kind, status, amount, party_name, occurred_at')
    .eq('company_id', companyId).eq('status', 'confirmed');
  const dailyQuery = request.tool === 'ai_debtors'
    ? rangeQuery.order('occurred_at', { ascending: true }).limit(10000)
    : rangeQuery.gte('occurred_at', from).lt('occurred_at', to).order('occurred_at', { ascending: true }).limit(10000);
  const { data: dailyRows, error: dailyError } = await dailyQuery;
  if (dailyError) return lang === 'sw' ? 'Sikuweza kupata taarifa za biashara sasa.' : 'I could not load business records right now.';
  const rows = (dailyRows ?? []).map((row: { kind: string; status: string; amount: number; party_name: string | null; occurred_at: string }) => ({
    kind: row.kind, status: row.status, amount: Number(row.amount), partyName: row.party_name, occurredAt: row.occurred_at,
  })) as ReadDailyRow[];

  if (request.tool === 'ai_business_summary') return buildBusinessSummaryReply(calculateBusinessSummary(rows), request.period, lang, request.range);
  if (request.tool === 'ai_business_summary_facts') {
    return businessSummaryFacts(calculateBusinessSummary(rows), request.period, lang, request.range);
  }
  if (request.tool === 'ai_debtors' || request.tool === 'ai_debtor_detail') {
    const debtors = calculateDebtors(rows);
    if (request.tool === 'ai_debtor_detail') {
      const wanted = String(request.partyName ?? '').trim().toLocaleLowerCase();
      const debtor = debtors.find((row) => row.partyName.toLocaleLowerCase() === wanted) ?? null;
      return buildDebtorDetailReply(debtor, request.partyName ?? '', lang);
    }
    return buildDebtorsReply(debtors, lang);
  }

  const ids = (dailyRows ?? []).map((row: { id: string }) => row.id);
  const { data: rawLines } = ids.length > 0
    ? await db.from('daily_record_lines').select('daily_record_id, description, quantity, line_total').in('daily_record_id', ids).limit(20000)
    : { data: [] };
  const occurredById = new Map((dailyRows ?? []).map((row: { id: string; occurred_at: string }) => [row.id, row.occurred_at]));
  const lines = (rawLines ?? []).map((line: { daily_record_id: string; description: string; quantity: number; line_total: number }) => ({
    description: line.description, quantity: Number(line.quantity), lineTotal: Number(line.line_total), occurredAt: occurredById.get(line.daily_record_id) ?? from,
  })) as ReadDailyLine[];
  const { data: rawCosts } = await db.from('product_costs').select('product_key, unit_cost, effective_from')
    .eq('company_id', companyId).order('effective_from', { ascending: true }).limit(10000);
  const costs = (rawCosts ?? []).map((cost: { product_key: string; unit_cost: number; effective_from: string }) => ({
    productKey: cost.product_key, unitCost: Number(cost.unit_cost), effectiveFrom: cost.effective_from,
  })) as ReadProductCost[];
  return buildProfitReply(calculateProfitEstimate(rows, lines, costs), request.period, lang, request.range);
}

/**
 * The user's own time words, resolved server-side. Null when they named no
 * period, in which case the coarse enum decides — so the model getting this
 * wrong can only ever fall back to today's behaviour.
 */
function assistantRange(value: unknown): ResolvedRange | null {
  return typeof value === 'string' ? resolveDateRange(value) : null;
}

function assistantPeriod(value: unknown): ReadRequest['period'] {
  return value === 'week' || value === 'month' || value === 'year' ? value : 'today';
}

function assistantProductNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim().slice(0, 100)).filter(Boolean).slice(0, 2)
    : [];
}

function assistantSelector(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 160) : '';
}

function normalizeAssistantSelector(value: string): string {
  return value.toLocaleLowerCase('sw').normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function invoiceLineItemLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return '';
    const row = item as Record<string, unknown>;
    const label = String(row.description ?? row.name ?? row.item ?? '').trim().slice(0, 100);
    const quantity = Number(row.quantity ?? row.qty);
    const amount = Number(row.amount ?? row.total ?? row.line_total);
    const parts = [label];
    if (Number.isFinite(quantity) && quantity > 0) parts.push(`x ${quantity}`);
    if (Number.isFinite(amount) && amount >= 0) parts.push(`TSh ${Math.round(amount).toLocaleString('en-US')}`);
    return parts.filter(Boolean).join(' — ');
  }).filter(Boolean);
}

/**
 * STAGE B — the language contract's executor.
 *
 * The model sends the trader's words. Everything that decides money or stock
 * happens here: the amount is normalized from the wording rather than taken
 * from the model's number, the payment word is canonicalized by the table that
 * has always known "tigopesa", the date wording goes to the same resolver the
 * deterministic path already uses, and the product is resolved against this
 * company's catalogue.
 *
 * Dispatch, not reimplementation. Every kind ends in the same draft creator the
 * deterministic parsers have always ended in, so nothing about how a record is
 * written, priced or confirmed changes here.
 */
async function pendingDraftState(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  dailyRecordId: string,
  waMessageId: string,
  record: ParsedDailyRecord,
): Promise<void> {
  const state: DailyRecordConversation = {
    kind: 'daily_record_confirmation',
    dailyRecordId,
    sourceMessageId: waMessageId,
    record,
  };
  await db.from('whatsapp_conversations').upsert({
    identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
    awaiting: 'payment_source', receipt_id: null, options: state,
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
  }, { onConflict: 'identity_id' });
}

/** A question the shop must answer before anything can be drafted. */
const askBack = (question: string): AssistantToolExecution =>
  ({ content: question, isError: true, terminalReply: question });

/**
 * The payment method, decided here and never by the model.
 *
 * MEASURED FAILURE, Stage A.1 case 9180: "nimeuza soseji 12 kwa tigopesa" was
 * recorded as CASH. The model had a four-value enum and no field for the word,
 * so a Tanzanian mobile-money brand became physical cash — and because nothing
 * kept "tigopesa", no report and no human could ever have caught it. An
 * unrecognised word is now asked about, never defaulted.
 */
function decidePayment(
  wording: string | null,
  lang: Lang,
  declaredMissing: boolean,
): { ok: true; method: DailyRecordPaymentMethod | null } | { ok: false; question: string } {
  const reading = canonicalPaymentWording(wording);
  if (reading.kind === 'absent' || reading.kind === 'credit') return { ok: true, method: null };
  if (reading.kind === 'method') return { ok: true, method: reading.method };
  // MEASURED: on "wiki iliyopita nililipa umeme 30000" the model put the verb
  // "kulipa" in payment_wording and listed payment_method as missing in the
  // same call. Asking which channel "kulipa" was would be a question about the
  // model's own slip. Its own signal that nothing was stated settles it, and
  // null is the honest value — never cash.
  if (declaredMissing) return { ok: true, method: null };
  return { ok: false, question: paymentWordingQuestion(reading.said, lang) };
}

/** The occurrence date, from the trader's wording via the existing resolver. */
function decideDate(
  wording: string | null,
  lang: Lang,
): { ok: true; occurredAt: string | null } | { ok: false; question: string } {
  const resolved = resolveTransactionDate(wording ?? undefined);
  if (resolved.kind === 'invalid') return { ok: false, question: transactionDateQuestion(resolved.reason, lang) };
  return { ok: true, occurredAt: resolved.occurredAt };
}

/** jumla and rejareja, mapped by the server from the trader's own wording. */
function bandFromWording(wording: string | null): Band | null {
  const said = String(wording ?? '').toLowerCase();
  if (!said) return null;
  if (/\b(jumla|wholesale|bulk)\b/u.test(said)) return 'wholesale';
  if (/\b(rejareja|reja|retail|kawaida)\b/u.test(said)) return 'retail';
  return null;
}

/** Every line must have a quantity the server could read for itself. */
function decideQuantities(
  event: ValidatedBusinessEvent,
  lang: Lang,
): { ok: true; quantities: number[] } | { ok: false; question: string } {
  const quantities: number[] = [];
  for (const line of event.lines) {
    if (line.quantity.kind === 'value') { quantities.push(line.quantity.value); continue; }
    if (line.quantity.kind === 'ask') return { ok: false, question: numberQuestion('quantity', line.quantity, lang) };
    return {
      ok: false,
      question: lang === 'sw'
        ? `Umesema *${line.productWording}* lakini hujasema idadi. Ni ngapi?`
        : `You mentioned *${line.productWording}* but not how many. How many?`,
    };
  }
  return { ok: true, quantities };
}

function unknownProductMessage(
  unknownProducts: string[],
  resolvedProducts: string[],
  lang: Lang,
): string {
  const missing = unknownProducts.map((product) => `*${product}*`).join(', ');
  const understood = resolvedProducts.length > 0
    ? lang === 'sw'
      ? `Nimezitambua tayari: ${resolvedProducts.map((product) => `*${product}*`).join(', ')}.\n`
      : `I understood already: ${resolvedProducts.map((product) => `*${product}*`).join(', ')}.\n`
    : '';
  return lang === 'sw'
    ? `${understood}Bado sijapata ${missing} kwenye bidhaa za biashara hii. Sajili ${missing} kwanza au taja jina lililosajiliwa.`
    : `${understood}I could not find ${missing} in this business catalogue. Register ${missing} first or use its registered name.`;
}

/**
 * Price a quantity sale against the shop's own list and draft it.
 *
 * Shared by two callers that must behave identically: the business-event tool,
 * when the trader states everything at once, and the clarification tool, when
 * they finish a question Risip had parked. The resume used to live in local
 * variables inside the message loop, which is precisely why a parked question
 * needed its own parser — nothing outside that loop could finish the sale.
 */
async function priceAndDraftSale(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  waMessageId: string,
  lang: Lang,
  args: {
    sale: QuantitySale;
    credit: { party: string } | null;
    paymentMethod: DailyRecordPaymentMethod | null;
    occurredAt: string | null;
    said?: string;
  },
): Promise<AssistantToolExecution> {
  const notUnderstood = lang === 'sw'
    ? 'Sijaelewa bidhaa, idadi au kipimo kwa uhakika. Niandikie bidhaa na idadi yake.'
    : 'I could not safely understand the product, quantity or unit. State the product and its quantity.';
  const notSaved = lang === 'sw'
    ? 'Sikuweza kuhifadhi draft hii. Hakuna rekodi iliyothibitishwa; jaribu tena.'
    : 'I could not save this draft. Nothing was confirmed; please try again.';

  const priced = await priceQuantitySale(
    db, identity, args.sale, lang, [], args.credit as never, args.occurredAt,
  );
  if (priced.kind === 'blocked') {
    const missingProducts = [...new Set(
      priced.message.match(/\*([^*]+)\*/gu)?.map((entry) => entry.slice(1, -1)) ?? [],
    )];
    // Keep the sale, not only the question. A follow-up such as
    // "rosali ni Rosali ya Maria" is a correction to this sale, not a new
    // price-setting request. The model can now see the exact original lines.
    if (missingProducts.length > 0) {
      const pending: MissingSalePricesPending = {
        kind: 'sale_missing_prices',
        missingProducts,
        sale: args.sale,
        sourceMessageId: waMessageId,
        credit: args.credit,
        paymentMethod: args.paymentMethod,
        occurredAt: args.occurredAt,
      };
      await db.from('whatsapp_conversations').upsert({
        identity_id: identity.id,
        company_id: identity.company_id,
        profile_id: identity.profile_id,
        awaiting: 'product_cost',
        receipt_id: null,
        options: pending,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'identity_id' });
    }
    if (priced.choice) {
      await parkProductChoice(
        db,
        identity,
        waMessageId,
        priced.choice.asked,
        priced.choice.candidates,
        args.said,
        args,
      );
    }
    return { content: priced.message, terminalReply: priced.message, fallbackReply: priced.message };
  }
  if (priced.kind === 'unknown') {
    if (!canUseCompanyFinanceReads(identity.role)) {
      return askBack(newProductSaleWorkerBlocked(priced.products, lang));
    }
    const state: NewProductSaleSetup = {
      kind: 'new_product_sale_setup',
      missingProducts: priced.products,
      sale: priced.sale,
      sourceMessageId: waMessageId,
      credit: args.credit,
      paymentMethod: args.paymentMethod,
      occurredAt: args.occurredAt,
    };
    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id,
      company_id: identity.company_id,
      profile_id: identity.profile_id,
      awaiting: 'product_cost',
      receipt_id: null,
      options: state,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    return askBack(newProductSaleOffer(priced.products, lang));
  }
  if (priced.kind === 'band') {
    // MEASURED REGRESSION, twice: "nimeuza nguvu ya sala 7 jumla" was asked
    // which band it wanted, by a sentence that had already said it. The word is
    // mapped here; only an absent or unmapped band reaches the question.
    // A band question that reaches here was never answered, so nothing is
    // pre-filled. The model settles it through resolve_pending_clarification.
    const chosen = null;
    const state: PriceBandPending = {
      kind: 'price_band_choice', sale: priced.sale, choices: priced.choices,
      answered: priced.choices.map(() => chosen), sourceMessageId: waMessageId,
      settled: priced.settled ?? [],
      credit: args.credit as never, paymentMethod: args.paymentMethod, occurredAt: args.occurredAt,
    };
    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
      awaiting: 'product_cost', receipt_id: null, options: state,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    const question = priceBandQuestion(priced.choices, lang, priced.settled ?? []);
    return { content: question, terminalReply: question };
  }
  if (priced.kind !== 'priced') return askBack(notUnderstood);

  const saleRecord = args.paymentMethod ? { ...priced.record, paymentMethod: args.paymentMethod } : priced.record;
  const guarded = await addHistoricalPriceWarnings(db, identity.company_id, saleRecord);
  const created = await createDailyRecordDraft(db, identity, waMessageId, guarded, lang, args.said);
  if (created.error || !created.id) return askBack(notSaved);
  // This sale has just completed a clarification (often a multi-product price
  // answer). It must show its lines, total, and one confirmation immediately.
  // A queue tick such as "Nimepokea (1/5)" is only an internal acknowledgement;
  // using it here hides the amount and leaves the trader without a safe NDIYO.
  await pendingDraftState(db, identity, created.id, waMessageId, guarded);
  const confirmation = `${identity.company_name} — ${quantitySaleConfirmation(priced.lines, lang, [], priced.notCounted)}`;
  return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
}

/**
 * How many drafts this shop may leave waiting, or null for the old behaviour.
 *
 * Read per turn rather than cached: a shop is switched onto the queue by an
 * UPDATE, and it should take effect on the next message rather than the next
 * cold start.
 */
async function recordQueueSize(db: Admin, companyId: string): Promise<number | null> {
  const { data } = await db.from('companies')
    .select('record_queue_size').eq('id', companyId).maybeSingle();
  const size = data?.record_queue_size;
  return size == null ? null : Math.max(2, Math.min(30, Number(size)));
}

async function pendingQueue(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
): Promise<QueuedRecord[]> {
  const { data } = await db.rpc('wa_pending_record_queue', {
    p_company_id: identity.company_id,
    p_profile_id: identity.profile_id,
  });
  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    kind: String(row.kind ?? ''),
    amount: Number(row.amount ?? 0),
    partyName: (row.party_name ?? null) as string | null,
    description: (row.description ?? null) as string | null,
    occurredAt: String(row.occurred_at ?? ''),
    lines: ((row.lines ?? []) as Array<Record<string, unknown>>).map((line) => ({
      description: String(line.description ?? ''),
      quantity: Number(line.quantity ?? 0),
      lineTotal: Number(line.line_total ?? 0),
    })),
  }));
}

/**
 * A tick, or — once enough have gathered — the whole batch to confirm.
 *
 * Returns null when this shop has no queue, which leaves every existing path
 * exactly as it was.
 */
async function queueRecordDraft(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  lang: Lang,
): Promise<AssistantToolExecution | null> {
  const ceiling = await recordQueueSize(db, identity.company_id as string);
  if (ceiling === null) return null;

  const waiting = await pendingQueue(db, identity);
  if (waiting.length < ceiling) {
    // No conversation is parked. A tick is not a question, and parking one
    // would make the next ordinary sentence look like an answer to it.
    await clearConversation(db, identity.id as string);
    const tick = queueTickReply(waiting.length, ceiling, lang);
    return { content: tick, terminalReply: tick };
  }
  return await askToConfirmQueue(db, identity, lang, waiting);
}

/** Park the batch and ask once. Used by the ceiling, a question, and closing. */
async function askToConfirmQueue(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  lang: Lang,
  waiting: QueuedRecord[],
): Promise<AssistantToolExecution> {
  await db.from('whatsapp_conversations').upsert({
    identity_id: identity.id,
    company_id: identity.company_id,
    profile_id: identity.profile_id,
    awaiting: 'product_cost',
    receipt_id: null,
    options: { kind: 'record_queue', ids: waiting.map((one) => one.id) } satisfies RecordQueuePending,
    expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'identity_id' });
  const question = queueFlushReply(waiting, lang);
  return { content: question, terminalReply: question };
}

/**
 * Finish a question Risip had parked, using the model's reading of the answer.
 *
 * The model says WHICH question it thinks was answered and in WHAT WORDS. This
 * decides whether those words name a legal value for the question actually on
 * the table — and refuses if the model has answered a question nobody asked.
 *
 * Every figure is re-derived: the price comes from the ledger, the product from
 * the catalogue, the permission from the identity. Nothing financial travels
 * through the parked state or through the model.
 */
/**
 * What Risip is waiting for, read off the parked conversation row.
 *
 * One function, so the description the model sees and the validation the
 * resume performs can never drift apart — they are the same source.
 */
function pendingClarificationOf(convo: { awaiting?: string | null; options?: unknown } | null): PendingClarification | null {
  const awaiting = String(convo?.awaiting ?? '');
  const options = (convo?.options ?? {}) as Record<string, unknown>;
  const kind = String(options.kind ?? '');

  if (awaiting === 'product_cost' && kind === 'product_read_choice') {
    const choice = options as unknown as ProductChoicePending;
    return { field: 'product', intent: choice.recovery ? 'sale' : 'product_lookup',
      product: choice.asked, choices: choice.candidates,
      details: `Original message: ${choice.originalText}. Select exactly one of the offered names; do not invent a product. A number refers only to the displayed candidate order.` };
  }

  if (awaiting === 'daily_record_quantity') {
    return {
      field: 'quantity',
      intent: String((options as { ledger?: string }).ledger ?? 'sale'),
      product: String((options as { product?: string }).product ?? '') || null,
    };
  }
  if (awaiting === 'product_cost' && kind === 'price_band_choice') {
    const choices = Array.isArray(options.choices)
      ? options.choices as Array<{ index?: number; product?: string; productName?: string }>
      : [];
    const names = choices.map((choice) => choice?.productName ?? choice?.product).filter(Boolean);
    const sale = options.sale as { items?: unknown } | null | undefined;
    const saleItems = Array.isArray(sale?.items)
      ? sale.items as Array<{ product?: string; quantity?: number }>
      : [];
    const settled = Array.isArray(options.settled)
      ? options.settled as Array<{ product?: string; quantity?: number }>
      : [];
    const openOrder = choices
      .map((choice, index) => `${index + 1}=${choice?.productName ?? choice?.product ?? 'product'} (sale row ${Number(choice?.index ?? index) + 1})`)
      .join(' | ');
    const fullOrder = saleItems
      .map((item, index) => `${index + 1}=${item.product ?? 'product'}${item.quantity == null ? '' : ` (${item.quantity})`}`)
      .join(' | ');
    return {
      field: 'price_band',
      intent: 'sale',
      product: names.join(', ') || null,
      details: choices.length > 1
        ? `There are ${choices.length} open products. Open-product order is: ${openOrder}. The original sale order is: ${fullOrder || openOrder}. Already-priced rows are: ${settled.map((row) => row.product ?? 'product').join(', ') || 'none'}. If the trader gives one price for all open products, return one price_band answer. If they give mixed prices, return exactly one answer per product. If they number the full original sale, return one answer per original sale row in original order; the server will ignore rows already settled. If they number only the open list, return one answer per open product in open order. canonical_value must be exactly retail or wholesale; keep raw_wording as typed. Example: "1 jumla 2 rejareja ... 12 jumla" means twelve answers in original sale order, and the already-settled row is ignored.`
        : 'One price_band answer settles this product. The trader may say the price in Kiswahili, English, or a shorthand; decide the canonical meaning and let the server validate it.',
    };
  }
  if (awaiting === 'product_cost' && (kind === 'stock_purchase_cost_amount' || kind === 'stock_purchase_cost_choice')) {
    const pending = options as Partial<StockPurchaseCostPending>;
    return {
      field: 'amount',
      intent: 'stock_purchase_cost',
      product: typeof pending.product === 'string' ? pending.product : null,
      details: kind === 'stock_purchase_cost_choice'
        ? 'The shop was shown a closed menu: 1 means reuse the last cost, 2 means enter a new total cost, and 3 means cancel. If the trader sends a number or letter from that menu, handle it as the menu answer; do not invent a cost.'
        : 'The trader chose a new cost. Return field=amount with numeric_value equal to the total cost they stated. Do not use the previous cost and do not invent a total.',
    };
  }
  if (awaiting === 'product_cost' && kind === 'new_product_quantity') {
    const products = Array.isArray(options.products)
      ? options.products as Array<{ product?: string; unit?: string | null }>
      : [];
    return {
      field: 'quantity',
      intent: 'new_product_opening_stock',
      product: products.map((product) => product.product).filter(Boolean).join(', ') || null,
      choices: ['kilo', 'lita', 'ml', 'vipande'],
      details: 'Return one quantity answer per product. Put the product name in raw_wording so the server can attach the number to the right product. A quantity is allowed to be 0. If the product has a configured unit, preserve it. For an ambiguous product such as mafuta, lotion or cream, also return field=unit with the unit the trader stated; never infer that it is liquid.',
    };
  }
  if (awaiting === 'payment_source' && kind === 'daily_record_confirmation') {
    // The draft is on the screen. NDIYO and HAPANA stay deterministic; how it
    // was paid is a sentence, and sentences belong to the model.
    return { field: 'payment_method', intent: 'sale' };
  }
  if (awaiting === 'product_cost' && kind === 'quantity_meaning_clarification') {
    return { field: 'event_type', intent: 'unknown' };
  }
  if (awaiting === 'product_cost' && kind === 'sale_missing_prices') {
    const pending = options as unknown as MissingSalePricesPending;
    const saleLines = pending.sale?.items?.map((item) => `${item.product} (${item.quantity})`).join(' | ') ?? '';
    return {
      field: 'product',
      intent: 'sale_missing_selling_price',
      product: pending.missingProducts?.join(', ') || null,
      details: `The original sale is still pending: ${saleLines}. The trader may be correcting product names, for example "rosali ni Rosali ya Maria" or "atlas ni atlasi". This is NOT a price update. If the current message corrects names, call propose_business_event again using the original quantities and the corrected product names. Use existing catalogue prices; never call propose_price_update unless the current message explicitly gives new prices. Do not call resolve_pending_clarification for this recovery state.`,
    };
  }
  return null;
}

function newProductAnswerProduct(raw: string | null, products: NewProductPricing[]): number | null {
  const text = normalizedChoice(raw ?? '');
  if (products.length === 1 && (!text || /^\d/.test(text))) return 0;
  const matches = products
    .map((product, index) => ({ index, key: normalizedChoice(product.product) }))
    .filter((product) => text === product.key || text.startsWith(`${product.key} `) || text.includes(` ${product.key} `));
  return matches.length === 1 ? matches[0].index : null;
}

function normalizedNewProductUnit(value: string | null): string | null {
  const unit = normalizedChoice(value ?? '');
  if (!unit) return null;
  if (['kg', 'kilo', 'kilos', 'kilogram', 'kilograms'].includes(unit)) return 'kilo';
  if (['lita', 'litre', 'liter', 'litres', 'liters'].includes(unit)) return 'lita';
  if (['ml', 'mililita', 'millilitre', 'milliliter'].includes(unit)) return 'ml';
  // Keep an explicitly stated count distinct from an omitted unit. This is
  // important for names such as "mafuta": oil/lotion/cream is not necessarily
  // liquid, so "mafuta vipande 3" must not be treated as an unanswered measure.
  if (['pcs', 'piece', 'pieces', 'kipande', 'vipande', 'idadi'].includes(unit)) return 'kipande';
  return unit;
}

function resolveNewProductStock(
  products: NewProductPricing[],
  answers: Array<{ field: string; rawWording: string | null; canonicalValue: string | null; numericValue: number | null }>,
): { kind: 'ready'; stock: NewProductStock[] } | { kind: 'missing'; completed: string[] } | { kind: 'invalid'; message: string } {
  const quantities = new Map<number, number>();
  const units = new Map<number, string | null>();
  for (const answer of answers) {
    if (answer.field !== 'quantity' && answer.field !== 'unit') continue;
    const index = newProductAnswerProduct(answer.rawWording, products);
    if (index === null) continue;
    if (answer.field === 'quantity') {
      if (answer.numericValue === null || !Number.isFinite(answer.numericValue)
        || answer.numericValue < 0 || answer.numericValue > 1_000_000) continue;
      quantities.set(index, answer.numericValue);
    } else {
      const unit = normalizedNewProductUnit(answer.canonicalValue);
      if (unit !== null || answer.canonicalValue) units.set(index, unit);
    }
  }

  const missing = products.filter((_product, index) => !quantities.has(index));
  if (missing.length > 0) return { kind: 'missing', completed: products
    .filter((_product, index) => quantities.has(index)).map((product) => product.product) };

  const stock: NewProductStock[] = [];
  for (const [index, product] of products.entries()) {
    const configured = normalizedNewProductUnit(product.unit) ?? product.unit ?? null;
    const selected = units.has(index) ? units.get(index)! : configured;
    if (product.unit && selected && configured !== selected) {
      return {
        kind: 'invalid',
        message: `*${product.product}* imewekwa kwa ${product.unit}. Taja quantity kwa ${product.unit}, si ${selected}.`,
      };
    }
    if (!product.unit && !selected && /(?:^|\s)(?:mafuta|oil|lotion|cream|vaseline|gel)(?:\s|$)/iu.test(product.product)) {
      return {
        kind: 'invalid',
        message: `Kwa *${product.product}* sijui bado kipimo. Taja kama ni *kilo*, *lita*, *ml* au *vipande*, pamoja na quantity, kwa mfano: _${product.product} lita 5_.`,
      };
    }
    // The stock RPC uses null for the ordinary countable base unit. The
    // internal "kipande" marker only exists long enough to distinguish an
    // explicit count from an omitted unit during validation.
    stock.push({ product: product.product, quantity: quantities.get(index)!, unit: selected === 'kipande' ? null : selected });
  }
  return { kind: 'ready', stock };
}

function parseNewProductNumericList(body: string, products: NewProductPricing[]): number[] | null {
  if (products.length < 2 || !/^\s*[0-9]+(?:\.[0-9]+)?(?:\s*[,;]\s*[0-9]+(?:\.[0-9]+)?)+\s*$/u.test(body)) return null;
  const values = body.split(/[,;]/u).map((value) => Number(value.trim()));
  return values.length === products.length && values.every((value) => Number.isFinite(value) && value >= 0 && value <= 1_000_000)
    ? values
    : null;
}

async function resumeSaleAfterNewProductRegistration(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  waMessageId: string,
  lang: Lang,
  products: NewProductPricing[],
  pendingSale: QuantitySale,
  sourceMessageId: string | undefined,
  pendingDirection: NewProductPricingState['pendingDirection'],
  credit: { party: string } | null,
  paymentMethod: QuantityWanted['paymentMethod'] | null,
  occurredAt: string | null,
): Promise<{ message: string; conversationKept: boolean }> {
  if (pendingDirection === 'ask') {
    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
      awaiting: 'product_cost', receipt_id: null,
      options: {
        kind: 'quantity_meaning_clarification',
        sourceMessageId: sourceMessageId ?? waMessageId,
        originalText: '', sale: pendingSale, missingProducts: [],
        resolvedProducts: pendingSale.items.map((item) => item.product),
      },
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    return {
      message: `${newProductSaved(products, lang, 'question')}\n\n`
        + quantityMeaningQuestion(lang, [], pendingSale.items.map((item) => item.product), true),
      conversationKept: true,
    };
  }
  if (pendingDirection === 'stock_purchase') {
    await clearConversation(db, identity.id as string);
    return {
      message: `${newProductSaved(products, lang, true)}\n\n` + stockPurchaseNeedsPrices({
        kind: 'quantity_meaning_clarification',
        sourceMessageId: sourceMessageId ?? waMessageId,
        originalText: '', sale: pendingSale,
      }, lang),
      conversationKept: false,
    };
  }
  if (!sourceMessageId) {
    await clearConversation(db, identity.id as string);
    return { message: newProductSaved(products, lang), conversationKept: false };
  }

  const priced = await priceQuantitySale(db, identity, pendingSale, lang, [], credit, occurredAt);
  if (priced.kind === 'band') {
    const state: PriceBandPending = {
      kind: 'price_band_choice', sale: priced.sale, choices: priced.choices,
      answered: priced.choices.map(() => null), sourceMessageId,
      settled: priced.settled ?? [],
      credit, paymentMethod, occurredAt,
    };
    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
      awaiting: 'product_cost', receipt_id: null, options: state,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    return {
      message: `${newProductSaved(products, lang, true)}\n\n` + priceBandQuestion(priced.choices, lang, priced.settled ?? []),
      conversationKept: true,
    };
  }
  if (priced.kind !== 'priced') {
    await clearConversation(db, identity.id as string);
    return {
      message: `${newProductSaved(products, lang)}\n\n${priced.kind === 'blocked' ? priced.message : (lang === 'sw'
        ? 'Sikuweza kuandaa mauzo yaliyokuwa yanasubiri. Hayajathibitishwa; yatume tena.'
        : 'I could not prepare the waiting sale. It was not confirmed; please send it again.')}`,
      conversationKept: false,
    };
  }

  const record = await addHistoricalPriceWarnings(db, identity.company_id,
    paymentMethod ? { ...priced.record, paymentMethod } : priced.record);
  const records: ParsedDailyRecord[] = [record, ...pendingSale.expenses.map((spent) => ({
    kind: 'expense' as const, amount: spent.amount, partyName: null,
    description: spent.label, lines: [], confidence: 0.95,
  }))];
  if (records.length > 1) {
    const batch = await createDailyRecordBatchDrafts(db, identity, sourceMessageId, records, lang);
    if (!batch.error && batch.ids.length > 0) {
      await db.from('whatsapp_conversations').upsert({
        identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
        awaiting: 'payment_source', receipt_id: null,
        options: { kind: 'daily_record_batch_confirmation', dailyRecordIds: batch.ids, sourceMessageId, records },
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'identity_id' });
      return {
        message: `${newProductSaved(products, lang, true)}\n\n${quantitySaleConfirmation(
          priced.lines, lang, pendingSale.expenses, [],
        )}`,
        conversationKept: true,
      };
    }
  } else {
    const created = await createDailyRecordDraft(db, identity, sourceMessageId, record, lang);
    if (!created.error && created.id) {
      await db.from('whatsapp_conversations').upsert({
        identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
        awaiting: 'payment_source', receipt_id: null,
        options: { kind: 'daily_record_confirmation', dailyRecordId: created.id, sourceMessageId, record },
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'identity_id' });
      return {
        message: `${newProductSaved(products, lang, true)}\n\n${quantitySaleConfirmation(priced.lines, lang, [], [],)}`,
        conversationKept: true,
      };
    }
  }
  await clearConversation(db, identity.id as string);
  return {
    message: `${newProductSaved(products, lang)}\n\n${lang === 'sw'
      ? 'Sikuweza kuandaa mauzo yaliyokuwa yanasubiri. Hayajathibitishwa; yatume tena.'
      : 'I could not prepare the waiting sale. It was not confirmed; please send it again.'}`,
    conversationKept: false,
  };
}

async function createStockPurchaseDraftFromCost(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  waMessageId: string,
  pending: StockPurchaseCostPending,
  total: number,
  lang: Lang,
): Promise<AssistantToolExecution> {
  const record: ParsedDailyRecord = {
    kind: 'stock_purchase',
    amount: total,
    partyName: pending.supplier,
    description: null,
    lines: [{
      description: pending.product,
      quantity: pending.quantity,
      unit_amount: Math.round((total / pending.quantity) * 100) / 100,
      ...(pending.unit ? { unit: pending.unit } : {}),
    }],
    confidence: 0.95,
    ...(pending.paymentMethod ? { paymentMethod: pending.paymentMethod as DailyRecordPaymentMethod } : {}),
  };
  const created = await createDailyRecordDraft(db, identity, waMessageId, record, lang);
  if (created.error || !created.id) {
    const failed = lang === 'sw'
      ? 'Sikuweza kuhifadhi draft ya mzigo huu. Hakuna kilichothibitishwa; jaribu tena.'
      : 'I could not save this stock draft. Nothing was confirmed; please try again.';
    return { content: failed, terminalReply: failed, isError: true };
  }
  await pendingDraftState(db, identity, created.id, waMessageId, record);
  const confirmation = buildDailyRecordConfirmation(record, lang);
  return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
}

async function executeClarification(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  waMessageId: string,
  lang: Lang,
  input: Record<string, unknown>,
  said?: string,
): Promise<AssistantToolExecution> {
  const answers = validateClarificationAnswers(input);
  if (answers.length === 0) {
    return askBack(lang === 'sw'
      ? 'Sijaelewa jibu lako. Niandikie tena kwa maneno mengine.'
      : 'I did not catch that answer. Say it another way.');
  }

  const convo = await loadConversation(db, identity.id as string);
  const pending = pendingClarificationOf(convo);
  if (!pending) {
    // MEASURED, and it threw away nine products. The owner was shown a stock
    // count at 13:58 and asked to confirm it. He answered at 14:29 by sending
    // the same nine lines again — and the parked question had expired at 14:28,
    // thirty minutes after it was asked and ONE MINUTE before he replied.
    //
    // The model still saw the question in the conversation history, reasonably
    // decided this message answered it, and called this tool. The server was
    // right that nothing was pending. What it did next was the fault: it
    // replied "Sina swali linalosubiri jibu kwa sasa. Niambie unachotaka
    // kufanya", which is a dead end. His nine products were dropped, and he
    // was told nothing about them.
    //
    // Being right about the state is not the same as being useful. This is now
    // an error the MODEL can recover from — no terminalReply, so the turn
    // continues and it answers the message that is actually in front of it.
    // The shopkeeper never learns that any of this happened, because from
    // where he stands nothing did: he sent a list and he should get an answer
    // about the list.
    return {
      content: 'no_pending_question=true\n'
        + 'The question you were answering has expired or was already settled. '
        + 'Explain briefly that the previous question is no longer active. Do not reinterpret '
        + 'a bare number or letter as a new transaction, and do not claim anything was saved. '
        + 'Ask the trader to restate or review the intended operation with its products and quantities.',
      isError: true,
    };
  }

  const options = (convo?.options ?? {}) as Record<string, unknown>;
  if (options.kind === 'product_read_choice') {
    const choice = options as unknown as ProductChoicePending;
    const requested = answers.find((answer) => answer.field === 'product')?.canonicalValue;
    const selected = choice.candidates.find((candidate) => normalizedChoice(candidate) === normalizedChoice(requested ?? ''));
    if (!selected) return { content: 'Select exactly one of the offered product candidates; ask if uncertain.', isError: true };
    if (!choice.recovery) return { content: `Selected product: ${selected}. Original question: ${choice.originalText}. Call the appropriate live read tool with this product.`, isError: true };
    const recovery = choice.recovery;
    const sale = { ...recovery.sale, items: recovery.sale.items.map((item) =>
      normalizedChoice(item.product) === normalizedChoice(choice.asked) ? { ...item, product: selected } : item) };
    return await priceAndDraftSale(db, identity, waMessageId, lang, { ...recovery, sale, said: choice.originalText });
  }
  if (options.kind === 'sale_missing_prices') {
    return {
      content: 'This is a sale recovery state, not a closed-choice question. Re-read the original sale and call propose_business_event with the corrected product names and original quantities. Do not set prices from history.',
      isError: true,
    };
  }
  // One message can settle several facts — "mpesa na ilikuwa jana", "hisense
  // kilo tatu". Each is taken on its own; whatever is valid survives even when
  // something else in the same breath does not.
  const byField = new Map(answers.map((answer) => [answer.field, answer]));
  const main = byField.get(pending.field);
  if (!main) {
    return askBack(lang === 'sw'
      ? `Nilikuwa naulizia ${pending.field}. Naomba unijibu hilo kwanza.`
      : `I was asking about ${pending.field}. Answer that one first.`);
  }

  // A new cost after the stock-arrival menu is still interpreted by the model;
  // this branch only range-checks its numeric reading and creates the same
  // pending stock draft as the ordinary purchase path.
  if (pending.field === 'amount' && options.kind === 'stock_purchase_cost_amount') {
    const read = checkNumber(main.numericValue, 100_000_000);
    if (read.kind === 'ask') {
      return askBack(lang === 'sw'
        ? 'Sijaelewa gharama mpya. Andika jumla kwa tarakimu, mfano *60000*.'
        : 'I could not read the new cost. Write the total in digits, for example *60000*.');
    }
    const draft = await createStockPurchaseDraftFromCost(
      db, identity, waMessageId, options as StockPurchaseCostPending, read.value, lang,
    );
    return draft;
  }

  // ── opening stock for a newly registered product ─────────────────────────
  // This is a multi-product quantity question. The model reads the trader's
  // sentence (including "robo", "nusu", "lita" and Swahili number words); the
  // server only bounds the number, attaches it to an exact product name from
  // the parked list, and checks the unit against the product's own measure.
  if (pending.field === 'quantity' && options.kind === 'new_product_quantity') {
    const products = Array.isArray(options.products) ? options.products as NewProductPricing[] : [];
    const previous = Array.isArray(options.stockAnswers) ? options.stockAnswers as StockAnswer[] : [];
    const merged = mergeStockAnswers(previous, answers, products.map((product) => product.product));
    const resolved = resolveNewProductStock(products, merged);
    if (resolved.kind === 'missing' || resolved.kind === 'invalid') {
      const { error } = await db.from('whatsapp_conversations').update({
        options: { ...options, stockAnswers: merged }, updated_at: new Date().toISOString(),
      }).eq('identity_id', identity.id).eq('company_id', identity.company_id);
      if (error) return { content: 'Could not retain the quantity answers. Ask to retry; do not claim they were saved.', isError: true };
    }
    if (resolved.kind === 'missing') {
      const question = newProductQuantityIncomplete(products, resolved.completed, lang);
      return { content: question, terminalReply: question };
    }
    if (resolved.kind === 'invalid') {
      return { content: resolved.message, terminalReply: resolved.message };
    }
    const state: NewProductRegistrationConfirmationState = {
      ...(options as unknown as Omit<NewProductQuantityState, 'kind'>),
      kind: 'new_product_registration_confirmation',
      stock: resolved.stock,
    };
    const { error: stateError } = await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id,
      company_id: identity.company_id,
      profile_id: identity.profile_id,
      awaiting: 'product_cost',
      receipt_id: null,
      options: state,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    if (stateError) return { content: 'Could not retain the registration preview. Nothing was confirmed; ask to retry.', isError: true };
    const question = newProductRegistrationConfirmation(products, resolved.stock, lang);
    return { content: question, terminalReply: question };
  }

  // ── which price the shop meant ───────────────────────────────────────────
  if (pending.field === 'price_band') {
    const bandAnswers = answers.filter((answer) => answer.field === 'price_band');
    const bands = bandAnswers.map((answer) => {
      const checked = checkCanonicalValue('price_band', answer.canonicalValue);
      return checked.kind === 'ok' ? asBand(checked.value) : null;
    });
    if (bands.length === 0 || bands.some((band) => band === null)) {
      const pendingBand = options as unknown as PriceBandPending;
      const question = priceBandQuestion(pendingBand.choices ?? [], lang, pendingBand.settled ?? []);
      return { content: question, terminalReply: question };
    }
    const bandPending = options as unknown as PriceBandPending;
    const choices = bandPending.choices ?? [];
    const openChoices = choices.filter((_, at) => bandPending.answered?.[at] == null);
    const openSaleIndexes = openChoices.map((choice) => Number(choice.index));
    // One model answer means one band for every open row. Multiple model
    // answers may be ordered by the open question or by every original sale
    // row. The model, not a word parser, decided each meaning.
    const aligned = alignPriceBandAnswers(
      bands,
      Array.isArray(bandPending.sale?.items) ? bandPending.sale.items.length : 0,
      openSaleIndexes,
    );
    if (!aligned) {
      const question = priceBandQuestion(choices, lang, bandPending.settled ?? []);
      return { content: question, terminalReply: question };
    }
    const settled = choices.map((_, at) => {
      const previous = bandPending.answered?.[at] ?? null;
      if (previous !== null) return previous;
      if (aligned.length === 1) return aligned[0];
      const openAt = openChoices.indexOf(choices[at]);
      return openAt >= 0 ? aligned[openAt] : null;
    });
    await clearConversation(db, identity.id as string);
    return await priceAndDraftSale(db, identity, waMessageId, lang, {
      sale: { ...bandPending.sale, items: applyPriceBands(bandPending.sale.items, choices, settled) },
      credit: bandPending.credit ?? null,
      paymentMethod: paymentFrom(byField) ?? bandPending.paymentMethod ?? null,
      occurredAt: bandPending.occurredAt ?? null,
      said,
    });
  }

  // ── how many, and in what measure ────────────────────────────────────────
  if (pending.field === 'quantity') {
    const read = checkNumber(main.numericValue);
    if (read.kind === 'ask') {
      return askBack(lang === 'sw'
        ? 'Sijaelewa idadi. Niandikie kwa tarakimu, mfano *3*.'
        : 'I could not read the quantity. Write it in digits, for example *3*.');
    }
    const wanted = options as unknown as QuantityWanted;
    // A unit answered in the same breath rides along: "kilo tatu" settles both.
    const unit = byField.get('unit')?.canonicalValue ?? main.canonicalValue ?? null;
    await clearConversation(db, identity.id as string);
    return await priceAndDraftSale(db, identity, waMessageId, lang, {
      sale: {
        kind: 'quantity_sale',
        items: [{
          product: wanted.product,
          quantity: read.value,
          band: null,
          ...(unit ? { spokenUnit: unit } : {}),
        }],
        expenses: [],
      },
      credit: wanted.ledger === 'debt_issued' && wanted.party ? { party: wanted.party } : null,
      paymentMethod: paymentFrom(byField) ?? wanted.paymentMethod ?? null,
      occurredAt: wanted.occurredAt ?? null,
      said,
    });
  }

  // ── what kind of movement a bare list was ────────────────────────────────
  if (pending.field === 'event_type') {
    const checked = checkCanonicalValue('event_type', main.canonicalValue);
    if (checked.kind !== 'ok') {
      return askBack(lang === 'sw'
        ? 'Hizo ni mauzo, manunuzi, au unahesabu stock?'
        : 'Are those sales, purchases, or a stock count?');
    }
    if (checked.value !== 'sale') {
      // Only a sale can be finished from here. A purchase needs its cost and a
      // count needs its own confirmation, and neither is safe to infer from a
      // single word.
      return askBack(lang === 'sw'
        ? 'Sawa. Niandikie tena ukiwa na maelezo kamili — kwa manunuzi niambie ulilipa kiasi gani, na kwa hesabu niambie idadi iliyopo.'
        : 'Understood. Send it again with the detail — for a purchase tell me what you paid, and for a count tell me what is on the shelf.');
    }
    const meaning = options as unknown as { sale?: QuantitySale };
    if (!meaning.sale) return askBack(lang === 'sw' ? 'Sina orodha inayosubiri.' : 'I have no parked list.');
    await clearConversation(db, identity.id as string);
    return await priceAndDraftSale(db, identity, waMessageId, lang, {
      sale: meaning.sale, credit: null, paymentMethod: paymentFrom(byField),
      occurredAt: null, said,
    });
  }

  // ── how it was paid, on a draft already on the screen ────────────────────
  //
  // MEASURED: "mpesa" arriving beside a pending draft used to be read by
  // parsePaymentMethodAnswer, a phrase list of Tanzanian mobile-money brands
  // sitting in the normal path. The model decides the method now; this only
  // checks it is one of the four the ledger accepts, and updates the SAME
  // draft so nothing is saved a moment earlier than it would have been.
  if (pending.field === 'payment_method') {
    const checked = checkCanonicalValue('payment_method', main.canonicalValue);
    if (checked.kind !== 'ok') {
      return askBack(lang === 'sw'
        ? 'Ulilipwa kwa njia gani — taslimu, simu, au benki?'
        : 'How were you paid — cash, mobile money, or bank?');
    }
    const draft = options as unknown as DailyRecordConversation;
    if (!draft?.dailyRecordId) {
      return askBack(lang === 'sw' ? 'Sina draft inayosubiri.' : 'I have no draft waiting.');
    }
    const { data: methodSet } = await db.rpc('wa_set_draft_payment_method', {
      p_profile_id: identity.profile_id,
      p_company_id: identity.company_id,
      p_daily_record_id: draft.dailyRecordId,
      p_payment_method: checked.value,
    });
    if (!(methodSet as Record<string, unknown> | null)?.updated) {
      return askBack(lang === 'sw'
        ? 'Sikuweza kuweka njia ya malipo kwenye draft hii.'
        : 'I could not set the payment method on this draft.');
    }
    const withMethod = {
      ...draft.record,
      paymentMethod: checked.value as DailyRecordPaymentMethod,
    };
    await pendingDraftState(db, identity, draft.dailyRecordId, waMessageId, withMethod);
    const confirmation = buildDailyRecordConfirmation(withMethod, lang);
    return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
  }

  // ── which product, and which measure, when the shop has said ─────────────
  //
  // Neither of these parks a state of its own today: an ambiguous product ends
  // the sale rather than holding it, and a unit rides on the quantity question.
  // Answering here would mean inventing a draft that was never saved, so the
  // honest thing is to say what was understood and ask for it once.
  const understood = main.canonicalValue ?? main.rawWording ?? '';
  return askBack(lang === 'sw'
    ? `Nimeelewa: ${understood}. Niandikie ujumbe kamili ili niukamilishe.`
    : `Understood: ${understood}. Send the whole message so I can complete it.`);
}

/**
 * A payment method settled in the same breath as something else.
 *
 * Checked, not read: the model decided what the trader meant, and this only
 * confirms it is one of the four the ledger accepts.
 */
function paymentFrom(
  byField: Map<string, { canonicalValue: string | null }>,
): DailyRecordPaymentMethod | null {
  const answered = byField.get('payment_method');
  if (!answered) return null;
  const checked = checkCanonicalValue('payment_method', answered.canonicalValue);
  return checked.kind === 'ok' ? checked.value as DailyRecordPaymentMethod : null;
}

async function executeBusinessEvent(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  waMessageId: string,
  lang: Lang,
  input: Record<string, unknown>,
  said?: string,
): Promise<AssistantToolExecution> {
  const notUnderstood = lang === 'sw'
    ? 'Sijaelewa bidhaa, idadi au kipimo kwa uhakika. Niandikie bidhaa na idadi yake.'
    : 'I could not safely understand the product, quantity or unit. State the product and its quantity.';
  const notSaved = lang === 'sw'
    ? 'Sikuweza kuhifadhi draft hii. Hakuna rekodi iliyothibitishwa; jaribu tena.'
    : 'I could not save this draft. Nothing was confirmed; please try again.';

  const event = validateBusinessEvent(input);
  if (!event) return askBack(notUnderstood);

  // ── A LIST OF NUMBERS IS NOT AN INSTRUCTION ──────────────────────────────
  //
  // MEASURED, on the owner's own number. He sent nine products and their
  // counts with no verb anywhere, and Risip filed it as a stock count without
  // asking. His words: "hii ingetakiwa iniulize kama ni mauzo, manunuzi, au
  // unaongeza idadi kwenye stoo ili mtu achague."
  //
  // He is right, and it is the most expensive ambiguity in the product. The
  // same nine lines are three different messages — goods SOLD, goods BOUGHT,
  // or a COUNT of what is on the shelf — and they move the ledger in opposite
  // directions. Guessing "count" on a message that meant "sales" erases a
  // day's takings and overwrites the shelf at the same time.
  //
  // The required AI direction field distinguishes an interpreted operation
  // from an ambiguous list. The backend rejects kind/direction contradictions.
  // No word list may decide the operation after the model has interpreted it.
  // A BARE NUMBER IS NEVER AN AMBIGUOUS PRODUCT LIST.
  //
  // MEASURED, telemetry 14:03: "Ongeza Nguvu ya Sala 10 stoo" was drafted by
  // the model as a stock_purchase and asked its cost. The owner answered
  // "80000". The model understood it — it re-drafted the stock_purchase with
  // the amount — but the server then re-derived the direction from the raw
  // message "80000", saw no direction word in it, and asked MAUZO/ONGEZA/SAJILI
  // all over again. The direction was stated in the ORIGINAL message and the
  // model carried it; the amount answer cannot un-state it. The MAUZO/ONGEZA/
  // SAJILI question exists to disambiguate a fresh product-quantity list, and a
  // message that is only a number is never one, so it must not re-trigger it.
  // Direction is interpreted by AI from the complete message and active state.
  // This guard checks consistency, never verbs or spelling in the user's text.
  const direction = validateAiEventDirection(input);
  if (direction === 'invalid') return { content: 'invalid_event_direction: supply the contextual direction consistent with kind, or unclear when it needs clarification. No proposal was executed.', isError: true };
  if (direction === 'clarify' && event.lines.length > 0) {
    const asList = event.lines
      .map((line) => `${line.productWording} ${line.quantityWording ?? ''}`.trim())
      .join('\n');
    const quantities = decideQuantities(event, lang);
    if (!quantities.ok) return askBack(quantities.question);
    const sale: QuantitySale = { kind: 'quantity_sale', expenses: [], items: event.lines.map((line, index) => ({
      product: line.productWording, quantity: quantities.quantities[index], spokenUnit: line.unitWording,
      band: bandFromWording(line.priceBandWording ?? event.priceBandWording),
    })) };
    {
      // WHICH OF THESE DOES THE SHOP ALREADY SELL?
      //
      // The owner's improvement: "kama ai imenotice bidhaa ambazo hazipo ndio
      // iseme pia kuna bidhaa naona hazipo kwenye stoo yako hizi ni mpya kama
      // ni mpya chagua manunuzi."
      //
      // Read from the catalogue directly rather than from the pricing path,
      // which only reports names when something FAILS to resolve. Ask it about
      // nine products it knows and it answers with two empty lists — which is
      // exactly what the owner was shown: a question that knew nothing about
      // his own shop while the answer sat one query away.
      // Through the SAME resolver the draft itself uses, and MEASURED is why.
      // My first version compared normalised names against the catalogue and
      // called that a lookup. The owner sent eleven products, two of them
      // genuinely new, and was told SEVEN were new: "Puch" is registered as
      // punch, and the others are shorthand for names the shop keeps in longer
      // form. Exact string matching is not what "does this shop sell it" means
      // here — one transposed letter behind a counter is the normal case, which
      // is exactly what wa_resolve_company_product_read exists to absorb.
      //
      // Ambiguous counts as KNOWN. Several candidates means the shop sells it
      // more than one way, not that it has never heard of it; calling that new
      // would offer to register a product it already stocks twice over.
      const { data: catalogueRows } = await db.rpc('company_product_names', {
        p_company_id: identity.company_id,
      });
      const catalogue = ((catalogueRows ?? []) as Array<Record<string, unknown>>)
        .map((row) => String(row.product_name ?? '').trim())
        .filter(Boolean);

      const missingProducts: string[] = [];
      const resolvedProducts: string[] = [];
      for (const item of sale.items) {
        const found = await resolveProductForRead(db, identity, item.product);
        // The exact resolver first — it is the one that would bill this line.
        // Then the looser question, which is the only one being asked here:
        // does the shop plausibly already stock it? Three of the owner's five
        // "new" products were a missing letter, a short name and a word that
        // opens TWO registered books. The exact resolver is right to refuse all
        // three, because it is being asked which single product to bill and
        // there is no honest answer. Telling him he does not sell them is a
        // different claim, and a false one.
        const known = (!found.error && found.resolution.kind !== 'not_found')
          || shopMayAlreadyStock(item.product, catalogue);
        const target = known ? resolvedProducts : missingProducts;
        if (!target.includes(item.product)) target.push(item.product);
      }
      const parked: ParkedQuantityMeaning = {
        kind: 'quantity_meaning_clarification',
        sourceMessageId: waMessageId,
        originalText: said ?? asList,
        sale,
        missingProducts,
        resolvedProducts,
      };
      await db.from('whatsapp_conversations').upsert({
        identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
        awaiting: 'product_cost', receipt_id: null, options: parked,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'identity_id' });
      const question = quantityMeaningQuestion(lang, missingProducts, resolvedProducts);
      return { content: question, terminalReply: question };
    }
  }

  const date = decideDate(event.occurredAtWording, lang);
  if (!date.ok) return askBack(date.question);
  const payment = decidePayment(event.paymentWording, lang, event.missingFields.includes('payment_method'));
  if (!payment.ok) return askBack(payment.question);
  // Credit and a payment channel are mutually exclusive facts. The credit
  // wording wins over any channel the model may also have sent.
  const paymentMethod = event.creditWording ? null : payment.method;

  // ── a sale, or a customer taking goods on credit ─────────────────────────
  if (event.kind === 'sale' || event.kind === 'credit_sale') {
    const quantities = decideQuantities(event, lang);
    if (!quantities.ok) return askBack(quantities.question);
    const sale: QuantitySale = {
      kind: 'quantity_sale',
      items: event.lines.map((line, index) => ({
        product: line.productWording,
        quantity: quantities.quantities[index],
        spokenUnit: line.unitWording,
        // The band the SHOP said, mapped by the server. The model sends the
        // word; it never sends a band and never sends a price.
        // A band belongs to the product line that carried the wording. The
        // message-level value remains a compatibility fallback for a sentence
        // such as "nimeuza bidhaa 2 rejareja" where one band explicitly covers
        // every line. Never let a different line's "jumla" overwrite this one.
        band: bandFromWording(line.priceBandWording ?? event.priceBandWording),
      })),
      // Money out at the foot of a closing paste. A single business event
      // never carries them; propose_money_event is where an expense lives.
      expenses: [],
    };
    const credit = event.kind === 'credit_sale'
      ? { partyName: event.partyWording ?? null, wording: event.creditWording ?? null }
      : null;
    return await priceAndDraftSale(db, identity, waMessageId, lang, {
      sale, credit: credit as never, paymentMethod,
      occurredAt: date.occurredAt, said,
    });
  }

  // ── goods taken from a supplier on credit ────────────────────────────────
  if (event.kind === 'supplier_credit_purchase') {
    const supplierName = event.supplierWording ?? event.partyWording;
    if (!supplierName) {
      return askBack(lang === 'sw'
        ? 'Umechukua mzigo kwa deni — lakini kwa nani? Taja jina la msambazaji.'
        : 'Goods taken on credit — but from whom? Name the supplier.');
    }
    const quantities = decideQuantities(event, lang);
    if (!quantities.ok) return askBack(quantities.question);
    if (event.amount.kind === 'ask') return askBack(numberQuestion('amount', event.amount, lang));
    const purchase: SupplierCreditPurchase = {
      supplierName,
      // Null is honest. A shop that says "nimechukua kilo 200 kwa deni" has not
      // said what it will owe, and the payable is settled when the invoice is.
      amount: event.amount.kind === 'value' ? event.amount.value : null,
      lines: event.lines.map((line, index) => ({
        description: line.productWording,
        quantity: quantities.quantities[index],
        unit: line.unitWording,
      })),
    };
    const created = await createSupplierCreditPurchaseDraft(db, identity, waMessageId, purchase, date.occurredAt);
    if (created.clarification) return askBack(created.clarification);
    if (created.error || !created.id || !created.record) {
      return askBack(lang === 'sw'
        ? 'Sikuweza kuhifadhi draft ya mzigo huu wa deni. Hakuna kitu kilichothibitishwa.'
        : 'I could not save this supplier credit draft. Nothing was confirmed.');
    }
    await pendingDraftState(db, identity, created.id, waMessageId, created.record);
    const confirmation = buildDailyRecordConfirmation(created.record, lang);
    return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
  }

  // ── spoilage, and stock the owner took home ──────────────────────────────
  if (event.kind === 'stock_loss' || event.kind === 'owner_use') {
    const quantities = decideQuantities(event, lang);
    if (!quantities.ok) return askBack(quantities.question);
    const line = event.lines[0];
    const found = await resolveProductForRead(db, identity, line.productWording);
    if (found.error || found.resolution.kind !== 'matched') {
      // Subtracting the wrong product is worse than subtracting nothing.
      return askBack(found.resolution.kind === 'ambiguous'
        ? (lang === 'sw'
          ? `Sina uhakika ni bidhaa ipi: ${found.resolution.candidates.map((candidate) => `*${candidate.productName}*`).join(', ')}. Itaje kwa jina kamili.`
          : `I am not sure which product this is: ${found.resolution.candidates.map((candidate) => `*${candidate.productName}*`).join(', ')}. Name it in full.`)
        : (lang === 'sw'
          ? `Sina *${line.productWording}* kwenye bidhaa zako, kwa hiyo siwezi kuipunguza kwenye stock.`
          : `I do not have *${line.productWording}* among your products, so I cannot take it off your stock.`));
    }
    const match = found.resolution.match;
    const { data: costRows } = await db.rpc('wa_product_pricing', {
      p_company_id: identity.company_id, p_product_keys: [match.productKey],
    });
    const rawCost = Number(((costRows ?? []) as Array<Record<string, unknown>>)[0]?.unit_cost ?? 0);
    // product_costs enforces unit_cost > 0, so anything else means this shop
    // has never said what the product costs. The loss is still real.
    const unitCost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : null;
    const quantity = quantities.quantities[0];
    const value = unitCost === null ? null : Math.round(unitCost * quantity * 100) / 100;
    const record: ParsedDailyRecord = {
      kind: event.kind,
      // Zero means "not valued", reachable only when the cost engine returned
      // nothing. Reporting counts these apart so nothing calls a loss free.
      amount: value ?? 0,
      partyName: null,
      description: null,
      lines: [{
        description: match.productName,
        quantity,
        unit_amount: unitCost ?? 0,
        ...(line.unitWording ? { unit: line.unitWording } : {}),
      }],
      confidence: 0.99,
      ...(event.kind === 'stock_loss' ? { lossReason: event.lossReasonWording ?? null } : {}),
    };
    const created = await createDailyRecordDraft(db, identity, waMessageId, record, lang, said);
    if (created.error || !created.id) return askBack(notSaved);
    await pendingDraftState(db, identity, created.id, waMessageId, record);
    const reading = {
      kind: event.kind, product: match.productName, quantity,
      unit: line.unitWording, reason: event.lossReasonWording ?? '',
    };
    const confirmation = event.kind === 'stock_loss'
      ? stockLossConfirmation(reading as never, match.productName, value, lang)
      : ownerUseConfirmation(reading as never, match.productName, value, lang);
    return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
  }

  // ── stock arriving, paid for ─────────────────────────────────────────────
  if (event.kind === 'stock_purchase') {
    const quantities = decideQuantities(event, lang);
    if (!quantities.ok) return askBack(quantities.question);
    if (event.amount.kind === 'ask') return askBack(numberQuestion('amount', event.amount, lang));
    if (event.amount.kind === 'absent') {
      // OFFER THE LAST PRICE, do not just ask into the void.
      //
      // The owner's ask: "hiyo bidhaa sii ngeni sababu buying price ipo" — if
      // the shop already bought this product, it already knows roughly what a
      // unit costs, so a restock should quote that and let him confirm or
      // correct it, instead of making him look it up and retype it every time.
      // The amount is still HIS to state, because a purchase price changes with
      // every load; this only saves him the typing when it has not.
      //
      // Best-effort: if the lookup finds nothing, or the shop trades this in
      // several units, it falls back to the plain question rather than quote a
      // number it is unsure of.
      let lastCostHint = '';
      if (event.lines.length === 1) {
        const only = event.lines[0].productWording;
        const resolved = await resolveProductForRead(db, identity, only);
        if (!resolved.error && resolved.resolution.kind === 'matched') {
          const { data: pricing } = await db.rpc('wa_product_pricing', {
            p_company_id: identity.company_id,
            p_product_keys: [resolved.resolution.match.productKey],
          });
          const cost = ((pricing ?? []) as Array<Record<string, unknown>>)[0]?.unit_cost;
          const unit = cost == null ? null : Number(cost);
          const qty = quantities.quantities[0];
          if (unit && unit > 0 && qty > 0) {
            const pending: StockPurchaseCostPending = {
              kind: 'stock_purchase_cost_choice',
              product: resolved.resolution.match.productName,
              quantity: qty,
              unit: event.lines[0].unitWording,
              lastUnitCost: unit,
              supplier: event.supplierWording ?? event.partyWording ?? null,
              paymentMethod,
              occurredAt: date.occurredAt,
              sourceMessageId: waMessageId,
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'product_cost',
              receipt_id: null,
              options: pending,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            lastCostHint = stockPurchaseCostQuestion(pending, lang);
          }
        }
      }
      return askBack(lastCostHint || (lang === 'sw'
        ? 'Umeingiza mzigo — ulilipa kiasi gani? Niandikie kwa tarakimu.'
        : 'Stock came in — how much did you pay? Write it in digits.'));
    }
    const total = event.amount.value;
    const count = event.lines.length;
    const record: ParsedDailyRecord = {
      kind: 'stock_purchase',
      amount: total,
      partyName: event.supplierWording ?? event.partyWording ?? null,
      description: null,
      lines: event.lines.map((line, index) => ({
        description: line.productWording,
        quantity: quantities.quantities[index],
        // The shop stated one total for the load. Splitting it is the server's
        // arithmetic, never the model's.
        unit_amount: Math.round((total / count / quantities.quantities[index]) * 100) / 100,
        ...(line.unitWording ? { unit: line.unitWording } : {}),
      })),
      confidence: 0.95,
      ...(paymentMethod ? { paymentMethod } : {}),
    };
    const created = await createDailyRecordDraft(db, identity, waMessageId, record, lang, said);
    if (created.error || !created.id) return askBack(notSaved);
    await pendingDraftState(db, identity, created.id, waMessageId, record);
    const confirmation = buildDailyRecordConfirmation(record, lang);
    return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
  }

  // ── buying a live animal ─────────────────────────────────────────────────
  if (event.kind === 'whole_animal_procurement') {
    if (event.amount.kind === 'ask') return askBack(numberQuestion('amount', event.amount, lang));
    if (event.amount.kind === 'absent') {
      return askBack(lang === 'sw'
        ? 'Umenunua mnyama — kwa bei gani? Niandikie kwa tarakimu.'
        : 'You bought an animal — for how much? Write it in digits.');
    }
    // The animal is its own line — "ngombe", "wawili" — so it is counted by the
    // same reader as everything else rather than by a second pair of fields.
    const animalLine = event.lines[0];
    if (animalLine.quantity.kind === 'ask') return askBack(numberQuestion('animal_count', animalLine.quantity, lang));
    const animalCount = animalLine.quantity.kind === 'value' ? animalLine.quantity.value : 1;
    const supplierName = event.supplierWording ?? event.partyWording ?? null;
    const { data: procurementId, error: procurementError } = await db.rpc(
      'wa_create_whole_animal_procurement_draft',
      {
        p_profile_id: identity.profile_id,
        p_company_id: identity.company_id,
        p_animal_type: "ng'ombe",
        p_animal_count: animalCount,
        p_purchase_total: event.amount.value,
        p_supplier_name: supplierName,
        p_payment_method: paymentMethod,
        p_occurred_at: date.occurredAt ?? new Date().toISOString(),
        p_source_message_id: waMessageId,
        p_reference: null,
        p_note: animalLine.productWording,
      },
    );
    if (procurementError || !procurementId) {
      return askBack(lang === 'sw'
        ? "Sikuweza kuhifadhi draft ya ununuzi huu. Hakuna stock ya nyama iliyoongezwa; jaribu tena."
        : 'I could not save this procurement draft. No meat stock was added; please try again.');
    }
    const record: ParsedDailyRecord = {
      kind: 'whole_animal_procurement',
      amount: event.amount.value,
      partyName: supplierName,
      description: animalLine.productWording,
      // A whole animal has no product lines on purpose: the kilograms and offal
      // do not exist as stock until a measured breakdown says they do.
      lines: [],
      confidence: 0.95,
    };
    await pendingDraftState(db, identity, String(procurementId), waMessageId, record);
    const confirmation = wholeAnimalProcurementConfirmation({
      animalType: "ng'ombe", animalCount, purchaseTotal: event.amount.value,
      supplierName,
      paymentMethod: paymentMethod as WholeAnimalPaymentMethod | null,
      reference: null, note: animalLine.productWording,
    }, date.occurredAt, lang);
    return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
  }

  // ── butchering it ────────────────────────────────────────────────────────
  if (event.kind === 'whole_animal_breakdown') {
    const quantities = decideQuantities(event, lang);
    if (!quantities.ok) return askBack(quantities.question);
    const outputs: WholeAnimalBreakdownOutput[] = event.lines.map((line, index) => ({
      productName: line.productWording,
      quantity: quantities.quantities[index],
      unit: line.unitWording ?? 'kilo',
    }));
    const reading = {
      kind: 'parsed' as const,
      source: { relativeDate: null, purchaseTotal: null },
      outputs,
    };
    const allSources = await listWholeAnimalBreakdownSources(db, identity);
    const sources = breakdownCandidatesFor(allSources, reading, said ?? '');
    if (sources.length === 0) {
      return askBack(lang === 'sw'
        ? "Sina procurement ya ng'ombe iliyothibitishwa na ambayo bado haijavunjwa. Thibitisha ununuzi kwanza; hakuna stock iliyoongezwa."
        : 'I found no confirmed whole-animal procurement still available for breakdown. Confirm the purchase first; no stock was added.');
    }
    if (sources.length > 1) {
      // Allocating one carcass's cost to another silently misprices every kilo
      // that came off both.
      const selection: WholeAnimalBreakdownSourceSelection = {
        kind: 'whole_animal_breakdown_source_selection',
        sourceMessageId: waMessageId, outputs, candidates: sources,
      };
      await db.from('whatsapp_conversations').upsert({
        identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
        awaiting: 'payment_source', receipt_id: null, options: selection,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'identity_id' });
      const question = wholeAnimalSourceQuestion(sources, lang);
      return { content: question, terminalReply: question };
    }
    const result = await createWholeAnimalBreakdownDraft(db, identity, reading, sources[0], waMessageId);
    if (result.clarification) return askBack(result.clarification);
    if (result.error || !result.id) {
      return askBack(lang === 'sw'
        ? 'Sikuweza kuhifadhi breakdown hii. Hakuna stock ya nyama iliyoongezwa; jaribu tena.'
        : 'I could not save this breakdown. No meat stock was added; please try again.');
    }
    const breakdownState: WholeAnimalBreakdownConfirmationState = {
      kind: 'whole_animal_breakdown_confirmation',
      dailyRecordId: result.id, sourceMessageId: waMessageId, outputs: result.outputs,
    };
    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
      awaiting: 'payment_source', receipt_id: null, options: breakdownState,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    const confirmation = wholeAnimalBreakdownConfirmation(result.outputs, lang);
    return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
  }

  // ── counting what is actually on the shelf ───────────────────────────────
  if (event.kind === 'stock_count') {
    const quantities = decideQuantities(event, lang);
    if (!quantities.ok) return askBack(quantities.question);
    const stockBatch: StockCountBatch = {
      kind: 'stock_count_batch',
      counts: event.lines.map((line, index) => ({
        product: line.productWording,
        quantity: quantities.quantities[index],
        unit: line.unitWording ?? null,
      })),
      unreadable: [],
    };
    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
      awaiting: 'product_cost', receipt_id: null, options: stockBatch,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    // TERMINAL, and every other confirmation in this file with it.
    //
    // MEASURED: the owner sent nine products with their counts and got back
    // "Tafadhali thibitisha hesabu hii kwa kujibu NDIYO ili niiweke" — and
    // nothing else. No list. The list existed; stockCountBatchConfirmation
    // built it correctly, all nine lines. It was handed to the model as
    // evidence rather than as the answer, and the model summarised it away.
    //
    // A confirmation is not evidence. It is the last thing a person sees
    // before money is written to their books, and it has to reach them exactly
    // as the server wrote it. Being asked to approve a figure you cannot see is
    // worse than not being asked, because it manufactures the feeling of having
    // checked.
    const confirmation = stockCountBatchConfirmation(stockBatch, lang);
    return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
  }

  return askBack(notUnderstood);
}

async function executeMoneyEvent(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  waMessageId: string,
  lang: Lang,
  input: Record<string, unknown>,
  said?: string,
): Promise<AssistantToolExecution> {
  const event = validateMoneyEvent(input);
  if (!event) {
    return askBack(lang === 'sw'
      ? 'Sijaelewa kiasi na aina ya rekodi. Taja ni malipo ya nini na kiasi kwa tarakimu.'
      : 'I could not understand the amount or the kind of record. Say what the money was for, and the amount in digits.');
  }

  const date = decideDate(event.occurredAtWording, lang);
  if (!date.ok) return askBack(date.question);
  const payment = decidePayment(event.paymentWording, lang, event.missingFields.includes('payment_method'));
  if (!payment.ok) return askBack(payment.question);

  if (event.amount.kind === 'ask') return askBack(numberQuestion('amount', event.amount, lang));
  if (event.amount.kind === 'absent') {
    return askBack(lang === 'sw'
      ? 'Hujasema kiasi. Ni shilingi ngapi?'
      : 'You did not say the amount. How many shillings?');
  }
  const amount = event.amount.value;

  // ── money out, to a supplier ─────────────────────────────────────────────
  if (event.kind === 'supplier_payment') {
    const supplierName = event.partyWording;
    if (!supplierName) {
      return askBack(lang === 'sw'
        ? 'Umelipa kiasi hicho kwa msambazaji yupi? Taja jina lake.'
        : 'Which supplier did you pay? Name them.');
    }
    // The RPC requires a channel. "Other" is the honest value when the shop did
    // not say, and it never claims the money was cash.
    const method = (payment.method ?? 'other') as SupplierPayment['paymentMethod'];
    const created = await createSupplierPaymentDraft(
      db, identity, waMessageId, { supplierName, amount, paymentMethod: method }, date.occurredAt,
    );
    const hint = String((created.error as { hint?: string } | null)?.hint ?? '');
    if (created.error || !created.id || !created.record) {
      return askBack(hint === 'supplier_overpayment'
        ? (lang === 'sw'
          ? `Malipo ya TSh ${amount.toLocaleString('en-US')} yanazidi deni la ${supplierName}. Siwezi kuunda advance bila sera ya supplier prepayment.`
          : `That payment exceeds ${supplierName}'s outstanding balance. I cannot create a supplier advance without an explicit policy.`)
        : (lang === 'sw'
          ? 'Sikuweza kuhifadhi draft ya malipo haya. Hakiki msambazaji, kiasi na njia ya malipo.'
          : 'I could not save this payment draft. Please check the supplier, amount, and payment method.'));
    }
    await pendingDraftState(db, identity, created.id, waMessageId, created.record);
    const confirmation = supplierPaymentConfirmation({ supplierName, amount, paymentMethod: method }, lang);
    return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
  }

  // ── an expense, or a customer clearing their debt ────────────────────────
  const record: ParsedDailyRecord = {
    kind: event.kind,
    amount,
    partyName: event.partyWording,
    description: event.descriptionWording,
    lines: [],
    confidence: 0.95,
    ...(payment.method ? { paymentMethod: payment.method } : {}),
  };
  const guarded = await addHistoricalPriceWarnings(db, identity.company_id, record);
  const created = await createDailyRecordDraft(db, identity, waMessageId, guarded, lang, said);
  if (created.error || !created.id) {
    return askBack(lang === 'sw'
      ? 'Sikuweza kuhifadhi draft hii. Hakuna rekodi iliyothibitishwa; jaribu tena.'
      : 'I could not save this draft. Nothing was confirmed; please try again.');
  }
  await pendingDraftState(db, identity, created.id, waMessageId, guarded);
  const confirmation = buildDailyRecordConfirmation(guarded, lang);
  return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
}

/**
 * Every tool result, with one line added when drafts are waiting.
 *
 * A QUESTION IS ANSWERED. It is never swallowed.
 *
 * MEASURED, within the hour of shipping the queue, and it was my fault. I had
 * every read flush the queue and return the BATCH instead of the answer, so
 * "leo ameuza nini na nini" came back as a confirmation list — and asking
 * again returned the same list, because nothing had been confirmed. Two
 * questions in, Risip was a wall.
 *
 * A pending draft is a fact about the shop, not a reason to refuse it. The
 * count travels with the evidence so the model can mention it in a line, and
 * the question gets its answer either way.
 *
 * A wrapper rather than an edit to forty return sites: the note has to reach
 * whatever the tool decided to say, and threading it through each branch is
 * how one of them would eventually be forgotten.
 */
/**
 * Hold the candidates so the number he is asked for can be read by us.
 *
 * The clarification prints "Jibu kwa namba" from six different places. Only
 * the sale path parked it at first, so the same question was deterministic in
 * one route and left to the model in the others — which is the sort of split
 * nobody can hold in their head. Every route that asks now parks.
 *
 * Nothing is written and nothing is refused: a wrong answer, or no answer at
 * all, simply releases and the message carries on as any new turn.
 */
async function parkProductChoice(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  waMessageId: string,
  asked: string,
  candidates: string[],
  originalText: string | null | undefined,
  recovery?: ProductChoicePending['recovery'],
): Promise<void> {
  if (!asked || candidates.length === 0 || !originalText) return;
  const state: ProductChoicePending = {
    kind: 'product_read_choice',
    asked,
    candidates,
    originalText,
    sourceMessageId: waMessageId,
    ...(recovery ? { recovery } : {}),
  };
  try {
    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id,
      company_id: identity.company_id,
      profile_id: identity.profile_id,
      awaiting: 'product_cost',
      receipt_id: null,
      options: state,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
  } catch {
    /* A question that cannot be parked is still a question worth asking. */
  }
}

/** The names offered, in the order they are numbered on his screen. */
function choiceNames(resolution: Extract<ProductReadResolution, { kind: 'ambiguous' }>): string[] {
  return resolution.candidates.slice(0, 3).map((one) => one.productName);
}

async function executeAssistantTool(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  waMessageId: string,
  lang: Lang,
  name: string,
  input: Record<string, unknown>,
  said?: string,
): Promise<AssistantToolExecution> {
  const result = await runAssistantTool(db, identity, waMessageId, lang, name, input, said);
  // Only a READ needs the note. A proposing tool is already about the drafts,
  // and closing the day stops and asks for them outright.
  if (!name.startsWith('get_')) return result;
  const ceiling = await recordQueueSize(db, identity.company_id as string);
  if (ceiling === null) return result;
  const waiting = await pendingQueue(db, identity);
  if (waiting.length === 0) return result;

  const note = lang === 'sw'
    ? `

_Kuna vitu ${waiting.length} vinasubiri kuthibitishwa — jibu *NDIYO* niviingize._`
    : `

_${waiting.length} records are waiting to be confirmed — reply *NDIYO* to add them._`;
  return {
    ...result,
    content: `${result.content}
pending_drafts_not_yet_counted=${waiting.length}`,
    ...(result.terminalReply ? { terminalReply: result.terminalReply + note } : {}),
    ...(result.fallbackReply ? { fallbackReply: result.fallbackReply + note } : {}),
  };
}

async function runAssistantTool(
  db: Admin,
  identity: ResolvedWhatsAppIdentity,
  waMessageId: string,
  lang: Lang,
  name: string,
  input: Record<string, unknown>,
  // What the trader actually typed. propose_daily_record is held to the verb in
  // it, so the model cannot book an arrival as a sale.
  said?: string,
): Promise<AssistantToolExecution> {
  const invalidWhen = typeof input.when === 'string'
    && dateWordingStatus(input.when) === 'invalid';
  if (invalidWhen) {
    const message = lang === 'sw'
      ? 'Sijaweza kutambua tarehe hiyo kwa usalama. Tafadhali andika tarehe kamili, kwa mfano *tarehe 23 Agosti 2026*.'
      : 'I could not resolve that date safely. Please write the full date, for example *23 August 2026*.';
    return { content: message, terminalReply: message, isError: true };
  }
  if (name === 'request_account_action') {
    // The model selects a capability, never its actor or credentials.
    const { data: linked, error: linkError } = await db.from('whatsapp_identities')
      .select('phone_e164').eq('id', identity.id).eq('company_id', identity.company_id)
      .eq('profile_id', identity.profile_id).is('revoked_at', null).maybeSingle();
    if (linkError || !linked?.phone_e164) return { content: 'identity_unavailable', isError: true };
    const actorPhone = String(linked.phone_e164);
    if (input.action === 'login' || input.action === 'sell_scan' || input.action === 'scan') {
      if (input.action === 'scan' && !canUseCompanyFinanceReads(identity.role)) {
        return { content: 'product_registration_permission_denied', isError: true };
      }
      const result = input.action === 'login'
        ? await handleLoginLink(db, actorPhone, lang)
        : await handleScanLink(db, actorPhone, lang, input.action === 'sell_scan' ? '/sell' : undefined);
      // Credentials never enter model history or model-visible evidence.
      return { content: 'account_link_response', terminalReply: result.reply, sensitiveReply: true };
    }
    if (input.action === 'invite_worker') {
      if (identity.role !== 'owner') return askBack(inviteNotAllowed(lang));
      const { data: made, error } = await db.rpc('wa_create_invite_code', {
        p_phone: actorPhone, p_role: 'worker', p_days: 3,
      });
      const invite = made as { code?: string; company_name?: string } | null;
      if (error || !invite?.code) return { content: 'invite_creation_failed', isError: true };
      return { content: 'worker_invite_created', sensitiveReply: true, terminalReply: inviteReady(invite.code, 'worker', lang)
        + '\n\n' + inviteForwardMessage(invite.code, invite.company_name ?? identity.company_name, await whatsAppDisplayNumber(), lang) };
    }
    if (input.action === 'change_language') {
      if (input.language !== 'sw' && input.language !== 'en') return { content: 'language_required: sw|en', isError: true };
      const { error } = await db.rpc('wa_set_language', { p_phone: actorPhone, p_lang: input.language });
      return { content: error ? 'language_update_failed' : `language_updated=${input.language}`, isError: Boolean(error) };
    }
    if (input.action === 'stop_notifications') {
      const { error } = await db.rpc('wa_stop_proactive_notifications', { p_phone: actorPhone });
      return { content: error ? 'notification_update_failed' : 'proactive_notifications_stopped', isError: Boolean(error) };
    }
    if (input.action === 'logout') {
      await parkLogout(db, identity, 'confirm');
      return { content: 'logout_confirmation_required', terminalReply: logoutConfirmation(identity.company_name, lang) };
    }
    if (input.action === 'delete_account') {
      const owned = await loadOwnedBusinesses(db, identity.profile_id);
      await parkAccountDeletion(db, identity, owned);
      return { content: 'account_deletion_confirmation_required', terminalReply: accountDeletionWarning(owned, lang) };
    }
    if (input.action === 'switch_business') {
      const { data, error } = await db.rpc('wa_memberships', { p_phone: actorPhone });
      if (error) return { content: 'memberships_unavailable', isError: true };
      const memberships = (data ?? []) as Array<{ company_id: string; company_name: string; role: string; is_active: boolean }>;
      if (memberships.length > 1) {
        const { error: stateError } = await db.from('whatsapp_conversations').upsert({
          identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
          awaiting: 'business', options: memberships.map((row) => ({ id: row.company_id, name: row.company_name })),
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
        }, { onConflict: 'identity_id' });
        if (stateError) return { content: 'question_not_saved', isError: true };
      }
      return { content: JSON.stringify(memberships), terminalReply: businessList(memberships, lang) };
    }
    return { content: 'unsupported_account_action', isError: true };
  }
  // A QUESTION EMPTIES THE QUEUE FIRST.
  //
  // Drafts are not confirmed records, so nothing waiting is in any total. A
  // shopkeeper who has typed four sales and then asks how the day is going
  // would be answered about a day missing all four — which is worse than being
  // asked to confirm them, because it is wrong rather than merely one step
  // longer. Closing the day is the same problem and the same answer.
  //
  // A tick is not a question, so nothing was parked; this is the first moment
  // the batch has anything to interrupt.
  // Closing the day CANNOT proceed with drafts outstanding — the totals it
  // writes would be missing them — so that one still stops and asks.
  if (name === 'propose_day_close') {
    const ceiling = await recordQueueSize(db, identity.company_id as string);
    if (ceiling !== null) {
      const waiting = await pendingQueue(db, identity);
      if (waiting.length > 0) return await askToConfirmQueue(db, identity, lang, waiting);
    }
  }


  if (name === 'get_business_summary') {
    // STAGE: the model gets EVIDENCE and writes the answer; the paragraph is
    // what the shop sees only if the model cannot finish. Asked "Biashara
    // inaendaje so far", the old path returned the same fixed monthly ledger
    // block whatever had been asked — right figures, wrong answer.
    const summaryRequest = { period: assistantPeriod(input.period), range: assistantRange(input.when) };
    return {
      content: await readOnlyToolReply(db, identity, { tool: 'ai_business_summary_facts', ...summaryRequest }, lang),
      fallbackReply: await readOnlyToolReply(db, identity, { tool: 'ai_business_summary', ...summaryRequest }, lang),
    };
  }
  if (name === 'get_stock_loss_report' || name === 'get_owner_use_report' || name === 'get_whole_animal_report') {
    const tool = name === 'get_stock_loss_report'
      ? 'ai_stock_loss'
      : name === 'get_owner_use_report' ? 'ai_owner_use' : 'ai_whole_animals';
    return {
      content: await readOnlyToolReply(db, identity, {
        tool,
        period: assistantPeriod(input.period),
        range: assistantRange(input.when),
      }, lang),
    };
  }
  if (name === 'get_product_performance') {
    const metric = input.metric === 'revenue' || input.metric === 'margin' ? input.metric : 'quantity';
    // "Worst" is a separate question, not a smaller number. Asked which
    // products LOSE money, every ranking used to hand back the five that make
    // the most, and the answer came out as "hakuna hasara".
    const direction = input.direction === 'worst' ? 'worst' as const : 'best' as const;
    return {
      content: await productAnalyticsToolReply(db, identity, {
        rankBy: metric,
        direction,
        period: assistantPeriod(input.period),
        compareNames: assistantProductNames(input.product_names),
        range: (() => {
          const resolved = assistantRange(input.when);
          return resolved ? {
            from: resolved.from.toISOString(), to: resolved.to.toISOString(), sw: resolved.sw, en: resolved.en,
          } : null;
        })(),
      }, lang),
    };
  }
  if (name === 'get_product_cost') {
    if (!canUseCompanyFinanceReads(identity.role)) {
      const denied = lang === 'sw'
        ? 'Bei za kununua za kampuni zinaonekana kwa owner au accountant tu.'
        : 'Company buying costs are available only to an owner or accountant.';
      return { content: denied, isError: true, terminalReply: denied };
    }
    const productName = typeof input.product_name === 'string' ? input.product_name.trim().slice(0, 100) : '';
    if (productName.length < 2 || !/[\p{L}]/u.test(productName)) {
      const clarification = lang === 'sw' ? 'Unataka bei ya kununua ya bidhaa gani?' : 'Which product buying cost do you want?';
      return { content: clarification, isError: true, terminalReply: clarification };
    }
    const resolved = await resolveProductForRead(db, identity, productName);
    if (resolved.error) {
      const failed = lang === 'sw' ? 'Sikuweza kutafuta bidhaa hiyo sasa.' : 'I could not look up that product right now.';
      return { content: failed, isError: true, terminalReply: failed };
    }
    if (resolved.resolution.kind === 'ambiguous') {
      const clarification = productReadClarification(resolved.resolution, lang);
      await parkProductChoice(db, identity, waMessageId, resolved.resolution.asked, choiceNames(resolved.resolution), said);
      return { content: clarification, isError: true, terminalReply: clarification };
    }
    if (resolved.resolution.kind === 'not_found') {
      return { content: productCostReply(productName, null, lang) };
    }
    const productKey = resolved.resolution.match.productKey;
    const canonicalName = resolved.resolution.match.productName;
    const { data, error } = await db.from('product_costs')
      .select('product_name, unit_cost, unit, currency, effective_from')
      .eq('company_id', identity.company_id)
      .eq('product_key', productKey)
      .order('effective_from', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      const failed = lang === 'sw' ? 'Sikuweza kupata bei hiyo ya kununua sasa.' : 'I could not load that buying cost right now.';
      return { content: failed, isError: true, terminalReply: failed };
    }
    return {
      content: productReadMatchNotice(resolved.resolution, lang) + productCostReply(canonicalName, data ? {
        productName: String(data.product_name), unitCost: Number(data.unit_cost),
        unit: data.unit ? String(data.unit) : null, currency: String(data.currency), effectiveFrom: String(data.effective_from),
      } : null, lang),
    };
  }
  if (name === 'get_sales_trend') {
    const period = input.period === 'month' ? 'month' as const : 'week' as const;
    return { content: await salesTrendToolReply(db, identity, period, lang) };
  }
  if (name === 'get_business_advice') {
    if (!canReadCompanyReporting(identity.role)) {
      const denied = lang === 'sw'
        ? 'Mchanganuo wa biashara nzima unaonekana kwa owner au accountant tu.'
        : 'A whole-business review is available only to an owner or accountant.';
      return { content: denied, isError: true, terminalReply: denied };
    }
    try {
      const payload = await buildAdvisorPayload(db, identity, lang);
      // NO terminalReply: setting one short-circuits the model and sends the
      // same canned brief to every shop for every question — the
      // "inajibu kama roboti" the owner objected to.
      //
      // And NO instructions in the content. They used to be appended here, and
      // when the model ran out of tool rounds the fallback sent this string
      // straight to WhatsApp — figures, ADVISER MODE heading and all. The voice
      // now lives in the system prompt, where the shop can never receive it.
      return { content: advisorEvidence(payload), fallbackReply: advisorBrief(payload, lang) };
    } catch {
      const failed = lang === 'sw'
        ? 'Sikuweza kukusanya takwimu za biashara sasa.'
        : 'I could not gather the business figures right now.';
      return { content: failed, isError: true, terminalReply: failed };
    }
  }
  if (name === 'get_selling_price') {
    const productName = typeof input.product_name === 'string' ? input.product_name.trim().slice(0, 100) : '';
    if (productName.length < 2 || !/[\p{L}]/u.test(productName)) {
      const clarification = lang === 'sw' ? 'Unataka bei ya bidhaa gani?' : 'Which product price do you want?';
      return { content: clarification, isError: true, terminalReply: clarification };
    }
    const resolved = await resolveProductForRead(db, identity, productName);
    if (resolved.error) {
      const failed = lang === 'sw' ? 'Sikuweza kutafuta bidhaa hiyo sasa.' : 'I could not look up that product right now.';
      return { content: failed, isError: true, terminalReply: failed };
    }
    if (resolved.resolution.kind === 'ambiguous') {
      const clarification = productReadClarification(resolved.resolution, lang);
      await parkProductChoice(db, identity, waMessageId, resolved.resolution.asked, choiceNames(resolved.resolution), said);
      return { content: clarification, isError: true, terminalReply: clarification };
    }
    if (resolved.resolution.kind === 'not_found') {
      return { content: sellingPriceReply(productName, null, lang) };
    }
    const { data, error } = await db.rpc('wa_product_pricing', {
      p_company_id: identity.company_id,
      p_product_keys: [resolved.resolution.match.productKey],
    });
    if (error) {
      const failed = lang === 'sw' ? 'Sikuweza kupata bei hiyo sasa.' : 'I could not load that price right now.';
      return { content: failed, isError: true, terminalReply: failed };
    }
    const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
    return {
      content: productReadMatchNotice(resolved.resolution, lang) + sellingPriceReply(
        productName,
        {
          productName: resolved.resolution.match.productName,
          retail: row?.retail_price == null ? null : Number(row.retail_price),
          wholesale: row?.wholesale_price == null ? null : Number(row.wholesale_price),
          wholesaleMinQty: row?.wholesale_min_qty == null ? null : Number(row.wholesale_min_qty),
          unitCost: row?.unit_cost == null ? null : Number(row.unit_cost),
        },
        lang,
        // The buying cost, and therefore the margin, is commercial data. A
        // worker at the counter needs the selling price and nothing else.
        canUseCompanyFinanceReads(identity.role),
      ),
    };
  }
  if (name === 'get_product_price_comparison' || name === 'get_products_missing_selling_price') {
    const { data: names, error: namesError } = await db.rpc('company_product_names', { p_company_id: identity.company_id });
    if (namesError) {
      const failed = lang === 'sw' ? 'Sikuweza kupata orodha ya bidhaa sasa.' : 'I could not load the product catalogue right now.';
      return { content: failed, isError: true, terminalReply: failed };
    }
    const products = ((names ?? []) as Array<Record<string, unknown>>)
      .map((row) => String(row.product_name ?? '').trim()).filter(Boolean);
    const { data: priceRows, error: priceError } = await db.rpc('wa_product_pricing', {
      p_company_id: identity.company_id,
      p_product_keys: products.map((product) => productKey(product)),
    });
    if (priceError) {
      const failed = lang === 'sw' ? 'Sikuweza kupata bei za bidhaa sasa.' : 'I could not load selling prices right now.';
      return { content: failed, isError: true, terminalReply: failed };
    }
    const byKey = new Map<string, Record<string, unknown>>(
      ((priceRows ?? []) as Array<Record<string, unknown>>).map((row) => [String(row.product_key), row]),
    );
    const rows: ProductPriceRead[] = products.map((product) => {
      const price = byKey.get(productKey(product));
      return {
        productName: product,
        retailPrice: price?.retail_price == null ? null : Number(price.retail_price),
        wholesalePrice: price?.wholesale_price == null ? null : Number(price.wholesale_price),
        wholesaleMinQty: price?.wholesale_min_qty == null ? null : Number(price.wholesale_min_qty),
      };
    });
    if (name === 'get_products_missing_selling_price') {
      // STAGE D. The rendered sentence becomes the FALLBACK, not the answer.
      // A terminalReply on a success path hands the shop a pre-written line
      // and stops the model reasoning, so "bidhaa gani haina bei?" and
      // "ni bidhaa ngapi hazina bei?" got the same paragraph. The facts go
      // to the model; the rendering survives only if the model cannot finish.
      const reply = missingSellingPriceReply(rows, lang);
      return { content: reply, fallbackReply: reply };
    }
    const direction = input.direction === 'highest' ? 'highest' as const : 'lowest' as const;
    const reply = productPriceComparisonReply(rows, direction, lang);
    return { content: reply, fallbackReply: reply };
  }
  if (name === 'get_hypothetical_product_profit') {
    const productName = typeof input.product_name === 'string' ? input.product_name : '';
    const quantity = input.quantity == null ? null : Number(input.quantity);
    if (quantity !== null && (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000)) {
      return { content: 'Invalid hypothetical quantity; ask for a positive quantity.', isError: true };
    }
    const band = input.price_band === 'retail' || input.price_band === 'wholesale' ? input.price_band : null;
    const result = await hypotheticalProfitToolReply(db, identity, productName, lang, quantity, band);
    return { content: result.text, fallbackReply: result.text };
  }
  if (name === 'get_open_debts') {
    const partyName = typeof input.party_name === 'string' ? input.party_name.trim().slice(0, 100) || null : null;
    return {
      content: await readOnlyToolReply(db, identity, {
        tool: partyName ? 'ai_debtor_detail' : 'ai_debtors',
        period: 'today',
        partyName,
      }, lang),
    };
  }
  if (name === 'get_my_receipts') {
    const status = input.status === 'confirmed' || input.status === 'submitted' ? input.status : null;
    return { content: await readOnlyToolReply(db, identity, { tool: 'ai_my_receipts', period: assistantPeriod(input.period), status, range: assistantRange(input.when) }, lang) };
  }
  if (name === 'get_receipt_details') {
    const selector = assistantSelector(input.selector);
    const normalized = normalizeAssistantSelector(selector);
    const idMatch = selector.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] ?? null;
    const latest = !normalized || /\b(?:latest|last|newest|mwisho|karibuni)\b/.test(normalized);
    const range = assistantRange(input.when);
    const bounds = readPeriodBounds({
      tool: 'ai_my_receipts',
      period: assistantPeriod(input.period),
      range,
    });
    let query = db.from('receipts').select(
      'id, status, total_amount, vendor_name, vendor_tin, vendor_vrn, receipt_number, verification_code, receipt_date, receipt_time, tax_amount, category, payment_method, low_confidence_fields, created_at',
    ).eq('company_id', identity.company_id).order('created_at', { ascending: false }).limit(latest || idMatch ? 50 : 100);
    if (!canUseCompanyFinanceReads(identity.role)) query = query.eq('uploaded_by', identity.profile_id);
    if (idMatch) query = query.eq('id', idMatch);
    else if (!latest) query = query.gte('created_at', bounds.from).lt('created_at', bounds.to);
    const { data, error } = await query;
    if (error) {
      const failed = lang === 'sw' ? 'Sikuweza kupata maelezo ya risiti sasa.' : 'I could not load the receipt details right now.';
      return { content: failed, isError: true, terminalReply: failed };
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const matched = idMatch || latest ? rows[0] : rows.find((row) => {
      const haystack = normalizeAssistantSelector([
        row.vendor_name, row.receipt_number, row.verification_code,
      ].filter(Boolean).join(' '));
      return Boolean(normalized && (haystack.includes(normalized) || normalized.includes(haystack)));
    }) ?? null;
    const receipt: ReceiptDetail | null = matched ? {
      id: String(matched.id), status: String(matched.status),
      amount: matched.total_amount === null ? null : Number(matched.total_amount),
      vendor: matched.vendor_name ? String(matched.vendor_name) : null,
      createdAt: String(matched.created_at),
      tin: matched.vendor_tin ? String(matched.vendor_tin) : null,
      vrn: matched.vendor_vrn ? String(matched.vendor_vrn) : null,
      receiptNumber: matched.receipt_number ? String(matched.receipt_number) : null,
      verificationCode: matched.verification_code ? String(matched.verification_code) : null,
      receiptDate: matched.receipt_date ? String(matched.receipt_date) : null,
      receiptTime: matched.receipt_time ? String(matched.receipt_time) : null,
      taxAmount: matched.tax_amount === null ? null : Number(matched.tax_amount),
      category: matched.category ? String(matched.category) : null,
      paymentMethod: matched.payment_method ? String(matched.payment_method) : null,
      lowConfidenceFields: Array.isArray(matched.low_confidence_fields)
        ? matched.low_confidence_fields.filter((item): item is string => typeof item === 'string').slice(0, 20)
        : [],
    } : null;
    return { content: buildReceiptDetailReply(receipt, lang, appUrl()) };
  }
  if (name === 'get_invoice_details') {
    if (!canUseCompanyFinanceReads(identity.role)) {
      const denied = lang === 'sw'
        ? 'Invoice za kampuni zinaonekana kwa owner au accountant tu.'
        : 'Company invoices are available only to an owner or accountant.';
      return { content: denied, isError: true, terminalReply: denied };
    }
    const selector = assistantSelector(input.selector);
    const normalized = normalizeAssistantSelector(selector);
    const idMatch = selector.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i)?.[0] ?? null;
    let query = db.from('invoices').select(
      'id, invoice_number, client_name, status, period_start, period_end, total_amount, tax_amount, line_items, created_at',
    ).eq('company_id', identity.company_id).order('created_at', { ascending: false }).limit(idMatch ? 1 : 100);
    if (idMatch) query = query.eq('id', idMatch);
    const { data, error } = await query;
    if (error) {
      const failed = lang === 'sw' ? 'Sikuweza kupata maelezo ya invoice sasa.' : 'I could not load invoice details right now.';
      return { content: failed, isError: true, terminalReply: failed };
    }
    const rows = (data ?? []) as Array<Record<string, unknown>>;
    const matched = idMatch || !normalized ? rows[0] : rows.find((row) => {
      const haystack = normalizeAssistantSelector([row.invoice_number, row.client_name].filter(Boolean).join(' '));
      return Boolean(haystack && (haystack.includes(normalized) || normalized.includes(haystack)));
    }) ?? null;
    const invoice: InvoiceDetail | null = matched ? {
      id: String(matched.id), invoiceNumber: matched.invoice_number ? String(matched.invoice_number) : null,
      clientName: matched.client_name ? String(matched.client_name) : null, status: String(matched.status),
      periodStart: String(matched.period_start), periodEnd: String(matched.period_end),
      totalAmount: Number(matched.total_amount), taxAmount: Number(matched.tax_amount),
      lineItems: invoiceLineItemLabels(matched.line_items), createdAt: String(matched.created_at),
    } : null;
    return { content: buildInvoiceDetailReply(invoice, lang, appUrl()) };
  }
  if (name === 'get_my_petty_cash_balance') {
    return { content: await readOnlyToolReply(db, identity, { tool: 'ai_petty_cash_balance', period: 'today' }, lang) };
  }
  if (name === 'get_my_reimbursements') {
    return { content: await readOnlyToolReply(db, identity, { tool: 'ai_owed_to_me', period: 'today' }, lang) };
  }
  if (name === 'get_my_businesses') {
    return { content: await readOnlyToolReply(db, identity, { tool: 'ai_my_businesses', period: 'today' }, lang) };
  }
  if (name === 'get_my_subscription') {
    const parts: string[] = [];

    // The catalogue is what anyone may ask about; it is a price list, not the
    // shop's business. Read live, because a price written into a prompt is a
    // price from before the last change.
    {
      const { data: plans } = await db.from('billing_plans')
        .select('name_sw, monthly_tzs, yearly_tzs, message_allowance, max_users')
        .order('sort_order');
      parts.push(buildPlansReply((plans ?? []).map((row: Record<string, unknown>) => ({
        name: String(row.name_sw), monthlyTzs: Number(row.monthly_tzs), yearlyTzs: Number(row.yearly_tzs),
        allowance: Number(row.message_allowance), maxUsers: Number(row.max_users),
      })), lang));
    }

    // WHAT THIS SHOP PAYS IS THE OWNER'S BUSINESS. The usage table itself is
    // owner-only under RLS; a worker asking is answered about the catalogue
    // rather than refused outright, because the prices are not a secret.
    {
      if (String(identity.role ?? 'worker') !== 'owner') {
        parts.push(lang === 'sw'
          ? 'Taarifa za bili na plan ya biashara zinaonekana kwa owner tu.'
          : 'Billing and plan details are visible to the owner only.');
      } else {
        const { data: sub } = await db.from('subscriptions')
          .select('plan, cycle, status, trial_ends_at, current_period_start, current_period_end')
          .eq('company_id', identity.company_id).maybeSingle();
        if (!sub) {
          parts.push(lang === 'sw'
            ? 'Biashara hii bado haina subscription iliyosajiliwa.'
            : 'This business has no subscription on record yet.');
        } else {
          // NOT billing_usage_now: that RPC reads the caller's JWT to find the
          // company, and this runs on the service role with no user token, so
          // it would have returned null and every shop would have been told it
          // had sent zero messages. The window comes from the same function the
          // nightly sweep uses, and the count is taken live rather than from
          // the sweep's row, which can be a day old.
          const [{ data: plan }, { data: windowRows }] = await Promise.all([
            db.from('billing_plans')
              .select('name_sw, monthly_tzs, yearly_tzs, message_allowance')
              .eq('code', sub.plan).maybeSingle(),
            db.rpc('billing_usage_window', {
              p_period_start: sub.current_period_start,
              p_period_end: sub.current_period_end,
            }),
          ]);
          const win = (Array.isArray(windowRows) ? windowRows[0] : windowRows) as
            { window_start?: string; window_end?: string } | null;
          const windowStart = String(win?.window_start ?? sub.current_period_start);
          const windowEnd = String(win?.window_end ?? sub.current_period_end);
          const { count: sent } = await db.from('whatsapp_messages')
            .select('id', { count: 'exact', head: true })
            .eq('company_id', identity.company_id)
            .gte('created_at', `${windowStart}T00:00:00+03:00`)
            .lt('created_at', `${windowEnd}T23:59:59.999+03:00`);
          parts.push(buildSubscriptionReply({
            planName: String(plan?.name_sw ?? sub.plan),
            cycle: sub.cycle === 'yearly' ? 'yearly' : 'monthly',
            status: String(sub.status),
            priceTzs: Number(sub.cycle === 'yearly' ? plan?.yearly_tzs ?? 0 : plan?.monthly_tzs ?? 0),
            allowance: Number(plan?.message_allowance ?? 0),
            used: Number(sent ?? 0),
            windowStart,
            windowEnd,
            nextBillOn: sub.status === 'trialing' ? null : String(sub.current_period_end),
            trialEndsOn: sub.status === 'trialing' && sub.trial_ends_at
              ? String(sub.trial_ends_at).slice(0, 10) : null,
          }, lang));
        }
      }
    }

    return { content: parts.join('\n\n') };
  }
  if (name === 'get_stock_on_hand') {
    const asked = typeof input.product_name === 'string' ? input.product_name.trim().slice(0, 80) : '';
    const resolved = asked ? await resolveProductForRead(db, identity, asked) : null;
    if (resolved?.error) {
      return { content: lang === 'sw' ? 'Sikuweza kutafuta bidhaa hiyo sasa.' : 'I could not look up that product right now.' };
    }
    if (resolved?.resolution.kind === 'ambiguous') {
      await parkProductChoice(db, identity, waMessageId, resolved.resolution.asked, choiceNames(resolved.resolution), said);
      return { content: productReadClarification(resolved.resolution, lang) };
    }
    if (resolved?.resolution.kind === 'not_found') {
      return { content: stockReply(null, asked, lang) };
    }
    const matched = resolved?.resolution.kind === 'matched' ? resolved.resolution : null;
    const [{ data, error }, { data: catalogueRows }] = await Promise.all([
      db.rpc('wa_stock_on_hand', {
        p_company_id: identity.company_id,
        p_product: matched?.match.productKey ?? null,
      }),
      asked
        ? Promise.resolve({ data: null })
        : db.rpc('company_product_names', { p_company_id: identity.company_id }),
    ]);
    if (error) {
      return { content: lang === 'sw' ? 'Sikuweza kupata hesabu ya bidhaa sasa.' : 'I could not load stock right now.' };
    }
    const rows = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      productName: String(row.product_name ?? ''),
      unit: row.unit ? String(row.unit) : null,
      measured: Boolean(row.measured),
      onHand: Number(row.on_hand ?? 0),
      hasCount: Boolean(row.has_count),
      countedAt: row.counted_at ? String(row.counted_at) : null,
      boughtSince: Number(row.bought_since ?? 0),
      soldSince: Number(row.sold_since ?? 0),
      producedSince: Number(row.produced_since ?? 0),
      incompletePurchases: Boolean(row.incomplete_purchases),
    }));
    // wa_stock_on_hand contains movements/counts. The catalogue also contains
    // products registered with prices but never counted or sold; include their
    // names explicitly instead of making them disappear from a "what is in my
    // store?" answer.
    const represented = new Set(rows.map((row) => productKey(row.productName)));
    for (const row of (catalogueRows ?? []) as Array<Record<string, unknown>>) {
      const productName = String(row.product_name ?? '').trim();
      const key = productKey(productName);
      if (!key || represented.has(key)) continue;
      represented.add(key);
      rows.push({
        productName,
        unit: null,
        measured: false,
        onHand: 0,
        hasCount: false,
        countedAt: null,
        boughtSince: 0,
        soldSince: 0,
        incompletePurchases: false,
      });
    }
    rows.sort((a, b) => a.productName.localeCompare(b.productName, lang === 'sw' ? 'sw' : 'en'));
    return {
      content: asked && matched
        ? productReadMatchNotice(matched, lang) + stockReply(rows[0] ?? null, matched.match.productName, lang)
        : input.only_out_of_stock === true
          ? outOfStockReply(rows, lang)
        : stockListReply(rows, lang),
    };
  }
  if (name === 'get_pending_approvals') {
    return { content: await readOnlyToolReply(db, identity, { tool: 'ai_pending_approvals', period: 'today' }, lang) };
  }
  if (name === 'search_risip_help') {
    const query = typeof input.query === 'string' ? input.query.slice(0, 500) : '';
    return { content: buildKnowledgeReply(query, lang) };
  }
  if (name === 'propose_product_cost') {
    if (!canUseCompanyFinanceReads(identity.role)) {
      const denied = lang === 'sw'
        ? 'Ni owner au accountant pekee anayeweza kuweka bei ya kununua bidhaa.'
        : 'Only an owner or accountant can set a product buying cost.';
      return { content: denied, isError: true, terminalReply: denied };
    }
    const cost = validateProductCostCandidate(input);
    if (!cost) {
      const clarification = lang === 'sw'
        ? 'Taja jina la bidhaa, bei yake ya kununua, na unit kama ipo. Mfano: unga unanigharimu TSh 900 kwa kilo.'
        : 'State the product, its buying cost, and the unit if known. For example: flour costs me TSh 900 per kilo.';
      return { content: clarification, isError: true, terminalReply: clarification };
    }
    const { data: previous } = await db.from('product_costs')
      .select('unit_cost')
      .eq('company_id', identity.company_id)
      .eq('product_key', cost.product.trim().toLowerCase())
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();
    // A mixed price message can still arrive from an older model that calls
    // this tool after propose_price_update. Merge into the same draft instead
    // of letting the last tool overwrite the other half.
    const { data: activeConversation } = await db.from('whatsapp_conversations')
      .select('options')
      .eq('identity_id', identity.id)
      .maybeSingle();
    const active = (activeConversation?.options ?? null) as Record<string, unknown> | null;
    const activeKind = String(active?.kind ?? '');
    const mergedPending: PriceAndCostPending | null = activeKind === 'selling_price_batch'
      ? {
        kind: 'price_and_cost_pending',
        prices: Array.isArray(active?.prices) ? active.prices as SellingPrice[] : [],
        costs: [cost],
        unreadable: Array.isArray(active?.unreadable) ? active.unreadable as string[] : [],
      }
      : activeKind === 'price_and_cost_pending'
        ? {
          kind: 'price_and_cost_pending',
          prices: Array.isArray(active?.prices) ? active.prices as SellingPrice[] : [],
          costs: [
            ...(Array.isArray(active?.costs) ? active.costs as ProductCost[] : []),
            cost,
          ],
          unreadable: Array.isArray(active?.unreadable) ? active.unreadable as string[] : [],
        }
        : null;
    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id,
      company_id: identity.company_id,
      profile_id: identity.profile_id,
      awaiting: 'product_cost',
      receipt_id: null,
      options: mergedPending ?? cost,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    const confirmation = costConfirmation(
      cost,
      identity.company_name,
      previous ? Number((previous as { unit_cost: number }).unit_cost) : null,
      lang,
    );
    return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
  }
  // ── STAGE B ─────────────────────────────────────────────────────────────
  if (name === 'propose_business_event') {
    return await executeBusinessEvent(db, identity, waMessageId, lang, input, said);
  }
  if (name === 'propose_money_event') {
    return await executeMoneyEvent(db, identity, waMessageId, lang, input, said);
  }
  if (name === 'resolve_pending_clarification') {
    return await executeClarification(db, identity, waMessageId, lang, input, said);
  }
  if (name === 'get_recurring_costs' || name === 'propose_recurring_cost') {
    // What the shop pays whether or not it sold anything is a company
    // financial, same boundary as every other read of its kind.
    if (!canUseCompanyFinanceReads(identity.role)) {
      const denied = lang === 'sw'
        ? 'Gharama za kila mwezi zinaonekana kwa owner au accountant tu.'
        : 'Recurring costs are available to an owner or accountant only.';
      return { content: denied, isError: true, terminalReply: denied };
    }

    if (name === 'get_recurring_costs') {
      const list = await readObligations(db, identity);
      return {
        content: obligationFacts(list, shopDay().date),
        fallbackReply: obligationListReply(list, lang),
      };
    }

    // The model splits the sentence; the SERVER reads the money. Same contract
    // as every other proposing tool — amount_wording is the trader's own words
    // and a disagreement with the model's reading is a question, not a guess.
    const reading = readNumber(input.amount_wording, input.amount_candidate, { min: 0, max: 1_000_000_000 });
    if (reading.kind !== 'value') {
      const ask = lang === 'sw'
        ? 'Sijaelewa kiasi. Niandikie tena, mfano: _"kodi ya jengo ni 200000 kila mwezi"_.'
        : 'I could not read the amount. Say it again, for example: _"kodi ya jengo ni 200000 kila mwezi"_.';
      return { content: ask, terminalReply: ask };
    }
    const months = periodMonthsFromWording(input.period_wording);
    if (months === null) {
      const ask = lang === 'sw'
        ? 'Inalipwa kila baada ya muda gani? Mfano: _kila mwezi_, _kila miezi mitatu_, _kwa mwaka_.'
        : 'How often does it fall due? For example: _monthly_, _every three months_, _yearly_.';
      return { content: ask, terminalReply: ask };
    }

    const kind = typeof input.kind === 'string' ? input.kind : 'other';
    const label = typeof input.label_wording === 'string' ? input.label_wording.trim().slice(0, 60) : '';
    const due = nextDueFromWording(input.due_wording, months);

    const { data: result, error } = await db.rpc('wa_set_recurring_obligation', {
      p_company_id: identity.company_id,
      p_profile_id: identity.profile_id,
      p_kind: kind,
      p_label: label || null,
      p_amount: reading.value,
      p_period_months: months,
      p_next_due_on: due,
    });
    if (error) {
      const failed = lang === 'sw'
        ? 'Sikuweza kuhifadhi gharama hiyo sasa. Hakuna kilichobadilika; jaribu tena.'
        : 'I could not save that cost just now. Nothing changed; please try again.';
      return { content: failed, isError: true, terminalReply: failed };
    }
    const row = (result ?? {}) as { previous_amount?: number | null };
    const said = obligationSetReply(
      obligationName({
        id: '', kind, label: label || null, amount: reading.value, periodMonths: months,
        nextDueOn: due, daysUntilDue: 0, paidForCurrentPeriod: 0, outstanding: 0,
        lastPaidOn: null, previousAmount: null,
      }, lang),
      reading.value, months, due,
      row.previous_amount == null ? null : Number(row.previous_amount),
      lang,
    );
    await audit(db, identity, waMessageId, 'recurring_cost', kind, 'applied');
    return { content: said, terminalReply: said };
  }
  if (name === 'propose_price_update') {
    if (!hasExplicitPriceUpdateEvidence(said)) {
      return {
        content: lang === 'sw'
          ? 'Huu ujumbe hauna bei mpya iliyotajwa. Ufafanuzi wa jina la bidhaa si kubadilisha bei. Tumia propose_business_event kuendelea na tukio la awali, na tumia bei zilizopo kwenye katalogi.'
          : 'The current message does not state a new price. A product-name correction is not a price update. Use propose_business_event to continue the earlier event and use the catalogue prices.',
        isError: true,
      };
    }
    // The model SPLITS the sentence; the server READS every number. Same
    // boundary as every proposing tool: price_wording is the trader's own
    // words, price_candidate is the model's reading of them, and a
    // disagreement is a question rather than a coin toss.
    const raw = Array.isArray(input.lines) ? input.lines : [];
    if (raw.length === 0 || raw.length > 60) {
      const ask = lang === 'sw'
        ? 'Niandikie bidhaa na bei yake — mfano: _"bei ya birika iwe 5000, sodaa 2000"_.'
        : 'Send me the product and its price — for example _"bei ya birika iwe 5000, sodaa 2000"_.';
      return { content: ask, terminalReply: ask };
    }

    const unreadable: string[] = [];
    const wanted: Array<{
      asked: string;
      price: number;
      wholesale: number | null;
      minQty: number | null;
      cost: ProductCost | null;
    }> = [];
    for (const entry of raw) {
      const line = (entry ?? {}) as Record<string, unknown>;
      const asked = String(line.product ?? line.product_wording ?? '').trim().slice(0, 80);
      // Bounded the same way a selling price is bounded everywhere else: a
      // price of zero is not a price, and eight figures is a typo.
      const retailWording = typeof line.retail_wording === 'string' && line.retail_wording.trim()
        ? line.retail_wording : line.price_wording;
      const retailCandidate = line.retail_price ?? line.price_candidate;
      const reading = readNumber(retailWording, retailCandidate, { min: 0, max: 100_000_000 });
      const canonical = validatePriceUpdateCandidate({
        product: asked,
        cost: line.cost,
        retail_price: reading.kind === 'value' ? reading.value : null,
        wholesale_price: line.wholesale_price ?? line.wholesale_candidate,
        wholesale_min_qty: line.wholesale_min_qty,
      });
      if (!asked || reading.kind !== 'value' || canonical.kind !== 'ok') {
        unreadable.push(asked || String(line.price_wording ?? '').slice(0, 40));
        continue;
      }
      const trade = readNumber(line.wholesale_wording, canonical.value.wholesale_price,
        { min: 0, max: 100_000_000 });
      if (line.wholesale_price !== null && line.wholesale_price !== undefined && trade.kind !== 'value') {
        unreadable.push(asked);
        continue;
      }
      const costWording = typeof line.cost_wording === 'string' ? line.cost_wording : null;
      let cost: ProductCost | null = null;
      if (costWording || line.cost !== null && line.cost !== undefined) {
        const costRead = readNumber(costWording, line.cost, { min: 0, max: 1_000_000_000 });
        if (costRead.kind !== 'value') {
          unreadable.push(asked);
          continue;
        }
        const unitWording = typeof line.purchase_unit === 'string'
          ? line.purchase_unit
          : typeof line.cost_unit_wording === 'string'
            ? line.cost_unit_wording
            : typeof line.unit === 'string' ? line.unit : null;
        const unitName = unitWording?.replace(/^(?:kwa|per|kila)\s+/iu, '').trim() ?? null;
        cost = { product: asked, unitCost: costRead.value, unit: normaliseUnit(unitName) };
      }
      wanted.push({
        asked,
        price: reading.value,
        wholesale: trade.kind === 'value' ? trade.value : canonical.value.wholesale_price,
        minQty: canonical.value.wholesale_min_qty,
        cost,
      });
    }

    // Names are resolved before anything is asked, so one uncertain spelling
    // cannot cost the prices that were never in doubt — the lesson the
    // deterministic path learned the hard way. A WRITE must never use a
    // substring/prefix guess: "vest" is not "Vestline". Exact catalogue names
    // are updates; an unknown name with the complete cost and selling prices is
    // a new-product draft and waits for the same confirmation as every other
    // write.
    const { data: catalogue } = await db.rpc('company_product_names', {
      p_company_id: identity.company_id,
    });
    const known = ((catalogue ?? []) as Array<Record<string, unknown>>)
      .map((row) => String(row.product_name ?? '').trim()).filter(Boolean);
    const prices: SellingPrice[] = [];
    const newProducts: NewProductPricing[] = [];
    for (const one of wanted) {
      const needle = one.asked.toLocaleLowerCase('sw-TZ');
      const exact = known.find((entry) => entry.toLocaleLowerCase('sw-TZ') === needle);
      if (!exact) {
        if (one.cost) {
          newProducts.push({
            product: one.asked,
            unitCost: one.cost.unitCost,
            retail: one.price,
            wholesale: one.wholesale,
            wholesaleMinQty: one.minQty,
            unit: one.cost.unit,
          });
        } else {
          unreadable.push(one.asked);
        }
        continue;
      }
      // One product is one line. See addPriceTier — this is where the owner
      // was shown shuka twice, once for each of its two prices.
      addPriceTier(prices, exact, one.price, one.wholesale, one.minQty);
      if (one.cost) one.cost.product = exact;
    }

    // A complete unknown-product price list belongs to the existing new-product
    // confirmation state. It must not be forced into the known-product price
    // batch, and it must never be silently confirmed as only the lines the
    // model happened to understand.
    if (newProducts.length === wanted.length && unreadable.length === 0) {
      const state: NewProductPricingState = {
        kind: 'new_product_pricing',
        products: newProducts,
      };
      await db.from('whatsapp_conversations').upsert({
        identity_id: identity.id,
        company_id: identity.company_id,
        profile_id: identity.profile_id,
        awaiting: 'product_cost',
        receipt_id: null,
        options: state,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'identity_id' });
      const question = newProductConfirmation(newProducts, lang);
      await audit(db, identity, waMessageId, 'new_product', String(newProducts.length), 'pending');
      return { content: question, terminalReply: question };
    }

    // Never show a confirmation for a partial model read. Give the model the
    // validation result so it can call the same tool again with every product
    // line. If it still cannot repair the structure, the normal AI failure
    // path will fall back safely instead of writing half the message.
    if (unreadable.length > 0) {
      const names = [...new Set(unreadable)].join(', ');
      const correction = lang === 'sw'
        ? `Usitoe jibu bado. Rudia propose_price_update kwa kila bidhaa uliyotajwa; mistari hii haijasomeka kikamilifu: ${names}. Kila bidhaa lazima iwe na retail_price yake; usiache bidhaa yoyote na usiunganishe bidhaa mbili.`
        : `Do not answer yet. Call propose_price_update again for every product mentioned; these lines were not read completely: ${names}. Each product must have its own retail_price; do not omit or merge products.`;
      return { content: correction, isError: true };
    }

    if (prices.length === 0) {
      const ask = sellingPriceBatchConfirmation(
        { kind: 'selling_price_batch', prices: [], unreadable }, lang);
      return { content: ask, terminalReply: ask };
    }

    const costs = wanted
      .map((one) => one.cost)
      .filter((one): one is ProductCost => Boolean(one))
      .map((one) => ({ ...one }));
    const batch: SellingPriceBatch = { kind: 'selling_price_batch', prices, unreadable };
    const { data: activeConversation } = await db.from('whatsapp_conversations')
      .select('options')
      .eq('identity_id', identity.id)
      .maybeSingle();
    const active = (activeConversation?.options ?? null) as Record<string, unknown> | null;
    const activeKind = String(active?.kind ?? '');
    const existingCosts = activeKind === 'product_cost_batch'
      ? (Array.isArray(active?.costs) ? active.costs as ProductCost[] : [])
      : activeKind === 'price_and_cost_pending'
        ? (Array.isArray(active?.costs) ? active.costs as ProductCost[] : [])
        : active && typeof active.product === 'string' && active.unitCost !== undefined
          ? [active as unknown as ProductCost]
          : [];
    const combinedCosts = [...existingCosts, ...costs];
    let pending: SellingPriceBatch | PriceAndCostPending = combinedCosts.length > 0
      ? { kind: 'price_and_cost_pending', prices, costs: combinedCosts, unreadable, }
      : batch;

    // Product cost writes are stricter than selling-price writes: a configured
    // product must be tied to a declared purchase unit. Do not wait for the
    // confirmation button to discover that, and do not make the model guess
    // whether “mafuta” means cooking oil, lamp oil or body oil.
    if (pending.kind === 'price_and_cost_pending') {
      const purchaseUnits = await purchaseUnitsForProducts(db, identity);
      const firstCost = pending.costs[0];
      const productCandidates = firstCost && isSemanticallyAmbiguousProduct(firstCost.product)
        ? known.filter((name) => productKey(name) !== productKey(firstCost.product)
          && productKey(name).includes(productKey(firstCost.product))).slice(0, 8)
        : [];
      const unitOptions = firstCost ? (purchaseUnits.get(productKey(firstCost.product)) ?? []) : [];
      const missingUnit = Boolean(firstCost && unitOptions.length > 0 && !firstCost.unit);
      const invalidUnit = Boolean(firstCost && firstCost.unit && unitOptions.length > 0
        && !unitOptions.some((unit) => normalizedChoice(unit) === normalizedChoice(firstCost.unit!)));
      if (productCandidates.length > 0 || isSemanticallyAmbiguousProduct(firstCost?.product ?? '') || missingUnit || invalidUnit) {
        const clarification: NonNullable<PriceAndCostPending['clarification']> = {
          reason: productCandidates.length > 0 || isSemanticallyAmbiguousProduct(firstCost?.product ?? '')
            ? (missingUnit || invalidUnit ? 'purchase_unit_and_product_identity' : 'product_identity')
            : 'purchase_unit',
          product: firstCost?.product ?? wanted[0]?.asked ?? '',
          unitOptions,
          productCandidates,
        };
        pending = { ...pending, clarification };
        await db.from('whatsapp_conversations').upsert({
          identity_id: identity.id,
          company_id: identity.company_id,
          profile_id: identity.profile_id,
          awaiting: 'product_cost',
          receipt_id: null,
          options: pending,
          expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'identity_id' });
        const clarificationText = priceAndCostClarificationText(clarification, lang);
        await audit(db, identity, waMessageId, 'price_and_cost_pending', 'clarification', 'skipped');
        return { content: clarificationText, terminalReply: clarificationText, fallbackReply: clarificationText };
      }
    }
    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id,
      company_id: identity.company_id,
      profile_id: identity.profile_id,
      awaiting: 'product_cost',
      receipt_id: null,
      options: pending,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    const priceQuestion = sellingPriceBatchConfirmation(batch, lang);
    const costSummary = combinedCosts.length === 0 ? ''
      : (lang === 'sw' ? '\n\nBei za kununua zilizotajwa pia zitawekwa:\n' : '\n\nThe stated buying costs will also be saved:\n')
        + combinedCosts.map((cost) => `• ${cost.product} — TSh ${Math.round(cost.unitCost).toLocaleString('en-US')}`).join('\n');
    const question = costSummary
      ? priceQuestion.replace(/\n\nNihifadhi zote\?/u, `${costSummary}\n\nNihifadhi zote?`)
      : priceQuestion;
    return { content: question, terminalReply: question };
  }
  if (name === 'propose_record_void') {
    // Taking money back off the books is as consequential as putting it there,
    // so this only ever DRAFTS: it finds the record, shows it, and parks the
    // same pending state the wording parser used to park. The write still
    // happens on the trader's NDIYO and nowhere else.
    if (!canUseCompanyFinanceReads(identity.role)) {
      const denied = voidNotAllowed(lang);
      return { content: denied, isError: true, terminalReply: denied };
    }
    const asked = typeof input.target_wording === 'string' ? input.target_wording.trim() : '';

    const { data: recent } = await db.from('daily_records')
      .select('id, kind, amount, party_name, description, occurred_at')
      .eq('company_id', identity.company_id).eq('status', 'confirmed')
      .is('voided_at', null)
      .order('occurred_at', { ascending: false }).limit(20);
    const rows = (recent ?? []) as Array<Record<string, unknown>>;
    if (rows.length === 0) {
      const none = voidNothingFound(lang);
      return { content: none, terminalReply: none };
    }

    const { data: lines } = await db.from('daily_record_lines')
      .select('daily_record_id, description, quantity')
      .in('daily_record_id', rows.map((row) => String(row.id))).limit(400);
    const linesFor = (id: string) => ((lines ?? []) as Array<Record<string, unknown>>)
      .filter((line) => String(line.daily_record_id) === id)
      .map((line) => ({
        description: String(line.description ?? ''),
        quantity: Number(line.quantity ?? 0),
      }));

    const candidates = rows.map((row) => normalizeVoidTarget({
      ...row, lines: linesFor(String(row.id)),
    })).filter((one): one is VoidTarget => Boolean(one));

    // No wording means the last thing saved, which is what "futa ile" has
    // always meant. Wording narrows by what the trader can actually see: the
    // product, the customer, or the kind of record.
    const wanted = asked.toLocaleLowerCase('sw-TZ');
    const hits = !wanted ? candidates.slice(0, 1) : candidates.filter((one) =>
      one.lines.some((line) => line.description.toLocaleLowerCase('sw-TZ').includes(wanted))
      || String(one.partyName ?? '').toLocaleLowerCase('sw-TZ').includes(wanted)
      || String(one.description ?? '').toLocaleLowerCase('sw-TZ').includes(wanted)
      || voidKindMatches(one.kind, wanted));

    if (hits.length === 0) {
      const none = voidNothingFound(lang);
      return { content: none, terminalReply: none };
    }
    if (hits.length > 1) {
      // More than one fits. Listing them is the answer; picking one would be
      // deleting money on a guess.
      const ask = voidChoiceQuestion(hits.slice(0, 5), lang);
      return { content: ask, terminalReply: ask };
    }

    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id,
      company_id: identity.company_id,
      profile_id: identity.profile_id,
      awaiting: 'product_cost',
      receipt_id: null,
      options: { kind: 'void_record', target: hits[0] } satisfies VoidPending,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    const question = voidConfirmation(hits[0], lang);
    return { content: question, terminalReply: question };
  }
  if (name === 'get_debtor_history') {
    // Same boundary as every other whole-ledger read: who owes the shop and
    // for how long is a company financial, not a worker's own record.
    if (!canReadCompanyReporting(identity.role)) {
      const denied = lang === 'sw'
        ? 'Historia ya madeni inaonekana kwa owner au accountant tu.'
        : 'Debt history is available to an owner or accountant only.';
      return { content: denied, isError: true, terminalReply: denied };
    }
    const { data: rows } = await db.from('daily_records')
      .select('kind, status, amount, party_name, occurred_at')
      .eq('company_id', identity.company_id).eq('status', 'confirmed')
      .in('kind', ['debt_issued', 'customer_payment'])
      .order('occurred_at', { ascending: true }).limit(20000);
    const histories = calculateDebtorHistories(
      ((rows ?? []) as Array<Record<string, unknown>>).map((row) => ({
        kind: String(row.kind ?? ''), status: String(row.status ?? ''),
        amount: Number(row.amount ?? 0),
        partyName: (row.party_name ?? null) as string | null,
        occurredAt: (row.occurred_at ?? null) as string | null,
      })),
    );

    const asked = typeof input.party_wording === 'string' ? input.party_wording.trim() : '';
    if (!asked) {
      return {
        content: debtorAgeingFacts(histories),
        fallbackReply: debtorAgeingReply(histories, lang),
      };
    }
    // Matched the way every other party lookup matches, so "mama anna" finds
    // "Mama Anna" and a partial finds the one customer it can only be.
    const wanted = asked.toLocaleLowerCase('sw-TZ');
    const hits = histories.filter((one) =>
      one.partyName.toLocaleLowerCase('sw-TZ').includes(wanted));
    const one = hits.length === 1 ? hits[0]
      : hits.find((entry) => entry.partyName.toLocaleLowerCase('sw-TZ') === wanted) ?? null;
    if (!one && hits.length > 1) {
      // Two customers share the wording. Naming them is the answer, not a guess.
      const names = hits.slice(0, 6).map((entry) => entry.partyName).join(', ');
      const ask = lang === 'sw'
        ? `Kuna zaidi ya mmoja: ${names}. Ni yupi?`
        : `More than one matches: ${names}. Which one?`;
      return { content: ask, terminalReply: ask };
    }
    return {
      content: one ? debtorHistoryFacts(one) : `debtor_not_found=${asked}`,
      fallbackReply: debtorHistoryReply(one, asked, lang),
    };
  }
  if (name === 'get_daily_breakdown') {
    if (!canReadCompanyReporting(identity.role)) {
      const denied = lang === 'sw'
        ? 'Mchanganuo wa siku kwa siku unaonekana kwa owner au accountant tu.'
        : 'The day-by-day breakdown is available to an owner or accountant only.';
      return { content: denied, isError: true, terminalReply: denied };
    }
    const asked = typeof input.period_wording === 'string' ? input.period_wording.trim() : '';
    if (asked && dateWordingStatus(asked) === 'invalid') {
      const message = lang === 'sw'
        ? 'Sijaweza kutambua tarehe hiyo kwa usalama. Tafadhali andika tarehe kamili, kwa mfano *tarehe 23 Agosti 2026*.'
        : 'I could not resolve that date safely. Please write the full date, for example *23 August 2026*.';
      return { content: message, terminalReply: message, isError: true };
    }
    const { days, periodLabel } = await buildDailyBreakdown(db, identity, lang, asked || null);
    // STAGE D. "Onyesha kila siku" wants thirty rows; "siku gani ilikuwa bora"
    // wants one sentence naming a day. A rendered table would answer the first
    // question whatever was asked, so the model gets the figures and decides
    // the shape; the table survives only if the model cannot finish.
    const rendered = dailyBreakdownReply(days, periodLabel, lang);
    // The day figures AND the shape of them. "Siku gani ilikuwa bora" is a
    // maximum; "mauzo yanashuka wiki tatu mfululizo" is a property of the
    // sequence, and the model could not see it before.
    return {
      content: `${dailyBreakdownFacts(days, periodLabel)}
${trendShapeFacts(days)}`,
      fallbackReply: rendered,
    };
  }
  if (name === 'get_day_comparison') {
    // MEASURED: "linganisha faida mauzo ya tarehe 17 na 23" came back with the
    // 17th alone. The model did the right thing and the contract did not — it
    // reached for get_day_records, whose answer is terminal and ends the turn,
    // so the second date had nowhere to go and was dropped in silence. Half an
    // answer, delivered with the confidence of a whole one.
    if (!canReadCompanyReporting(identity.role)) {
      const denied = lang === 'sw'
        ? 'Kulinganisha siku kunaonekana kwa owner au accountant tu.'
        : 'Comparing days is available to an owner or accountant only.';
      return { content: denied, isError: true, terminalReply: denied };
    }
    const firstSaid = typeof input.first_date_wording === 'string' ? input.first_date_wording.trim() : '';
    const secondSaid = typeof input.second_date_wording === 'string' ? input.second_date_wording.trim() : '';
    if (!firstSaid || !secondSaid) {
      const ask = lang === 'sw'
        ? 'Niambie siku zote mbili, mfano: _tarehe 17 na tarehe 23_.'
        : 'Name both days, for example: _the 17th and the 23rd_.';
      return { content: ask, terminalReply: ask };
    }
    const readDay = async (said: string) => {
      try {
        return await buildDayCloseFacts(db, identity, lang, said);
      } catch {
        // An unreadable date is never answered with a different day.
        return null;
      }
    };
    const [dayA, dayB] = await Promise.all([readDay(firstSaid), readDay(secondSaid)]);
    if (!dayA || !dayB) {
      const bad = !dayA ? firstSaid : secondSaid;
      const ask = lang === 'sw'
        ? `Sijaelewa tarehe "${bad}". Iandike kama _tarehe 17_ au _juzi_.`
        : `I could not read the date "${bad}". Write it as _tarehe 17_ or _juzi_.`;
      return { content: ask, terminalReply: ask };
    }
    // Every difference is subtracted HERE. The model states them; it never
    // works them out, which is the rule everywhere else in this file.
    const grossOf = (facts: DayCloseFacts) => facts.grossProfit ?? (facts.sales - facts.cogs);
    const line = (tag: string, said: string, facts: DayCloseFacts) =>
      `${tag}=${facts.date}|asked_as=${said}|label=${facts.dateLabel}`
      + `|sales=${Math.round(facts.sales)}|cogs=${Math.round(facts.cogs)}`
      + `|gross_profit=${Math.round(grossOf(facts))}`
      + `|expenses=${Math.round(facts.expenses ?? 0)}`
      + `|purchases=${Math.round(facts.purchases ?? 0)}`
      + `|records=${facts.recordCount}`;
    const salesGap = Math.round(dayA.sales - dayB.sales);
    const grossGap = Math.round(grossOf(dayA) - grossOf(dayB));
    const better = grossGap === 0 ? 'equal' : (grossGap > 0 ? 'first' : 'second');
    return {
      content: [
        line('first_day', firstSaid, dayA),
        line('second_day', secondSaid, dayB),
        `sales_difference=${Math.abs(salesGap)}`,
        `gross_profit_difference=${Math.abs(grossGap)}`,
        `better_by_gross_profit=${better}`,
        'note=gross profit is sales minus cost of goods sold; recorded expenses are listed separately.',
      ].join('\n'),
    };
  }
  if (name === 'get_day_records') {
    // A whole day's entries is a company financial: it shows what every worker
    // sold and what every customer owes. Same boundary as the summary.
    if (!canReadCompanyReporting(identity.role)) {
      const denied = lang === 'sw'
        ? 'Orodha ya miamala ya siku nzima inaonekana kwa owner au accountant tu.'
        : 'The full day’s records are available to an owner or accountant only.';
      return { content: denied, isError: true, terminalReply: denied };
    }
    const asked = typeof input.date_wording === 'string' ? input.date_wording.trim() : '';
    if (asked && dateWordingStatus(asked) === 'invalid') {
      const message = lang === 'sw'
        ? 'Sijaweza kutambua tarehe hiyo kwa usalama. Tafadhali andika tarehe kamili, kwa mfano *tarehe 23 Agosti 2026*.'
        : 'I could not resolve that date safely. Please write the full date, for example *23 August 2026*.';
      return { content: message, terminalReply: message, isError: true };
    }
    const facts = await buildDayCloseFacts(db, identity, lang, asked || null);
    if (facts.recordCount === 0) {
      const none = lang === 'sw'
        ? `Hakuna kilichorekodiwa ${facts.dateLabel}.`
        : `Nothing was recorded on ${facts.dateLabel}.`;
      return { content: none, terminalReply: none };
    }
    // terminalReply: the list IS the answer. A model rewriting it would be
    // retyping forty figures it has no reason to touch.
    const list = ownerDayListReply(facts, lang);
    return { content: list, terminalReply: list };
  }
  if (name === 'propose_day_close') {
    // The word was understood by the model; the DAY is assembled here. Nothing
    // is written yet — this parks a draft and waits for NDIYO, exactly like a
    // sale does, because closing a day is a write like any other.
    const facts = await buildDayCloseFacts(db, identity, lang);
    if (facts.recordCount === 0) {
      const empty = nothingToCloseReply(facts, lang);
      return { content: empty, terminalReply: empty };
    }
    const { data: already } = await db.from('daily_closures')
      .select('closed_at').eq('company_id', identity.company_id)
      .eq('business_date', facts.businessDate).maybeSingle();
    if (already) {
      const done = lang === 'sw'
        ? `Siku ya ${facts.dateLabel} tayari imefungwa saa ${shopClock(new Date(already.closed_at as string), lang)}.`
        : `${facts.dateLabel} was already closed at ${shopClock(new Date(already.closed_at as string), lang)}.`;
      return { content: done, terminalReply: done };
    }

    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id,
      company_id: identity.company_id,
      profile_id: identity.profile_id,
      awaiting: 'day_close',
      receipt_id: null,
      options: { kind: 'day_close', business_date: facts.businessDate },
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }, { onConflict: 'identity_id' });

    const draft = dayDraftReply(facts, lang);
    // terminalReply: the draft is the protocol. A model that rewrote it could
    // drop a line the shopkeeper is about to agree to.
    return { content: draft, terminalReply: draft };
  }
  if (name === 'respond_conversationally') {
    // Zero side effects, by construction: no database call, no read, no draft.
    // Its whole purpose is to make "I will just talk" an explicit choice the
    // baseline can count, instead of the silent default it used to be.
    const reason = String(input.reason ?? 'off_topic');
    return {
      content: `conversational_reason=${reason}`,
      fallbackReply: lang === 'sw'
        ? 'Niko hapa. Niandikie mauzo, matumizi, deni au swali kuhusu biashara yako.'
        : 'I am here. Send me a sale, an expense, a debt, or a question about your business.',
    };
  }
  if (name === 'get_supplier_payables') {
    // The opposite ledger from get_open_debts. Stage A.1 found every payable
    // question landing on receivables because no payables tool existed at all.
    const supplier = typeof input.supplier_wording === 'string' ? input.supplier_wording.trim() : '';
    return { content: await supplierBalanceReply(db, identity, { supplierName: supplier || null }, lang) };
  }
  if (name === 'propose_catalogue_transaction') {
    const interpreted = validateAiTransactionCandidate(input);
    const invalid = lang === 'sw'
      ? 'Sijaelewa bidhaa, idadi au kipimo kwa uhakika. Niandikie bidhaa na idadi yake.'
      : 'I could not safely understand the product, quantity or unit. State the product and its quantity.';
    if (!interpreted) return { content: invalid, isError: true, terminalReply: invalid };
    const aiDate = resolveTransactionDate(interpreted.occurredAtWording);
    if (aiDate.kind === 'invalid') {
      const question = transactionDateQuestion(aiDate.reason, lang);
      return { content: question, isError: true, terminalReply: question };
    }
    const aiOccurredAt = aiDate.occurredAt;

    if (interpreted.kind === 'missing_quantity') {
      const found = await resolveProductForRead(db, identity, interpreted.wanted.product);
      if (found.error || found.resolution.kind !== 'matched') {
        const unknown = lang === 'sw'
          ? `Sijapata bidhaa *${interpreted.wanted.product}* kwenye bidhaa za biashara hii. Taja jina lililosajiliwa.`
          : `I could not find *${interpreted.wanted.product}* in this business catalogue. Use its registered name.`;
        return { content: unknown, isError: true, terminalReply: unknown };
      }
      const match = found.resolution.match;
      const { data: unitRows, error: unitError } = await db.rpc('wa_company_product_sale_units', {
        p_company_id: identity.company_id,
      });
      const units = (unitError ? [] : (unitRows ?? []) as Array<Record<string, unknown>>)
        .filter((row) => String(row.product_key ?? '') === match.productKey)
        .map((row) => String(row.unit_name ?? '')).filter(Boolean);
      const wanted: QuantityWanted = {
        ...interpreted.wanted, product: match.productName, occurredAt: aiOccurredAt,
      };
      await db.from('whatsapp_conversations').upsert({
        identity_id: identity.id,
        company_id: identity.company_id,
        profile_id: identity.profile_id,
        awaiting: 'daily_record_quantity',
        receipt_id: null,
        options: wanted,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'identity_id' });
      const question = units.length > 1
        ? quantityUnitQuestion(match.productName, units, lang)
        : quantityQuestion(match.productName, units[0] ?? null, lang);
      return { content: question, terminalReply: question };
    }

    const priced = await priceQuantitySale(
      db, identity, interpreted.sale, lang, [], interpreted.credit, aiOccurredAt,
    );
    if (priced.kind === 'blocked') {
      if (priced.choice) {
        await parkProductChoice(db, identity, waMessageId,
          priced.choice.asked, priced.choice.candidates, said);
      }
      return { content: priced.message, isError: true, terminalReply: priced.message };
    }
    if (priced.kind === 'unknown') {
      const unknown = unknownProductMessage(priced.products, priced.resolvedProducts, lang);
      return { content: unknown, isError: true, terminalReply: unknown };
    }
    if (priced.kind === 'band') {
      const state: PriceBandPending = {
        kind: 'price_band_choice',
        sale: priced.sale,
        choices: priced.choices,
        answered: priced.choices.map(() => null),
        sourceMessageId: waMessageId,
        settled: priced.settled ?? [],
        credit: interpreted.credit,
        paymentMethod: interpreted.paymentMethod,
        occurredAt: aiOccurredAt,
      };
      await db.from('whatsapp_conversations').upsert({
        identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
        awaiting: 'product_cost', receipt_id: null, options: state,
        expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
      }, { onConflict: 'identity_id' });
      const question = priceBandQuestion(priced.choices, lang, priced.settled ?? []);
      return { content: question, terminalReply: question };
    }
    if (priced.kind === 'combo_question' || priced.kind === 'combo_variant') {
      const question = lang === 'sw'
        ? 'Nimepata zaidi ya bidhaa au kipimo kimoja kinachoweza kumaanishwa. Taja jina kamili la bidhaa na kipimo chake.'
        : 'More than one product or unit could match. State the full product name and its unit.';
      return { content: question, isError: true, terminalReply: question };
    }
    if (priced.kind !== 'priced') return { content: invalid, isError: true, terminalReply: invalid };

    const record = interpreted.paymentMethod
      ? { ...priced.record, paymentMethod: interpreted.paymentMethod }
      : priced.record;
    const guardedRecord = await addHistoricalPriceWarnings(db, identity.company_id, record);
    const created = await createDailyRecordDraft(db, identity, waMessageId, guardedRecord, lang, said);
    if (created.error || !created.id) {
      const failed = lang === 'sw'
        ? 'Sikuweza kuhifadhi draft hii. Hakuna rekodi iliyothibitishwa; tafadhali jaribu tena.'
        : 'I could not save this draft. No record was confirmed; please try again.';
      return { content: failed, isError: true, terminalReply: failed };
    }
    const state: DailyRecordConversation = {
      kind: 'daily_record_confirmation',
      dailyRecordId: created.id,
      sourceMessageId: waMessageId,
      record: guardedRecord,
    };
    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
      awaiting: 'payment_source', receipt_id: null, options: state,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    const confirmation = `${identity.company_name} — ${quantitySaleConfirmation(priced.lines, lang, [], priced.notCounted)}`;
    return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
  }
  if (name === 'propose_daily_record') {
    const parsed = validateAiCandidate(input, said);
    if (!parsed) {
      const clarification = lang === 'sw'
        ? 'Sijaweza kuthibitisha kiasi na hesabu zake. Taja aina ya rekodi, bidhaa au matumizi, quantity na bei—na useme kama bei ni jumla au ya kila moja.'
        : 'I could not validate the amount and its arithmetic. State the record type, item or expense, quantity and price—and say whether the price is the total or per item.';
      return { content: clarification, isError: true, terminalReply: clarification };
    }
    const guardedRecord = await addHistoricalPriceWarnings(db, identity.company_id, parsed);
    const created = await createDailyRecordDraft(db, identity, waMessageId, guardedRecord, lang, said);
    if (created.error || !created.id) {
      const failed = lang === 'sw'
        ? 'Sikuweza kuhifadhi draft hii. Hakuna rekodi iliyothibitishwa; tafadhali jaribu tena.'
        : 'I could not save this draft. No record was confirmed; please try again.';
      return { content: failed, isError: true, terminalReply: failed };
    }
    const state: DailyRecordConversation = {
      kind: 'daily_record_confirmation',
      dailyRecordId: created.id,
      sourceMessageId: waMessageId,
      record: guardedRecord,
    };
    await db.from('whatsapp_conversations').upsert({
      identity_id: identity.id,
      company_id: identity.company_id,
      profile_id: identity.profile_id,
      awaiting: 'payment_source',
      receipt_id: null,
      options: state,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'identity_id' });
    // Asked before NDIYO, while the trader can still change the name. Afterwards
    // it would be a second product with sales already in it.
    const nearName = await nearNameNotice(db, identity.company_id, guardedRecord, lang);
    const underPrice = await belowOwnPriceNotice(db, identity.company_id, guardedRecord, lang);
    const confirmation = `${identity.company_name} — ${buildDailyRecordConfirmation(guardedRecord, lang)}${nearName}${underPrice}`;
    return { content: confirmation, terminalReply: confirmation, fallbackReply: confirmation };
  }
  return {
    content: lang === 'sw' ? 'Tool hiyo haipatikani.' : 'That tool is not available.',
    isError: true,
  };
}

async function activeProjects(db: Admin, companyId: string): Promise<{ id: string; name: string }[]> {
  const { data } = await db
    .from('projects')
    .select('id, name')
    .eq('company_id', companyId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  return (data ?? []) as { id: string; name: string }[];
}

async function parkProjectSetup(
  db: Admin,
  identity: any,
  messageId: string,
  mediaId: string,
  mediaMime: string | null,
  caption: string | null,
  lang: Lang,
): Promise<string> {
  const { data: profile } = await db
    .from('profiles')
    .select('id, company_id, role, deactivated_at')
    .eq('id', identity.profile_id)
    .maybeSingle();

  const projects = await activeProjects(db, identity.company_id as string);
  const canUseProject = projects.length > 0;
  let workerHasProject = false;
  if (profile?.role === 'worker' && projects.length > 0) {
    const { data: memberships } = await db.from('project_members')
      .select('project_id').eq('profile_id', identity.profile_id);
    const memberIds = new Set((memberships ?? []).map((row) => String(row.project_id)));
    workerHasProject = projects.some((project) => memberIds.has(project.id));
  }
  if ((profile?.role === 'owner' || profile?.role === 'accountant') && canUseProject) return '';
  if (profile?.role === 'worker' && workerHasProject) return '';

  await db.from('whatsapp_messages').update({
    profile_id: identity.profile_id,
    company_id: identity.company_id,
    media_id: mediaId,
    media_mime: mediaMime,
    caption,
    status: 'skipped',
    last_error: 'awaiting_project_setup',
    processed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('wa_message_id', messageId);

  if (!profile || profile.deactivated_at || profile.company_id !== identity.company_id || profile.role === 'worker') {
    return projectSetupWorkerReply(lang);
  }

  const { data: company } = await db.from('companies').select('name').eq('id', identity.company_id).maybeSingle();
  const setup: ProjectSetupState = {
    kind: 'project_setup', stage: 'choose', mediaMessageId: messageId,
  };
  await db.from('whatsapp_conversations').upsert({
    identity_id: identity.id,
    company_id: identity.company_id,
    profile_id: identity.profile_id,
    awaiting: 'project',
    receipt_id: null,
    options: setup,
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'identity_id' });

  return projectSetupPrompt(lang, String(company?.name ?? 'your business'));
}

async function createOrReuseProject(
  db: Admin,
  identity: any,
  projectName: string,
): Promise<{ id: string; name: string; created: boolean } | null> {
  const { data: profile } = await db
    .from('profiles')
    .select('id, company_id, role, deactivated_at')
    .eq('id', identity.profile_id)
    .maybeSingle();
  if (!profile || profile.deactivated_at || profile.company_id !== identity.company_id) return null;
  if (!canCreateProject(profile.role)) return null;

  const { data: existing } = await db
    .from('projects')
    .select('id, name')
    .eq('company_id', identity.company_id)
    .eq('status', 'active')
    .eq('name', projectName)
    .limit(1)
    .maybeSingle();

  let project = existing as { id: string; name: string } | null;
  let created = false;
  if (!project) {
    const { data, error } = await db.from('projects').insert({
      company_id: identity.company_id,
      name: projectName,
      status: 'active',
      created_by: identity.profile_id,
    }).select('id, name').single();
    if (data) {
      project = data as { id: string; name: string };
      created = true;
    } else if (error) {
      // A concurrent setup may have created the same name. Reuse it rather than
      // turning a harmless duplicate into a failed receipt flow.
      const { data: raced } = await db
        .from('projects').select('id, name').eq('company_id', identity.company_id)
        .eq('status', 'active').eq('name', projectName).limit(1).maybeSingle();
      if (!raced) return null;
      project = raced as { id: string; name: string };
    }
  }

  const { error: memberError } = await db.from('project_members').upsert({
    project_id: project.id,
    profile_id: identity.profile_id,
  }, { onConflict: 'project_id,profile_id' });
  if (memberError) return null;
  return { ...project, created };
}

async function resumePendingReceipt(db: Admin, identity: any, mediaMessageId: string): Promise<boolean> {
  const { data, error } = await db.from('whatsapp_messages').update({
    status: 'pending',
    last_error: null,
    processed_at: null,
    retry_count: 0,
    updated_at: new Date().toISOString(),
  }).eq('wa_message_id', mediaMessageId)
    .eq('company_id', identity.company_id)
    .eq('profile_id', identity.profile_id)
    .is('receipt_id', null)
    .select('id')
    .maybeSingle();
  return !error && Boolean(data);
}

/** Append-only trail: intent and outcome only, never bodies or secrets. */
/**
 * The message currently being handled, so `audit` can record what was asked.
 *
 * Every answer-quality defect in this project so far was found because the owner
 * screenshotted it. That does not scale past one shop and only catches what
 * somebody happened to be looking at. Keeping the question — with anything
 * phone-shaped masked, and never a linking token — turns the audit log into the
 * work queue it should always have been.
 */
let auditedText: string | null = null;

const LINK_TOKEN = /^\s*link\b/i;

/** A LINK message carries a single-use secret and is never written down. */
function isLinkMessage(text: string | null | undefined): boolean {
  return LINK_TOKEN.test(String(text ?? ''));
}

function rememberForAudit(body: string | null | undefined): void {
  const text = String(body ?? '').trim();
  // A LINK message carries a single-use secret. It is never worth learning from
  // and must never be written down.
  auditedText = !text || LINK_TOKEN.test(text) ? null : text.slice(0, 2000);
}

async function audit(
  db: Admin, identity: any, waMessageId: string,
  intent: string, action: string, outcome: string, receiptId?: string,
  claimedBy?: string,
): Promise<void> {
  try {
    await db.from('whatsapp_audit_log').insert({
      company_id: identity?.company_id ?? null,
      profile_id: identity?.profile_id ?? null,
      wa_message_id: waMessageId,
      intent, action, outcome,
      receipt_id: receiptId ?? null,
      message_text: auditedText === null ? null : maskDigits(auditedText),
      claimed_by: claimedBy ?? intent,
    });
  } catch { /* auditing must not break the flow */ }
}

/** A run of nine or more digits is a phone number far more often than a price. */
function maskDigits(text: string): string {
  return text.replace(/\+?\d[\d\s-]{8,}\d/g, '[namba]');
}

/** Best-effort reply. A send failure must never turn into a non-200 for Meta. */
async function sendReplyText(to: string, body: string, replyToMessageId?: string | null): Promise<void> {
  if (looksLikeMachineText(body)) {
    // Loud on purpose: this is a bug in whichever branch built `body`, and the
    // only way to find it is to see it in the logs. The shop gets a clean line
    // rather than a wall of internal data.
    console.error('BLOCKED machine text to', maskPhone(to), '·', body.slice(0, 80).replace(/\n/g, ' '));
    try {
      await sendWhatsAppText(to,
        'Samahani, kuna hitilafu ndogo kwa jibu hilo. Jaribu tena, au niulize kwa njia nyingine.',
        { replyToMessageId });
    } catch { /* swallow — see below */ }
    return;
  }
  try {
    await sendWhatsAppText(to, body, { replyToMessageId });
  } catch (err) {
    console.error('reply failed', maskPhone(to), err instanceof Error ? err.message : 'unknown');
  }
}

function typingVisibilityPause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 1500));
}

/**
 * How long a QUEUED message waits before spending its indicator.
 *
 * Not a general delay, and deliberately not applied to the ordinary case of one
 * message arriving alone. It exists for one moment: the instant a second
 * message wins the per-phone turn is the same instant the FIRST message's reply
 * is being delivered, and a delivered message dismisses whatever indicator is
 * showing. Raising the indicator into that instant is raising it to be
 * cancelled a fraction of a second later.
 */
const TYPING_SETTLE_MS = 1_200;

/** A wait shorter than this is scheduling noise, not a queue behind somebody. */
const QUEUED_BEHIND_MS = 400;

function typingSettlePause(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TYPING_SETTLE_MS));
}

/**
 * Ask for "typing…" and write down what Meta said.
 *
 * The counter matters as much as the status. If only attempt 1 for a message
 * ever succeeds, then every heartbeat pulse after it is decoration and the
 * whole approach of "pulse harder" cannot work — which is the hypothesis this
 * exists to settle. See migration 0153.
 */
function typingRecorder(
  db: Admin,
  waMessageId: string,
  receivedAtMs: number,
  queuedBehind: boolean,
): () => Promise<void> {
  let attempt = 0;
  return async () => {
    attempt += 1;
    const at = attempt;
    const outcome = await showTyping(waMessageId);
    try {
      await db.from('whatsapp_typing_attempts').insert({
        wa_message_id: waMessageId,
        attempt: at,
        http_status: outcome.status,
        meta_code: outcome.code,
        ms_since_received: Math.max(0, Date.now() - receivedAtMs),
        queued_behind_earlier: queuedBehind,
      });
    } catch (err) {
      // A diagnostic must never cost a shop its reply. But it must not fail
      // SILENTLY either: a swallowed insert leaves an empty table, an empty
      // table reads as "no pulses were sent", and that is how the next
      // investigation starts from a false fact.
      console.error('typing attempt not recorded',
        err instanceof Error ? err.message : 'unknown');
    }
  };
}

async function replyDailyRecordConfirmationQuietly(
  to: string,
  record: ParsedDailyRecord,
  lang: Lang,
  replyToMessageId?: string | null,
): Promise<void> {
  for (const chunk of buildDailyRecordConfirmationChunks(record, lang)) {
    await sendReplyText(to, chunk, replyToMessageId);
  }
}

async function replyDailyRecordBatchConfirmationQuietly(
  to: string,
  records: ParsedDailyRecord[],
  lang: Lang,
  replyToMessageId?: string | null,
): Promise<void> {
  for (const chunk of splitWhatsAppText(buildDailyRecordBatchConfirmation(records, lang))) {
    await sendReplyText(to, chunk, replyToMessageId);
  }
}

/**
 * Bind a verified WhatsApp number to a profile using a single-use token.
 * The token is compared by hash, so the plaintext never has to be stored.
 */
async function handleLink(db: Admin, phone: string, waId: string, token: string): Promise<string> {
  const hash = await sha256Hex(token);
  const { data: row } = await db
    .from('whatsapp_link_tokens')
    .select('id, profile_id, company_id, expires_at, used_at, revoked_at, attempts')
    .eq('token_hash', hash)
    .maybeSingle();

  const verdict = evaluateLinkToken(row ?? null);
  if (!verdict.ok) {
    // Record the failed attempt so token probing is visible in the data.
    if (row?.id) {
      await db.from('whatsapp_link_tokens')
        .update({ attempts: Number(row.attempts ?? 0) + 1 })
        .eq('id', row.id);
    }
    return linkFailureMessage(verdict.reason);
  }

  // The employee must still be active in their company.
  const { data: profile } = await db
    .from('profiles')
    .select('id, full_name, company_id, deactivated_at')
    .eq('id', row.profile_id)
    .maybeSingle();
  if (!profile || profile.deactivated_at) {
    return 'That Risip account is no longer active. Contact your administrator.';
  }

  // A number may only ever point at one live profile.
  const { data: clash } = await db
    .from('whatsapp_identities')
    .select('id, profile_id')
    .eq('phone_e164', phone)
    .is('revoked_at', null)
    .maybeSingle();
  if (clash && clash.profile_id !== profile.id) {
    return 'This WhatsApp number is already connected to a different Risip account. Revoke it there first.';
  }

  // Replace any previous identity for this profile, then link.
  await db.from('whatsapp_identities')
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('profile_id', profile.id)
    .is('revoked_at', null);

  const { data: created, error: insErr } = await db.from('whatsapp_identities').insert({
    profile_id: profile.id,
    company_id: profile.company_id,
    phone_e164: phone,
    wa_id: waId,
  }).select('id').single();
  if (insErr || !created) {
    console.error('identity insert failed', insErr?.message);
    return 'Could not connect this number right now. Please try again.';
  }

  await db.from('whatsapp_link_tokens')
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id);

  // Ask for a language once, right after linking, and park the conversation there
  // so the next message is read as the answer.
  await db.from('whatsapp_conversations').upsert({
    identity_id: created.id,
    company_id: profile.company_id,
    profile_id: profile.id,
    awaiting: 'language',
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'identity_id' });

  return `Connected.\n\n${t('chooseLanguage', 'en')}`;
}

// ── Onboarding a number Risip has never seen ────────────────────────────────
//
// The gate that matters: this path never touches the AI. An unknown sender's
// photo is acknowledged and dropped — media_id is never written, so
// whatsapp-worker never picks it up and nothing is extracted. A stranger cannot
// make us spend money.
type InvitePreview = {
  businessName: string;
  inviterName: string;
  role: 'worker' | 'accountant';
};

/** Read only the safe welcome context for a bearer invite code. */
async function readInvitePreview(db: Admin, code: string): Promise<InvitePreview | null> {
  const { data: row } = await db.from('company_invite_codes')
    .select('company_id, created_by, role, expires_at, revoked_at, max_uses, uses')
    .eq('code', code)
    .maybeSingle();
  const invite = row as {
    company_id?: string;
    created_by?: string;
    role?: string;
    expires_at?: string | null;
    revoked_at?: string | null;
    max_uses?: number | null;
    uses?: number | null;
  } | null;
  if (!invite?.company_id || !invite.created_by || invite.revoked_at) return null;
  if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) return null;
  if (invite.max_uses !== null && invite.max_uses !== undefined
    && Number(invite.uses ?? 0) >= Number(invite.max_uses)) return null;

  const [{ data: company }, { data: inviter }] = await Promise.all([
    db.from('companies').select('name').eq('id', invite.company_id).maybeSingle(),
    db.from('profiles').select('full_name').eq('id', invite.created_by).maybeSingle(),
  ]);
  const businessName = String((company as { name?: string } | null)?.name ?? '').trim();
  const inviterName = String((inviter as { full_name?: string } | null)?.full_name ?? '').trim();
  if (!businessName || !inviterName) return null;
  return {
    businessName,
    inviterName,
    role: invite.role === 'accountant' ? 'accountant' : 'worker',
  };
}

/**
 * Looks a signup code up by hash. Nothing is written here: a draft is only
 * burned once the business it describes actually exists.
 */
async function readSignupDraft(db: Admin, code: string): Promise<WebSignupDraftRow | null> {
  const { data } = await db
    .from('web_signup_drafts')
    .select('id, business_name, business_description, full_name, location, opening_time, closing_time, lang, claimed_at, expires_at')
    .eq('code_hash', await sha256Hex(code))
    .maybeSingle();
  const row = data as WebSignupDraftRow | null;
  return row && draftIsClaimable(row) ? row : null;
}

async function handleOnboarding(
  db: Admin, phone: string, text: string | null, isImage: boolean,
): Promise<string> {
  const { data: state } = await db
    .from('whatsapp_onboarding')
    .select('phone_e164, step, lang, draft, expires_at')
    .eq('phone_e164', phone)
    .maybeSingle();

  // Somebody who filled the web form arrives holding a code. The answers are
  // already stored, so this message is not an answer to a question: it is the
  // proof that this number is theirs. Checked before any conversation state,
  // because the draft replaces the conversation.
  const signupCode = findSignupCode(text);
  const webDraft = signupCode ? await readSignupDraft(db, signupCode) : null;
  if (signupCode && !webDraft) {
    // Only say so when the message was nothing BUT a code. A stray eight
    // character word inside a sentence must not derail an ordinary chat.
    const bareCode = /^(?:sajili|signup|sign up|register)?\s*[A-Za-z0-9-]{8,12}$/i.test(String(text ?? '').trim());
    if (bareCode) return badCodeReply((state?.lang as Lang | null) ?? 'sw');
  }

  const fresh = !state || new Date(state.expires_at as string) < new Date();
  if (fresh && !webDraft) {
    const open = startOnboarding();
    const inviteCode = findInviteCode(text);
    const invitePreview = inviteCode ? await readInvitePreview(db, inviteCode) : null;
    await db.from('whatsapp_onboarding').upsert({
      phone_e164: phone,
      step: open.step,
      draft: inviteCode ? { code: inviteCode } : {},
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'phone_e164' });
    return invitePreview
      ? inviteLanguageQuestion(invitePreview.businessName, invitePreview.inviterName, invitePreview.role)
      : inviteCode
        ? 'Umealikwa kujiunga na biashara kwenye Risip.\n\n'
          + 'Chagua lugha / Choose a language:\n1. Kiswahili\n2. English'
      : open.reply;
  }

  const lang: Lang = webDraft ? draftLang(webDraft) : ((state?.lang as Lang | null) ?? 'en');
  // A photo mid-onboarding is not an answer to the question we asked.
  if (isImage && !webDraft) {
    return lang === 'sw'
      ? 'Nimeipokea picha, lakini tumalize kujiandikisha kwanza.'
      : 'I have your photo, but let us finish signing you up first.';
  }

  const next: OnboardingResult = webDraft
    ? { step: 'create_closing_time', reply: '', action: draftToCreateAction(webDraft), draft: {} }
    : advanceOnboarding(
        state!.step as OnboardingStep, text, lang,
        (state!.draft ?? {}) as Record<string, string>,
      );

  if (next.action.kind === 'set_language') {
    await db.from('whatsapp_onboarding').update({
      step: next.step, lang: next.action.lang, draft: next.draft,
      updated_at: new Date().toISOString(),
    }).eq('phone_e164', phone);
    return next.reply;
  }

  if (next.action.kind === 'create_business' || next.action.kind === 'join_business') {
    // The auth user has to exist before a profile can point at it, and only the
    // Admin API can make one. No password is set and none is ever sent: the way
    // in is the short-lived login link.
    //
    // Identified by a synthetic .invalid address, not by phone: GoTrue's phone
    // provider is off on this project and enabling it would mean paying Twilio
    // for SMS we never send. See _shared/waIdentityEmail.ts.
    const { data: created, error: userErr } = await db.auth.admin.createUser({
      email: waSyntheticEmail(phone),
      email_confirm: true,
      user_metadata: { source: 'whatsapp', phone },
    });
    if (userErr || !created?.user) {
      console.error('onboarding user create failed', userErr?.message);
      return lang === 'sw' ? 'Imeshindikana kwa sasa. Jaribu tena.' : 'That did not work just now. Please try again.';
    }

    const rpc = next.action.kind === 'create_business'
      ? db.rpc('wa_create_business', {
          p_user: created.user.id, p_phone: phone,
          p_full_name: next.action.fullName,
          p_company_name: next.action.businessName, p_location: next.action.location,
          p_category: next.action.category,
          p_subcategory: next.action.subCategory,
          p_confidence: next.action.confidence,
          p_keywords: next.action.detectedKeywords,
        })
      : db.rpc('wa_join_by_code', {
          p_user: created.user.id, p_phone: phone,
          p_code: next.action.code, p_full_name: next.action.fullName,
        });

    const { data: result, error: rpcErr } = await rpc;
    if (rpcErr) {
      await db.auth.admin.deleteUser(created.user.id).catch(() => {});
      return rpcErr.message;
    }

    // Their own sentence about the shop, kept as they wrote it. Onboarding no
    // longer asks anybody to agree with our label for their trade, so this is
    // the only description that exists — and it is what the assistant is told
    // when it needs to know what kind of shop it is talking to.
    const companyId = (result as { company_id?: string } | null)?.company_id;
    if (next.action.kind === 'create_business' && companyId && next.action.description) {
      await db.from('companies')
        .update({ business_description: next.action.description.slice(0, 300) })
        .eq('id', companyId);
    }
    if (next.action.kind === 'create_business') {
      const { error: hoursError } = await db.rpc('wa_set_business_hours', {
        p_phone: phone,
        p_opening_time: next.action.openingTime,
        p_closing_time: next.action.closingTime,
      });
      if (hoursError) {
        console.error('business hours save failed', hoursError.message);
      }
    }

    if (webDraft) {
      await db.from('web_signup_drafts')
        .update({ claimed_at: new Date().toISOString(), claimed_by_phone: phone })
        .eq('id', webDraft.id)
        .is('claimed_at', null);
      // The conversational state row is dead now; leaving it would answer the
      // next message with a question this person already answered on the web.
      await db.from('whatsapp_onboarding').delete().eq('phone_e164', phone);
    }

    const joined = next.action.kind === 'join_business';
    const name = (result as { company_name?: string } | null)?.company_name ?? '';
    const person = next.action.fullName;
    // THREE MESSAGES, NOT ONE WALL.
    //
    // MEASURED: businessWelcome is 899 characters over 30 lines and it landed
    // the second somebody finished signing up. Everything in it is true and
    // almost none of it was read.
    //
    // Now: what Risip does (no question), the worker offer (a question), and
    // the first products (an instruction). Kanuni 3 — a message that awaits an
    // answer ends with its question and nothing follows it, so the offer cannot
    // sit underneath five bullets where it reads as an afterthought.
    //
    // The onboarding row is gone by this point, so the offer is parked on the
    // ordinary conversation state like every other question.
    if (joined) {
      await sendReplyText(phone, invitedMemberReady(
        person,
        lang,
      ));
      return lang === 'sw'
        ? 'Tayari umejiunga. Anza kwa kutuma, kwa mfano: *nimeuza bidhaa 2*.'
        : 'You are all set. Start by sending, for example: *I sold 2 products*.';
    }
    await sendReplyText(phone, businessReady(person, name, lang));
    const { data: freshIdentity } = await db
      .from('whatsapp_identities')
      .select('id, company_id, profile_id')
      .eq('phone_e164', phone)
      .is('revoked_at', null)
      .maybeSingle();
    const fresh = freshIdentity as { id: string; company_id: string; profile_id: string } | null;
    if (fresh) {
      await db.from('whatsapp_conversations').upsert({
        identity_id: fresh.id,
        company_id: fresh.company_id,
        profile_id: fresh.profile_id,
        awaiting: 'product_cost',
        receipt_id: null,
        options: {
          kind: 'onboarding_worker_offer',
          category: next.action.category ?? null,
          subCategory: next.action.subCategory ?? null,
        },
        expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'identity_id' });
    }
    return workerOffer(lang);
  }

  await db.from('whatsapp_onboarding').update({
    step: next.step, draft: next.draft, updated_at: new Date().toISOString(),
  }).eq('phone_e164', phone);
  return next.reply;
}

/** A short-lived way in to the web. Never a password. */
async function handleLoginLink(db: Admin, phone: string, lang: Lang): Promise<{ reply: string; issued: boolean }> {
  const { data: token, error } = await db.rpc('wa_issue_login_token', { p_phone: phone });
  if (error || !token) {
    return {
      issued: false,
      reply: lang === 'sw'
        ? 'Sikuweza kutengeneza link ya kuingia sasa. Tafadhali jaribu tena baada ya muda mfupi.'
        : 'I could not create a login link right now. Please try again in a moment.',
    };
  }
  const url = `${appUrl()}/wa-login?t=${token}`;
  return {
    issued: true,
    reply: lang === 'sw'
      ? `Fungua link hii ndani ya dakika 5. Inatumika mara moja tu.\nUsimtumie mtu mwingine link hii.\n${url}`
      : `Open this link within 5 minutes. It works once only.\nDo not share this link with anyone.\n${url}`,
  };
}

/**
 * The same short-lived link, landing on the scanner instead of the dashboard.
 *
 * WhatsApp cannot open a camera, so registering by barcode has to hop to the
 * web — and asking somebody to log in first would lose most of them at the
 * password they do not have. One tap, already signed in, straight at the lens.
 */
async function handleScanLink(
  db: Admin,
  phone: string,
  lang: Lang,
  landing: '/scan' | '/sell' = '/scan',
): Promise<{ reply: string; issued: boolean }> {
  const { data: token, error } = await db.rpc('wa_issue_login_token', { p_phone: phone });
  if (error || !token) {
    return {
      issued: false,
      reply: lang === 'sw'
        ? 'Sikuweza kufungua scanner sasa. Jaribu tena baada ya muda mfupi.'
        : 'I could not open the scanner just now. Please try again in a moment.',
    };
  }
  const url = `${appUrl()}/wa-login?t=${token}&n=/scan`;
  return {
    issued: true,
    reply: lang === 'sw'
      ? '📷 Fungua link hii ili ku-scan bar code za bidhaa zako:\n'
        + `${url}\n\n`
        + 'Kamera itafunguka. Piga scan, andika jina na bei mara moja — '
        + 'baadaye ukiscan namba hiyo nitaijua.\n'
        + '_Link inatumika mara moja, ndani ya dakika 5._'
      : '📷 Open this link to scan your product barcodes:\n'
        + `${url}\n\n`
        + 'The camera opens. Scan, then give the name and prices once — '
        + 'after that the number is enough.\n'
        + '_The link works once, within 5 minutes._',
  };
}

/** Fire-and-forget: nudge the worker without blocking the 200 back to Meta. */
function nudgeWorker(): void {
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) return;
  void fetch(`${url}/functions/v1/whatsapp-worker`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sweep: true }),
  }).catch(() => undefined);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // ── Meta subscription challenge ──────────────────────────────────────────
  if (req.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge') ?? '';
    const expected = Deno.env.get('WHATSAPP_VERIFY_TOKEN') ?? '';
    if (mode === 'subscribe' && expected && token === expected) {
      return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
    }
    return new Response('forbidden', { status: 403 });
  }

  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });

  // ── Signature over the raw body ──────────────────────────────────────────
  const raw = await req.text();
  const appSecret = Deno.env.get('WHATSAPP_APP_SECRET') ?? '';
  const ok = await verifyMetaSignature(raw, req.headers.get('x-hub-signature-256'), appSecret);
  if (!ok) {
    console.error('rejected: bad signature');
    return new Response('invalid signature', { status: 401 });
  }

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return new Response('ok', { status: 200 }); }

  let db: Admin;
  try { db = admin(); } catch { return new Response('misconfigured', { status: 500 }); }

  // MEASURED, and it is why a shop sometimes gets nothing at all.
  //
  //   whatsapp_messages   pending | retries=0 | last_error NULL | audit rows 0
  //
  // Three of them: 3.8 hours old, 23.8 hours old, and 265 hours old. The loop
  // below is wrapped in a try/catch that records the reason and tells the shop,
  // so a THROW cannot produce this. What produces it is the worker ending
  // outside JavaScript's control — an eviction, a wall-clock limit, an isolate
  // torn down mid-await. No catch can run, so the row stays exactly as it was
  // inserted and the shopkeeper is simply never answered.
  //
  // A message may fail. It may not disappear. Anything still pending well past
  // the point where processing could plausibly still be running is marked, so
  // the row carries its own explanation instead of sitting silent for eleven
  // days waiting for somebody to notice.
  //
  // Deliberately NOT replying to these: an answer to an eleven-day-old question
  // is its own kind of confusing. The record is for whoever looks.
  try {
    // Read them BEFORE marking them, so the ones young enough to still matter
    // can be answered. MEASURED: ten of the first 711 messages died this way —
    // one in every seventy — and every one of those shopkeepers typed, waited,
    // and was never told anything at all. Silence is the worst failure mode
    // this system has, because the person cannot tell it from being ignored.
    const abandonedSince = new Date(Date.now() - 10 * 60_000).toISOString();
    const { data: abandoned } = await db.from('whatsapp_messages')
      .select('wa_message_id, phone_e164, created_at')
      .in('status', ['pending', 'processing'])
      .lt('created_at', abandonedSince)
      .order('created_at', { ascending: false })
      .limit(20);

    await db.from('whatsapp_messages')
      .update({
        status: 'failed',
        last_error: 'worker_ended_before_completion',
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .in('status', ['pending', 'processing'])
      .lt('created_at', abandonedSince);

    // Only the recent ones get an apology, and the original reasoning for that
    // still holds: an answer to an eleven-day-old question is its own kind of
    // confusing. Two hours is the line — long enough to cover a shopkeeper who
    // stepped away from the counter, short enough that they still remember
    // sending it. Older ones stay a record for whoever looks.
    //
    // Idempotent by construction: the rows are 'failed' by the time this runs,
    // so the next invocation cannot pick them up and apologise twice.
    const stillWorthAnswering = (abandoned ?? []).filter((row) => {
      const age = Date.now() - new Date(row.created_at as string).getTime();
      return age < 2 * 60 * 60_000;
    }).slice(0, 5);

    for (const row of stillWorthAnswering) {
      // Their own words, not ours: no stack trace, no HTTP code, no provider
      // name. What they need is to know it did not arrive and that sending it
      // again will work.
      await sendReplyText(
        String(row.phone_e164),
        'Samahani, ujumbe huu haukufika kwangu vizuri na sikuweza kuujibu. Tafadhali utume tena.',
        String(row.wa_message_id),
      );
    }
  } catch { /* the sweep must never stop the message in front of us */ }

  const entries = Array.isArray(payload?.entry) ? payload.entry : [];
  const incomingMessages: Array<{ message: any; waMessageId: string; phone: string; receivedAtMs: number }> = [];
  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value ?? {};
      // Delivery/read receipts carry `statuses`, not `messages` — ignore them.
      const messages = Array.isArray(value.messages) ? value.messages : [];

      for (const message of messages) {
        const waMessageId = String(message?.id ?? '');
        const phone = normalizeE164(message?.from);
        if (!waMessageId || !phone) continue;

        // Idempotency gate: Meta delivers at least once, so a repeat delivery
        // must collide here rather than create a second job. Unique index does
        // the work. This preflight intentionally registers every new message in
        // the webhook batch before any one of them starts the slow AI path.
        const { error: dupErr } = await db.from('whatsapp_messages').insert({
          wa_message_id: waMessageId,
          phone_e164: phone,
          kind: String(message?.type ?? 'unknown'),
          status: 'pending',
        });
        if (dupErr) {
          if (dupErr.code === '23505') continue; // already seen — nothing to do
          console.error('message insert failed', dupErr.message);
          continue;
        }
        // When Meta handed it to us. Every typing pulse is measured from here,
        // because "the indicator was requested" and "the indicator was
        // requested eleven seconds in" are different facts.
        incomingMessages.push({ message, waMessageId, phone, receivedAtMs: Date.now() });
      }
    }
  }

  // ── Answer Meta first, then do the work ──────────────────────────────────
  //
  // Processing takes 12 to 20 seconds and Meta's webhook call was being held
  // open for all of it, which is well past the point where Meta gives up and
  // redelivers. The idempotency gate above already made a redelivery harmless,
  // so nothing was ever double-answered — but it is pointless load and it is
  // not how a webhook is supposed to behave.
  //
  // NOT the cause of the typing problem, and the measurements say so plainly:
  // the second message's row is inserted 0.4 to 1.3 seconds after the first
  // one's while the first is still 12 seconds from finishing, so Meta is
  // plainly not waiting for our acknowledgement before delivering the next
  // message. That hypothesis is dead; this change is worth making on its own
  // merits and is not the fix.
  //
  // The fallback is the part that matters: if this runtime has no waitUntil,
  // the work is awaited exactly as before. A message may be slow. It may not
  // be dropped because a convenience was missing.
  const processAll = async () => {
  for (const { message, waMessageId, phone, receivedAtMs } of incomingMessages) {
        // MEASURED FAILURE, and the worst kind: total silence.
        //
        //   whatsapp_messages  15:25:32 | text | pending | retries=0 | (no error)
        //
        // Every other message that day reached 'skipped'. This one stayed
        // 'pending' for ever, with no last_error, no audit row and no reply —
        // because nothing wrapped the body of this loop. Anything that threw
        // escaped, the row was left as it was inserted, and the shopkeeper was
        // simply never answered.
        //
        // A message may fail. It may not disappear.

        // Meta may deliver two different messages in separate webhook
        // invocations at the same time. A per-phone database lease keeps the
        // older turn's conversation state and AI memory ahead of the newer one;
        // it does not serialize different businesses.
        const turnOwner = crypto.randomUUID();
        let stopTypingHeartbeat = () => {};
        let turnAcquired = false;
        // How long this message stood behind an earlier one from the same
        // phone. This is the whole difference between the message that shows
        // typing and the messages that do not.
        const waitStartedAt = Date.now();
        try {
          turnAcquired = await waitForWhatsAppTurn(db, phone, waMessageId, turnOwner);
        } catch {
          turnAcquired = false;
        }
        const queuedMs = Date.now() - waitStartedAt;
        const queuedBehind = queuedMs >= QUEUED_BEHIND_MS;
        const pulseTyping = typingRecorder(db, waMessageId, receivedAtMs, queuedBehind);
        if (!turnAcquired) {
          await db.from('whatsapp_messages').update({
            status: 'failed', last_error: 'whatsapp_turn_lock_timeout',
            processed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }).eq('wa_message_id', waMessageId);
          stopTypingHeartbeat();
          await sendReplyText(phone,
            'Samahani, ujumbe huu umechelewa kuchakatwa. Tafadhali utume tena baada ya muda mfupi.',
            waMessageId);
          continue;
        }
        let stopTurnHeartbeat = () => {};
        try {
          await markWhatsAppTurnProcessing(db, waMessageId);
          stopTurnHeartbeat = startWhatsAppTurnHeartbeat(db, phone, turnOwner);
          // A message that queued has just watched the previous reply go out.
          // Meta dismisses the indicator when a message is delivered, so the
          // instant the turn is released is the worst possible instant to ask
          // for one. Let that delivery land first, THEN ask.
          if (queuedBehind) await typingSettlePause();
          stopTypingHeartbeat = startWhatsAppTypingHeartbeat(() => pulseTyping());
          await typingVisibilityPause();
        } catch {
          await releaseWhatsAppTurn(db, phone, turnOwner);
          await db.from('whatsapp_messages').update({
            status: 'failed', last_error: 'whatsapp_turn_processing_claim_failed',
            processed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }).eq('wa_message_id', waMessageId);
          stopTypingHeartbeat();
          await sendReplyText(phone,
            'Samahani, ujumbe huu haukuweza kuanza kuchakatwa. Tafadhali utume tena.',
            waMessageId);
          continue;
        }

        // Everything after the idempotency gate runs inside this guard.
        try {

        // Give immediate feedback before onboarding, tools or the model do any
        // slower work. This runs only after signature verification and the
        // idempotency gate, so status webhooks and duplicate deliveries cannot
        // flash a misleading typing indicator.
        await pulseTyping();

        // Resolve identity once; used by both branches below.
        const { data: rawIdentity } = await db
          .from('whatsapp_identities')
          .select('id, revoked_at')
          .eq('phone_e164', phone)
          .is('revoked_at', null)
          .maybeSingle();

        let body: string | null = message?.text?.body ?? null;
        const identity = await resolveWhatsAppContext(db, rawIdentity as { id: string; revoked_at: string | null } | null);
        let lang: Lang = identity?.lang ?? detectLanguage(body) ?? 'en';
        const finish = async (status: string, error?: string) => {
          const messageStatus = status === 'failed'
            ? 'failed'
            : status === 'done'
              ? 'done'
              : 'skipped';
          const { error: finishError } = await db.from('whatsapp_messages')
            .update({
              status: messageStatus, ...(error ? { last_error: error } : {}),
              processed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            })
            .eq('wa_message_id', waMessageId);
          if (finishError) throw finishError;
        };

        // Everything audited from here on records what was asked, not only what
        // was done with it. Cleared per message so nothing leaks across.
        rememberForAudit(body);

        // ── AI owns ordinary language ──────────────────────────────────────
        // The complete message must reach Claude before any business parser
        // classifies it. This preserves mixed requests such as a sale plus a
        // profit question and lets the tool loop decide whether one or more
        // capabilities are needed. The backend still validates every tool
        // argument and performs writes only through protected RPCs.
        const mixed = null;
        let writeBody = body;
        // When a numeric product-choice answer resumes a parked sentence, keep
        // the replayed sentence as the evidence passed to business tools. The
        // visible body is also replaced below, but this explicit variable makes
        // it impossible for the tool loop to fall back to the bare answer (for
        // example "2") and ask for MAUZO/ONGEZA/SAJILI again.
        let assistantEvidenceBody = body;
        let visibleTurnRemembered = false;
        /**
         * Send, and remember that it was said.
         *
         * MEASURED FAILURE: the owner asked which two products were uncounted,
         * then "ni zipi hizo?", and Risip had no idea what "hizo" meant. Only
         * turns the MODEL answered were ever written down — the deterministic
         * read tools, which answer most questions, left no trace at all. So the
         * next message arrived with an empty history and a pronoun in it.
         *
         * Every reply now goes through here, whichever parser produced it, and
         * the pair is stored. One store per inbound message: the flag stops a
         * branch that sends two messages from writing the exchange twice.
         */
        const replyQuietly = async (to: string, text: string, remember = true) => {
          await sendReplyText(to, text, waMessageId);
          if (remember && identity && body?.trim() && !visibleTurnRemembered && !isLinkMessage(body)) {
            visibleTurnRemembered = await storeAssistantExchange(
              db, identity, waMessageId, body, text,
              { topic: null, entities: {}, lastTool: null },
            );
          }
        };

        const reply = async (to: string, text: string) => replyQuietly(to, text);

        if (rawIdentity && !identity) {
          await replyQuietly(phone, lang === 'sw'
            ? 'Akaunti hii imeunganishwa, lakini haina biashara hai yenye membership halali. Fungua Risip uchague biashara, kisha jaribu tena.'
            : 'This account is linked, but it has no valid active business membership. Open Risip, choose a business, then try again.');
          await finish('skipped', 'invalid_active_company');
          continue;
        }

        if (identity) {
          await db.from('whatsapp_messages').update({
            profile_id: identity.profile_id,
            company_id: identity.company_id,
            updated_at: new Date().toISOString(),
          }).eq('wa_message_id', waMessageId);
        }

        // This is the ONLY natural-language dispatch. It is invoked before
        // any legacy text handler, and again only for a protected choice that
        // reconstructed an earlier sentence. Its failures are terminal too.
        const handleAiText = async (
          convo: Awaited<ReturnType<typeof loadConversation>>,
          body: string | null,
          systemCommand: boolean,
          identity: ResolvedWhatsAppIdentity,
          evidenceText: string | null = body,
        ): Promise<boolean> => {
        let conversationalAiBudgetBlock: AiBudgetDecision | null = null;
        let assistantCameBackEmpty = false;
        let aiFailureClass: AssistantFailureClass | null = null;
        const aiEligible = messageGoesToModel(convo, body, systemCommand);
        // Watched in production: ai_primary is what an ordinary business
        // message must be. If parsers ever start eating them again, this is
        // where it shows first.
        let messageRoute: MessageRoute = aiEligible ? 'ai_primary' : 'pending_protocol';
        if (aiEligible) {
          if ((body?.trim().length ?? 0) > MAX_ASSISTANT_USER_CHARS) {
            await replyQuietly(phone, lang === 'sw'
              ? 'Ujumbe huu ni mrefu sana kuuchakata wote kwa usalama. Ugawanye katika ujumbe mfupi. Sijarekodi chochote kutoka kwenye ujumbe huu.'
              : 'This message is too long to process safely in full. Split it into shorter messages. I have not recorded anything from this message.', false);
            await audit(db, identity, waMessageId, 'conversational_ai', 'input_too_long', 'rejected');
            await finish('skipped');
            return true;
          }
          const history = await loadAssistantHistory(db, identity);
          const contextChars = body!.length + history.reduce((sum, message) => sum + message.content.length, 0);
          const budget = await consumeAiBudget(db, identity, contextChars);
          if (budget.allowed) {
            let assistantFailure = 'unknown_failure';
            const retrieval = await loadVocabularyContext(db, identity);
            console.info('risip_ai_retrieval', JSON.stringify({ waMessageId, health: retrieval.health, promptVersion: PROMPT_VERSION }));
            // STAGE A: how long the model and its tool loop actually took.
            // Measured here rather than around the whole message so latency is
            // attributable to the interpreter, not to the ledger writes after it.
            const aiStartedAt = Date.now();
            // The model and its tool loop are the slowest thing here, and the
            // indicator raised at the top of the request has long expired by the
            // time it answers. Raised again so the wait is visible.
            await pulseTyping();
            const assistant = await runConversationalAssistant({
              context: { ...assistantIdentityContext(
                identity,
                retrieval.vocabulary,
                pendingClarificationOf(convo),
                retrieval.catalogue,
              ), pendingClarification: [describePending(pendingClarificationOf(convo)), pendingConversationContext(convo)].filter(Boolean).join('\n\n') },
              history,
              userText: body!,
              executeTool: (name, input) => catalogueProposalBlocked(name, retrieval.health)
                ? Promise.resolve({ content: 'catalogue_retrieval_unavailable: the catalogue could not be verified. No proposal was executed. Explain the temporary lookup problem; do not say the product is missing and do not substitute a money-event tool.', isError: true, errorCode: 'retrieval_catalogue_unavailable' })
                : executeAssistantTool(db, identity, waMessageId, lang, name, input, evidenceText ?? body!),
              onFailure: (code) => {
                assistantFailure = code;
                console.info('risip_ai_failure', JSON.stringify({ waMessageId, layer: aiFailureLayer(code), promptVersion: PROMPT_VERSION, schemaVersion: TOOL_SCHEMA_VERSION }));
              },
            });
            // A record-looking sentence may never be acknowledged as saved by
            // prose alone. Unsafe replies stop here; they never enter legacy
            // language handlers. This guard is not an alternative intent router.
            // The model's own words are passed in now: a CLAIM of saving is
            // still refused, but a clarifying QUESTION gets through. Deferring
            // both is what put "Sijaelewa vizuri" in front of somebody who had
            // just rephrased their message for us.
            const unsafeRecordProse = assistant
              && shouldDeferRecordLikeReply(
                isDailyRecordCandidate(body), assistant.toolNames, assistant.reply,
              );
            // An unusable model response is an explicit failed AI turn, not a
            // reason to silently hand the sentence to a deterministic parser.
            // ── STAGE A telemetry ────────────────────────────────────────────
            //
            // What the assistant DID, never what the trader wrote. Codes only:
            // no message text, no product wording, no names, no prices. It is
            // written after the reply has gone out, and it cannot fail loudly —
            // a telemetry row must never cost a shop its answer.
            const aiLatencyMs = Date.now() - aiStartedAt;
            const retrievalStatus = overallRetrievalStatus(retrieval.health);
            const conversationState = convo?.awaiting
              ? 'active_question'
              : history.length > 0 ? 'history' : 'none';
            const recordInterpretation = async (
              outcome: BackendOutcome, reason: FallbackReason | null,
            ) => {
              try {
                const row = buildInterpretation({
                  waMessageId,
                  toolNames: assistant ? assistant.toolNames : null,
                  lastToolInput: assistant ? assistant.lastToolInput ?? null : null,
                  latencyMs: aiLatencyMs,
                  backendOutcome: outcome,
                  fallbackReason: reason,
                  // WHICH grounding guard refused the answer, and what it saw.
                  // providerFailure is null on this path — the model DID reply
                  // and we declined it — so without this the one detail that
                  // separates an over-strict guard from a model inventing a
                  // total never reaches the table, and refusals say only
                  // "deferred for safety". All three guards are kept now: only
                  // the ungrounded-figure one was, and the other two were the
                  // majority of the refusals actually seen.
                  rejectionCode: guardRefusalCode(assistantFailure),
                  providerFailure: assistant ? null : assistantFailure,
                });
                const diagnosticCode = assistant?.toolFailureCode
                  ?? ((assistant?.unavailable || !assistant) ? assistantFailure : null);
                await db.rpc('wa_record_ai_interpretation', {
                  p_company_id: identity.company_id,
                  p_wa_message_id: row.waMessageId,
                  p_model: assistant ? assistant.model : null,
                  p_prompt_version: PROMPT_VERSION,
                  p_tool_schema_version: TOOL_SCHEMA_VERSION,
                  p_chosen_tool: row.chosenTool,
                  p_semantic_intent: row.semanticIntent,
                  p_tool_rounds: row.toolRounds,
                  p_latency_ms: row.latencyMs,
                  p_backend_outcome: row.backendOutcome,
                  p_rejection_code: row.rejectionCode,
                  p_clarification_field: row.clarificationField,
                  p_fallback_used: row.fallbackUsed,
                  p_fallback_reason: row.fallbackReason,
                  p_provider_failure_code: row.providerFailureCode,
                  p_route: messageRoute,
                  // Proof, rather than belief, that the cached prefix is being
                  // reused. Reads with no writes is a warm cache; writes with
                  // no reads means something upstream changed between calls and
                  // the cache was paid for and thrown away.
                  p_cache_read_tokens: assistant?.cache?.read ?? null,
                  p_cache_write_tokens: assistant?.cache?.written ?? null,
                  p_failure_layer: diagnosticCode ? aiFailureLayer(diagnosticCode) : 'none',
                  p_retrieval_status: retrievalStatus,
                  p_conversation_state: conversationState,
                  p_tool_result_status: assistant?.toolResultStatus ?? 'none',
                  p_tool_failure_code: assistant?.toolFailureCode ?? null,
                  p_runtime_version: AI_RUNTIME_VERSION,
                });
              } catch { /* telemetry is never allowed to break a message */ }
            };

            if (assistant && assistant.unavailable) {
              assistantCameBackEmpty = true;
              aiFailureClass = classifyAssistantFailure(assistantFailure);
              messageRoute = 'ai_outage_fallback';
              // MEASURED: an adviser answer refused for quoting a figure no
              // tool returned was logged as 'model_empty' — a different fault
              // with a different fix. The class decides the row now, so a guard
              // that is too strict cannot hide as a quiet model.
              await recordInterpretation('fallback',
                aiFailureClass === 'model_invalid_tool'
                  ? 'model_reply_deferred_for_safety'
                  : 'model_empty');
              await audit(db, identity, waMessageId, 'conversational_ai', 'empty', 'fallback');
            } else if (assistant && !unsafeRecordProse) {
              await replyQuietly(phone, assistant.reply, !assistant.sensitiveReply);
              const remembered = assistant.sensitiveReply ? true : await storeAssistantExchange(
                db, identity, waMessageId, body!, assistant.reply, assistant.memory,
              );
              await audit(
                db,
                identity,
                waMessageId,
                'conversational_ai',
                assistant.toolNames.join(',') || 'answer',
                remembered ? (assistant.usedSafeFallback ? 'safe_fallback' : 'applied') : 'memory_failed',
              );
              // A proposing tool leaves a pending draft; everything else answered
              // a question. The difference is the whole point of measuring outcome
              // separately from tool choice.
              await recordInterpretation(
                assistant.toolNames.some((tool) => tool.startsWith('propose_')) ? 'drafted' : 'answered',
                'model_success',
              );
              await finish('skipped');
              return true;
            }
            if (!assistant) {
              aiFailureClass = classifyAssistantFailure(assistantFailure);
              messageRoute = 'ai_outage_fallback';
              await recordInterpretation('provider_failed',
                /timeout/i.test(assistantFailure) ? 'provider_timeout'
                  : /schema|tools./i.test(assistantFailure) ? 'invalid_tool_schema'
                  : 'provider_error');
              await audit(db, identity, waMessageId, 'conversational_ai', 'provider', assistantFailure);
            }
          } else {
            messageRoute = 'ai_outage_fallback';
            conversationalAiBudgetBlock = budget;
            // The cap is a business decision, not a model failure. Recorded
            // separately so a quiet month of budget blocks can never be read as
            // the assistant getting worse.
            try {
              await db.rpc('wa_record_ai_interpretation', {
                p_company_id: identity.company_id,
                p_wa_message_id: waMessageId,
                p_model: null,
                p_prompt_version: PROMPT_VERSION,
                p_tool_schema_version: TOOL_SCHEMA_VERSION,
                p_chosen_tool: null,
                p_semantic_intent: 'unknown',
                p_tool_rounds: null,
                p_latency_ms: null,
                p_backend_outcome: 'budget_blocked',
                p_rejection_code: budget.reason ?? null,
                p_clarification_field: null,
                p_fallback_used: true,
                p_fallback_reason: 'budget_block',
                p_provider_failure_code: null,
                p_failure_layer: 'budget',
                p_retrieval_status: 'not_run',
                p_conversation_state: convo?.awaiting ? 'active_question' : 'none',
                p_tool_result_status: 'none',
                p_tool_failure_code: null,
                p_runtime_version: AI_RUNTIME_VERSION,
              });
            } catch { /* telemetry is never allowed to break a message */ }
            await audit(db, identity, waMessageId, 'conversational_ai', 'budget', 'fallback');
          }
        }

        // THE MODEL WAS TRIED AND COULD NOT FINISH. STOP HERE.
        //
        // MEASURED, from the owner's own screen at 20:48. He asked "Naomba
        // ushauri wa biashara yangu"; telemetry recorded route=ai_outage_fallback,
        // fallback_reason=model_empty, chosen_tool=get_business_advice, one tool
        // round, 10.7 seconds. The model called the adviser, received the
        // figures, and then produced no text. Execution fell through to the
        // branches below, parseAdvisorRequest matched, and the deterministic MD
        // brief went out under the assistant's name — headings, emoji and all.
        //
        // Removing humanFallback() from inside the assistant was not enough,
        // and claiming otherwise was wrong. The loop itself was the bigger
        // fallback: forty-odd deterministic handlers, any of which will happily
        // answer a message the model has just failed on. The old comment beside
        // this said "let the deterministic branches below have their turn — one
        // of them almost always knows", which is exactly the behaviour the
        // owner rejected. One of them knowing is not the same as Risip having
        // thought about the question, and a shopkeeper cannot tell them apart.
        //
        // The same fall-through is why "Compare today's price and yesterday"
        // came back as a SALES trend: parseSalesTrendRequest matched the word
        // "compare" and answered a different question confidently.
        //
        // System commands and protocol answers never set aiEligible, so they
        // still reach their own handlers untouched.
        if (aiEligible && (conversationalAiBudgetBlock || assistantCameBackEmpty || aiFailureClass !== null)) {
          const failureReply = conversationalAiBudgetBlock
            ? aiBudgetMessage(lang, conversationalAiBudgetBlock.resetAt, conversationalAiBudgetBlock.reason)
            : assistantClarificationQuestion(lang, body, pendingClarificationOf(convo));
          // A provider failure is telemetry, not a business answer. Do not put
          // the apology/error into conversation history as if it were context.
          await replyQuietly(phone, failureReply, false);
          await audit(
            db, identity, waMessageId, 'conversational_ai',
            conversationalAiBudgetBlock ? 'budget_block' : (aiFailureClass ?? 'model_empty'),
            'failed',
          );
          await finish('skipped');
          return true;
        }

        // AI is the sole owner of ordinary business language. Do not allow a
        // deterministic business parser to answer after the model returned a
        // safety-deferred reply (for example, a record-shaped sentence with
        // no proposal tool call). Falling through here used to produce the
        // MAUZO / ONGEZA / SAJILI menu and made free text appear parser-owned.
        // Protocol answers and system commands are excluded by aiEligible and
        // continue through their bounded handlers below.
        if (aiEligible) {
          await replyQuietly(phone, assistantClarificationQuestion(
            lang, body, pendingClarificationOf(convo),
          ), false);
          await audit(db, identity, waMessageId, 'conversational_ai', 'no_usable_response', 'failed');
          await finish('skipped');
          return true;
        }
        return false;
        };

        if (identity && message?.type === 'text' && !isLinkMessage(body)) {
          const activeQuestion = await loadConversation(db, identity.id);
          const selectedBand = protectedPriceBandAnswer(activeQuestion, body);
          const selectedProduct = protectedSaleProductAnswer(activeQuestion, body);
          if (selectedBand || selectedProduct) {
            const result = await executeClarification(db, identity, waMessageId, lang, {
              answers: [{ field: selectedProduct ? 'product' : 'price_band', canonical_value: selectedProduct ?? selectedBand, numeric_value: null, raw_wording: body }],
            }, body ?? undefined);
            await replyQuietly(phone, result.terminalReply ?? result.fallbackReply ?? (lang === 'sw'
              ? 'Sikuweza kuandaa uthibitisho wa bei hiyo. Hakuna mauzo yaliyothibitishwa; jaribu tena.'
              : 'I could not prepare that price confirmation. No sale was confirmed; please retry.'));
            await audit(db, identity, waMessageId, selectedProduct ? 'product_choice' : 'price_band', 'protected_option', result.isError ? 'failed' : 'pending');
            await finish('skipped');
            continue;
          }
          if (await handleAiText(activeQuestion, body, isProtectedSystemCommand(body), identity)) continue;
        }

        // Login is a protected control-plane command. Resolve it before any
        // conversational/record parser so natural requests such as “nipe link
        // ya login nichek dashboard” cannot be answered (or refused) by AI.
        // Selling by scanning, before registering by scanning: "uza kwa scan"
        // holds both words and the till is the one with a customer waiting.
        // Every role may sell; a worker's sale waits for confirmation exactly
        // as it does here.
        if (identity && isSellScanRequest(body)) {
          const till = await handleScanLink(db, phone, lang, '/sell');
          await replyQuietly(phone, till.reply);
          await audit(db, identity, waMessageId, 'sell_scan_link', 'issued', till.issued ? 'applied' : 'failed');
          await finish('skipped');
          continue;
        }

        // Scanning is checked before login, because "scan" is itself a way of
        // asking for the web app and the login patterns already claim the word.
        if (identity && isScanRequest(body)) {
          if (!canUseCompanyFinanceReads(identity.role)) {
            await replyQuietly(phone, lang === 'sw'
              ? 'Ni owner au accountant pekee anayeweza kusajili bidhaa.'
              : 'Only an owner or accountant can register products.');
            await audit(db, identity, waMessageId, 'scan_link', 'blocked', 'blocked');
            await finish('skipped');
            continue;
          }
          const scan = await handleScanLink(db, phone, lang);
          await replyQuietly(phone, scan.reply);
          await audit(db, identity, waMessageId, 'scan_link', 'issued', scan.issued ? 'applied' : 'failed');
          await finish('skipped');
          continue;
        }

        // A message that is nothing but a barcode is a question about a packet
        // somebody is holding. Answered from the shop's own table, never the
        // model: the number either is in the catalogue or it is not.
        if (identity && parseBarcodeMessage(body)) {
          const scanned = parseBarcodeMessage(body)!;
          const { data: rows } = await db.rpc('wa_find_product_barcode', {
            p_company_id: identity.company_id,
            p_barcode: scanned.code,
          });
          const hit = (rows as { product_name: string }[] | null)?.[0] ?? null;
          await replyQuietly(phone, hit
            ? (lang === 'sw'
              ? `📦 ${formatBarcode(scanned.code)} ni *${hit.product_name}*.\n\n`
                + `Kuandika mauzo: "nimeuza ${hit.product_name} 2".`
              : `📦 ${formatBarcode(scanned.code)} is *${hit.product_name}*.\n\n`
                + `To record a sale: "nimeuza ${hit.product_name} 2".`)
            : (lang === 'sw'
              ? `❓ Sina bidhaa yenye bar code ${formatBarcode(scanned.code)}.\n\n`
                + 'Tuma *scan* ili kuisajili kwa kamera, au niambie jina na bei zake hapa.'
              : `❓ No product carries the barcode ${formatBarcode(scanned.code)}.\n\n`
                + 'Send *scan* to register it with the camera, or give me its name and prices here.'));
          await audit(db, identity, waMessageId, 'barcode_lookup', hit ? 'found' : 'unknown', 'applied');
          await finish('skipped');
          continue;
        }

        if (identity && isLoginRequest(body)) {
          const login = await handleLoginLink(db, phone, lang);
          await replyQuietly(phone, login.reply);
          await audit(db, identity, waMessageId, 'login_link', 'issued', login.issued ? 'applied' : 'failed');
          await finish('skipped');
          continue;
        }

        // ── Receipt image (with its optional caption) ─────────────────────
        if (message?.type === 'image' && message?.image?.id) {
          if (!identity) {
            // Onboard, never extract. media_id stays null, so whatsapp-worker
            // never sees this and no AI is called for a stranger.
            await replyQuietly(phone, await handleOnboarding(db, phone, null, true));
            await finish('skipped', 'onboarding');
            continue;
          }
          const setupReply = await parkProjectSetup(
            db,
            identity,
            waMessageId,
            String(message.image.id),
            message.image.mime_type ? String(message.image.mime_type) : null,
            message.image.caption ? String(message.image.caption).slice(0, 500) : null,
            lang,
          );
          if (setupReply) {
            await replyQuietly(phone, setupReply);
            await finish('skipped', 'project_setup');
            continue;
          }
          await db.from('whatsapp_messages').update({
            profile_id: identity.profile_id,
            company_id: identity.company_id,
            media_id: String(message.image.id),
            media_mime: message.image.mime_type ? String(message.image.mime_type) : null,
            // Untrusted text. Only ever matched against the sender's own projects.
            caption: message.image.caption ? String(message.image.caption).slice(0, 500) : null,
            // The receipt worker claims pending media jobs. Text turns use the
            // per-phone lease above, so this image must not remain processing.
            status: 'pending',
            updated_at: new Date().toISOString(),
          }).eq('wa_message_id', waMessageId);
          continue; // worker takes it from here
        }

        if (message?.type !== 'text') {
          if (!identity) {
            await replyQuietly(phone, await handleOnboarding(db, phone, null, true));
            await finish('skipped', 'onboarding');
            continue;
          }
          await replyQuietly(phone, t('photoOnly', lang));
          await finish('skipped', 'unsupported_message_type');
          continue;
        }

        // ── Text: deterministic routing, no model involved ────────────────
        const linkToken = parseLinkToken(body);
        let convo = identity ? await loadConversation(db, identity.id as string) : null;
        const routeFor = (text: string | null) => routeIntent({
          messageType: 'text',
          text,
          hasLinkToken: Boolean(linkToken),
          awaitingClarification: Boolean(convo),
        });
        let intent = routeFor(body);

        // The system commands that must never cost a model call. Computed here,
        // above every branch, so nothing below can quietly consume a message the
        // model was going to read — which is exactly what the payment-method
        // phrase list was doing eight hundred lines further down.
        // "tumia kiswahili na uniambie siku gani biashara ilifanya vizuri" is
        // TWO things: an instruction and a question. It used to be filed as a
        // pure system command, so the language changed, the AI never saw the
        // message, and the owner was told "I did not fully understand that
        // business question" — in the language he had just asked it to leave.
        //
        // Obey the instruction, then carry the rest of the sentence forward as
        // the real message. A language command with nothing after it behaves
        // exactly as it always did.
        const alsoAsked = identity ? languageCommandRemainder(body) : null;
        if (alsoAsked) {
          const next = parseLanguageCommand(body)!;
          await db.rpc('wa_set_language', { p_phone: phone, p_lang: next });
          await audit(db, identity, waMessageId, 'change_language', next, 'applied');
          lang = next;
          body = alsoAsked;
          // And the intent with it. It was read from the ORIGINAL sentence, so
          // it still says change_language — which is exactly what put the whole
          // message into systemCommand and kept the AI away from the question.
          // Rewriting the body without rewriting this fixes half the bug and
          // leaves the visible half intact.
          intent = routeFor(body);
        }

        // A YES is only protocol when something is waiting for it.
        //
        // MEASURED, from the owner's own thread. He asked for a graph, Risip
        // said graphs live in the app and offered a summary in words instead,
        // and he answered "ndiyo". Nothing was parked — the offer was made by
        // the MODEL, in prose, not by a pending state — so this line read a
        // bare confirmation, filed the whole message as a system command, and
        // the model never saw it. He got the generic help menu, and the thread
        // he had been holding for two turns was gone.
        //
        // "Ndiyo" with a draft waiting is a protocol word and must never reach
        // the model; the same word with nothing waiting is ordinary
        // conversation, and the model is the only thing here that knows what
        // it is agreeing to.
        const awaitingAnswer = Boolean(convo?.awaiting);
        const systemCommand = isSwitchRequest(body)
          || isLoginRequest(body)
          // Invite creation is supported directly on WhatsApp. Keep it out of
          // the conversational model so it cannot replace the real flow with
          // the old app-only refusal.
          || parseInviteRequest(body)
          || Boolean(parseLanguageCommand(body))
          || intent === 'cancel_action'
          || intent === 'change_language'
          || (awaitingAnswer && isDailyRecordConfirmation(body ?? ''))
          || (awaitingAnswer && isDailyRecordRejection(body ?? ''));

        if (intent === 'link_account') {
          const reply = await handleLink(db, phone, String(message?.from ?? ''), linkToken!);
          await replyQuietly(phone, reply);
          await finish('skipped');
          continue;
        }

        // A code pasted on its own, by somebody with nothing linked yet. Only
        // here: for a linked shop a long alphanumeric string is far more likely
        // to be a product code, and reading it as a token would be guessing at
        // their stock.
        if (!identity) {
          const bare = parseBareLinkToken(body);
          if (bare) {
            await replyQuietly(phone, await handleLink(db, phone, String(message?.from ?? ''), bare));
            await finish('skipped');
            continue;
          }
        }

        if (!identity) {
          await replyQuietly(phone, isAccountDeletionRequest(body)
            ? (lang === 'sw'
              ? 'Futa akaunti inahitaji namba iliyounganishwa na Risip na identity iliyothibitishwa. Hakuna kilichofutwa.'
              : 'Account deletion requires a verified Risip-linked number. Nothing was deleted.')
            : await handleOnboarding(db, phone, body, false));
          await finish('skipped', 'onboarding');
          continue;
        }

        // STOP/SITISHA applies only to proactive summaries and debt reminders.
        // It must run before the generic cancel router, which also recognises
        // "sitisha", and it must not revoke the identity or block normal chats.
        if (isProactiveNotificationStop(body) && !(convo && isPendingEscape(body))) {
          const { error } = await db.rpc('wa_stop_proactive_notifications', { p_phone: phone });
          await replyQuietly(phone, error
            ? (lang === 'sw' ? 'Sikuweza kuzima taarifa sasa. Jaribu tena.' : 'I could not turn off notifications right now. Try again.')
            : notificationStoppedReply(lang));
          await audit(db, identity, waMessageId, 'notification_preferences', 'stop_all', error ? 'failed' : 'applied');
          await finish('skipped', error ? 'notification_stop_failed' : undefined);
          continue;
        }

        // MSAADA MENU — answered.
        //
        // Checked before the ordinary parsers, because a bare "1" is exactly
        // the kind of token anything else would happily read as a quantity.
        // Only ever reached while this precise menu is parked.
        const helpMenuPending = convo?.awaiting === 'product_cost'
          && (convo.options as { kind?: string } | null)?.kind === 'help_menu';
        if (helpMenuPending) {
          const said = String(body ?? '').trim();
          if (/^1$/.test(said)) {
            await clearConversation(db, identity.id as string);
            await reply(phone, firstProductsPrompt(null, null, lang));
            await audit(db, identity, waMessageId, 'help', 'register_products', 'applied');
            await finish('answered');
            continue;
          }
          if (/^2$/.test(said)) {
            await clearConversation(db, identity.id as string);
            // Falls through to the ordinary invite path below by pretending the
            // word was typed, so there is one implementation of an invite and
            // not two that drift apart.
            writeBody = 'mualike';
            body = 'mualike';
          } else if (/^3$/.test(said)) {
            // "Just tell me" is not a fallback. It is the main road, and the
            // only thing to do is get out of the way.
            await clearConversation(db, identity.id as string);
            await reply(phone, lang === 'sw'
              ? 'Sawa — niambie unachotaka kwa maneno yako.'
              : 'Fine — tell me what you need, in your own words.');
            await audit(db, identity, waMessageId, 'help', 'open', 'applied');
            await finish('answered');
            continue;
          } else {
            // Anything else is not an answer to this menu. Release it and read
            // the message as what it is.
            await clearConversation(db, identity.id as string);
          }
        }

        if (isHelp(body)) {
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: { kind: 'help_menu' },
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          // The knowledge search is appended only when they actually asked
          // something. On a bare "msaada" it adds a paragraph nobody wanted to
          // a message whose whole point is being short.
          const asked = String(body ?? '').trim().split(/\s+/).length > 1;
          const extra = asked ? `\n\n${buildKnowledgeReply(body, lang)}` : '';
          await replyQuietly(phone, `${t('help', lang)}${extra}`);
          await audit(db, identity, waMessageId, 'help', 'menu', 'applied');
          await finish('skipped');
          continue;
        }

        // Daily-record draft confirmation uses the existing payment_source
        // conversation slot. Receipt/project state stays mutually exclusive.
        let dailyConversation = convo?.awaiting === 'payment_source'
          && (convo.options as Partial<DailyRecordConversation> | null)?.kind === 'daily_record_confirmation'
          ? convo.options as DailyRecordConversation
          : null;
        const breakdownConfirmation = convo?.awaiting === 'payment_source'
          && (convo.options as Partial<WholeAnimalBreakdownConfirmationState> | null)?.kind === 'whole_animal_breakdown_confirmation'
          ? convo.options as WholeAnimalBreakdownConfirmationState
          : null;
        const breakdownSourcePending = convo?.awaiting === 'payment_source'
          && (convo.options as Partial<WholeAnimalBreakdownSourceSelection> | null)?.kind === 'whole_animal_breakdown_source_selection'
          ? convo.options as WholeAnimalBreakdownSourceSelection
          : null;
        const dailyClarification = convo?.awaiting === 'payment_source'
          && (convo.options as Partial<DailyRecordClarification> | null)?.kind === 'daily_record_clarification'
          ? convo.options as DailyRecordClarification
          : null;
        let dailyBatchConversation = convo?.awaiting === 'payment_source'
          && (convo.options as Partial<DailyRecordBatchConversation> | null)?.kind === 'daily_record_batch_confirmation'
          ? convo.options as DailyRecordBatchConversation
          : null;
        const dailyBatchClarification = convo?.awaiting === 'payment_source'
          && (convo.options as Partial<DailyRecordBatchClarification> | null)?.kind === 'daily_record_batch_clarification'
          ? convo.options as DailyRecordBatchClarification
          : null;
        // A buying price awaiting NDIYO. Its own slot, so it can never be
        // confused with a daily-record draft sitting in payment_source.
        // Two different things live in the product_cost slot, so both are tagged.
        // A question Risip asked ("unainunua kwa shingapi?") is answered with a
        // bare price; a claim the person volunteered still needs NDIYO.
        const costPrompt = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<CostPrompt> | null)?.kind === 'cost_prompt'
          ? convo.options as CostPrompt
          : null;
        const stockPurchaseCostPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<StockPurchaseCostPending> | null)?.kind === 'stock_purchase_cost_choice'
          ? convo.options as StockPurchaseCostPending
          : null;
        const stockPurchaseCostAmountPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<StockPurchaseCostPending> | null)?.kind === 'stock_purchase_cost_amount'
          ? convo.options as StockPurchaseCostPending
          : null;
        const stockBatchPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<StockCountBatch> | null)?.kind === 'stock_count_batch'
          ? convo.options as StockCountBatch
          : null;
        const costBatchPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<ProductCostBatch> | null)?.kind === 'product_cost_batch'
          ? convo.options as ProductCostBatch
          : null;
        const sellingBatchPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<SellingPriceBatch> | null)?.kind === 'selling_price_batch'
          ? convo.options as SellingPriceBatch
          : null;
        const priceAndCostPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<PriceAndCostPending> | null)?.kind === 'price_and_cost_pending'
          ? convo.options as PriceAndCostPending
          : null;
        const queuePending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<RecordQueuePending> | null)?.kind === 'record_queue'
          ? convo.options as RecordQueuePending
          : null;
        const voidPending = convo?.awaiting === 'product_cost'
          && (convo.options as { kind?: string } | null)?.kind === 'void_record'
          ? convo.options as VoidPending
          : null;
        const invitePending = convo?.awaiting === 'product_cost'
          && (convo.options as { kind?: string } | null)?.kind === 'invite_role'
          ? true
          : false;
        const newProductPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<NewProductPricingState> | null)?.kind === 'new_product_pricing'
          ? convo.options as NewProductPricingState
          : null;
        const newProductQuantityPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<NewProductQuantityState> | null)?.kind === 'new_product_quantity'
          ? convo.options as NewProductQuantityState
          : null;
        const newProductRegistrationPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<NewProductRegistrationConfirmationState> | null)?.kind === 'new_product_registration_confirmation'
          ? convo.options as NewProductRegistrationConfirmationState
          : null;
        const newProductSaleSetup = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<NewProductSaleSetup> | null)?.kind === 'new_product_sale_setup'
          ? convo.options as NewProductSaleSetup
          : null;
        const newProductOfferSetup = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<NewProductOfferSetup> | null)?.kind === 'new_product_offer_setup'
          ? convo.options as NewProductOfferSetup
          : null;
        const portionSizePending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<PortionSetupDraft> | null)?.kind === 'portion_setup_sizes'
          ? convo.options as PortionSetupDraft
          : null;
        const portionConfirmPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<PortionSetupReady> | null)?.kind === 'portion_setup_confirmation'
          ? convo.options as PortionSetupReady
          : null;
        const quantityMeaningPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<ParkedQuantityMeaning> | null)?.kind === 'quantity_meaning_clarification'
          ? convo.options as ParkedQuantityMeaning
          : null;
        const portionQuantityPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<PortionQuantityPrompt> | null)?.kind === 'portion_quantity_prompt'
          ? convo.options as PortionQuantityPrompt
          : null;
        const productRenamePending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<ProductRenamePreview> | null)?.kind === 'product_rename_confirmation'
          ? convo.options as ProductRenamePreview
          : null;
        const addProductSetupPending = convo?.awaiting === 'product_cost'
          && (convo.options as { kind?: string; step?: string; product?: string } | null)?.kind === 'add_product_setup'
          ? convo.options as { kind: 'add_product_setup'; step: 'name' | 'cost'; product?: string }
          : null;
        const comboPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<ComboPending> | null)?.kind === 'combo_clarification'
          ? convo.options as ComboPending
          : null;
        const comboVariantPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<ComboVariantPending> | null)?.kind === 'combo_variant'
          ? convo.options as ComboVariantPending
          : null;
        const comboSavePending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<ComboSavePending> | null)?.kind === 'combo_save'
          ? convo.options as ComboSavePending
          : null;
        // Vocabulary is a permanent setting, so it waits for an explicit yes
        // exactly as a price does. A word remapped by accident would misread
        // every future message that contains it.
        const vocabularyPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<VocabularyPending> | null)?.kind === 'vocabulary_teaching'
          ? convo.options as VocabularyPending
          : null;
        const productSetupPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<ProductSetupPending> | null)?.kind === 'product_setup_pending'
          ? convo.options as ProductSetupPending
          : null;
        // "Soseji ngapi?" is out and this is the reply. Identity scoping and
        // expiry are the table's own; nothing here is trusted because it was
        // stored.
        const quantityPending = convo?.awaiting === 'daily_record_quantity'
          && (convo.options as Partial<QuantityWanted> | null)?.kind === 'quantity_wanted'
          ? convo.options as QuantityWanted
          : null;
        const productChoicePending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<ProductChoicePending> | null)?.kind === 'product_read_choice'
          ? convo.options as ProductChoicePending
          : null;
        const bandPending = convo?.awaiting === 'product_cost'
          && (convo.options as Partial<PriceBandPending> | null)?.kind === 'price_band_choice'
          ? convo.options as PriceBandPending
          : null;
        /**
         * Ask which price, and park the sale whole behind the question.
         *
         * Every path that prices a sale goes through here, so the question is
         * worded once and the parked state has one shape. Nothing is written:
         * the sale is still a message until the usual NDIYO.
         */
        /** "Mishikaki ipi?", with the sale parked behind it. */
        const askWhichVariant = async (
          phrase: string,
          token: string,
          candidates: string[],
          sale: QuantitySale,
          sourceMessageId: string,
          credit: { party: string } | null = null,
          paymentMethod: QuantityWanted['paymentMethod'] = null,
          occurredAt: string | null = null,
        ) => {
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: {
              kind: 'combo_variant', sale, phrase, token, candidates,
              known: settledCombos, sourceMessageId, credit, paymentMethod, occurredAt,
            } satisfies ComboVariantPending,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await replyQuietly(phone, comboVariantQuestion(phrase, token, candidates, lang));
        };

        /** One question about one combination, with the sale parked behind it. */
        const askAboutCombo = async (
          split: ComboSplit,
          sale: QuantitySale,
          units: [string, string[]][],
          sourceMessageId: string,
          orders: number,
          credit: { party: string } | null = null,
          paymentMethod: QuantityWanted['paymentMethod'] = null,
          occurredAt: string | null = null,
        ) => {
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: {
              kind: 'combo_clarification',
              sale, split, units, orders, sourceMessageId, credit, paymentMethod, occurredAt,
              known: settledCombos,
            } satisfies ComboPending,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await replyQuietly(phone, comboQuestion(split, orders, new Map(units), lang));
        };

        const askForPriceBand = async (
          choices: PriceBandChoice[],
          sale: QuantitySale,
          sourceMessageId: string,
          prefix = '',
          credit: { party: string } | null = null,
          paymentMethod: QuantityWanted['paymentMethod'] = null,
          occurredAt: string | null = null,
          settled: PricedLine[] = [],
        ) => {
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: {
              kind: 'price_band_choice',
              sale,
              choices,
              answered: choices.map(() => null),
              settled,
              sourceMessageId,
              credit,
              paymentMethod,
              occurredAt,
            } satisfies PriceBandPending,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await replyQuietly(phone, prefix + priceBandQuestion(choices, lang, settled));
        };
        const costConversation = convo?.awaiting === 'product_cost' && convo.options
          && !costPrompt && !costBatchPending && !stockBatchPending && !stockPurchaseCostPending && !stockPurchaseCostAmountPending && !sellingBatchPending && !priceAndCostPending
          && !newProductPending && !newProductQuantityPending && !newProductRegistrationPending && !newProductSaleSetup && !portionSizePending && !portionConfirmPending
          && !quantityMeaningPending && !portionQuantityPending && !productRenamePending
          && !addProductSetupPending && !bandPending && !comboPending && !comboSavePending
          && !comboVariantPending
          ? { cost: convo.options as unknown as ProductCost }
          : null;
        const productContext = convo?.awaiting === 'product_analytics'
          && (convo.options as Partial<ProductAnalyticsContext> | null)?.kind === 'product_analytics_context'
          ? convo.options as ProductAnalyticsContext
          : null;
        const hypotheticalPortionPending = convo?.awaiting === 'product_analytics'
          && (convo.options as Partial<HypotheticalPortionChoice> | null)?.kind === 'hypothetical_portion_choice'
          ? convo.options as HypotheticalPortionChoice
          : null;
        let resumedQuantitySale: QuantitySale | null = null;
        let resumedQuantityCredit: { party: string } | null = null;
        let resumedQuantityPaymentMethod: QuantityWanted['paymentMethod'] = null;
        let resumedQuantityOccurredAt: string | null = null;
        /** Combinations settled earlier in this same conversation. */
        let settledCombos: ComboSplit[] = [];
        // Full account deletion is a separate control-plane flow from logout:
        // logout only unlinks this phone. The first account-delete message
        // always parks a warning; only the exact second phrase can call the
        // service-role deletion RPC.
        const accountDeletePending = convo?.awaiting === 'account_delete_confirm'
          && (convo.options as Partial<AccountDeletionState> | null)?.kind === 'account_delete'
          ? convo.options as AccountDeletionState
          : null;

        if (accountDeletePending) {
          if (isAccountDeletionCancel(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, lang === 'sw' ? 'Sawa, sijaafuta chochote.' : 'Okay, nothing was deleted.');
          } else if (isAccountDeletionConfirmation(body)) {
            const { error } = await db.rpc('delete_account_data', {
              p_profile_id: identity.profile_id,
              p_owned_company_ids: accountDeletePending.ownedCompanies.map((company) => company.id),
            });
            if (error) {
              await clearConversation(db, identity.id as string);
              await replyQuietly(phone, lang === 'sw'
                ? 'Sikuweza kufuta akaunti sasa. Hakuna kilichofutwa; tafadhali jaribu tena kupitia Risip.'
                : 'I could not delete the account now. Nothing was deleted; please try again in Risip.');
            } else {
              // The RPC deletes the current identity and message row too, so
              // finish() is intentionally not followed by an audit write.
              await replyQuietly(phone, accountDeletionDone(lang));
            }
          } else {
            await replyQuietly(phone, accountDeletionReask(lang));
          }
          await finish('skipped');
          continue;
        }

        if (isAccountDeletionRequest(body)) {
          try {
            const ownedCompanies = await loadOwnedBusinesses(db, identity.profile_id);
            await clearConversation(db, identity.id as string);
            await parkAccountDeletion(db, identity, ownedCompanies);
            await replyQuietly(phone, accountDeletionWarning(ownedCompanies, lang));
            await audit(db, identity, waMessageId, 'account_delete', 'warning', 'applied');
          } catch {
            await replyQuietly(phone, lang === 'sw'
              ? 'Sikuweza kuanza uthibitisho wa kufuta akaunti sasa. Jaribu tena.'
              : 'I could not start the account deletion confirmation now. Please try again.');
          }
          await finish('skipped');
          continue;
        }

        // ── Signing out ──────────────────────────────────────────────────
        // The phone number is the credential, so this unlinks it. It runs
        // before the stop command on purpose: bare "toka" means both "cancel
        // this" and "let me out", and until now it silently meant the first.
        const logoutPending = convo?.awaiting === 'logout_confirm'
          && (convo.options as Partial<LogoutState> | null)?.kind === 'logout'
          ? convo.options as LogoutState
          : null;

        if (logoutPending) {
          if (logoutPending.step === 'disambiguate') {
            const choice = parseDisambiguationChoice(body);
            if (choice === 'logout') {
              await parkLogout(db, identity, 'confirm');
              await replyQuietly(phone, logoutConfirmation(identity.company_name, lang));
              await audit(db, identity, waMessageId, 'logout', 'confirm_asked', 'applied');
            } else if (choice === 'cancel') {
              // Nothing was pending when the question was asked — that is why it
              // was asked at all — so this only drops the question itself.
              await clearConversation(db, identity.id as string);
              await replyQuietly(phone, t('cancelled', lang));
              await audit(db, identity, waMessageId, 'logout', 'meant_cancel', 'applied');
            } else {
              await replyQuietly(phone, logoutReask('disambiguate', lang));
              await audit(db, identity, waMessageId, 'logout', 'reask', 'skipped');
            }
            await finish('skipped');
            continue;
          }

          if (isDailyRecordConfirmation(body)) {
            const result = await performLogout(db, identity, phone, lang);
            await replyQuietly(phone, result.reply);
            await audit(db, identity, waMessageId, 'logout', 'unlink', result.outcome);
          } else if (isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, logoutCancelled(lang));
            await audit(db, identity, waMessageId, 'logout', 'declined', 'applied');
          } else {
            await replyQuietly(phone, logoutReask('confirm', lang));
            await audit(db, identity, waMessageId, 'logout', 'reask', 'skipped');
          }
          await finish('skipped');
          continue;
        }

        const logoutIntent = parseLogoutIntent(body);
        // Any live conversation state means something is genuinely pending, and
        // "toka" keeps its old cancel meaning there — a person mid-draft almost
        // always means that one. With nothing pending there is nothing to
        // cancel, so the word is worth a question. Only an unmistakable
        // "logout"/"ondoa namba" overrides a draft.
        if (logoutIntent === 'explicit' || (logoutIntent === 'ambiguous' && !convo)) {
          const step: LogoutState['step'] = logoutIntent === 'explicit' ? 'confirm' : 'disambiguate';
          await parkLogout(db, identity, step);
          await replyQuietly(phone, step === 'confirm'
            ? logoutConfirmation(identity.company_name, lang)
            : logoutDisambiguation(lang));
          await audit(db, identity, waMessageId, 'logout', step === 'confirm' ? 'confirm_asked' : 'disambiguate', 'applied');
          await finish('skipped');
          continue;
        }

        // A stop command cancels a pending daily-record draft through the same
        // RPC used by HAPANA/NO. Clarification-only state has no DB draft yet,
        // so it is safely cleared without creating a ledger event.
        if (isStopCommand(body)) {
          if (dailyBatchConversation) {
            const { error } = await db.rpc('wa_cancel_daily_record_batch', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_ids: dailyBatchConversation.dailyRecordIds,
              p_reason: 'WhatsApp user cancelled daily record batch',
            });
            if (!error) {
              await clearConversation(db, identity.id as string);
              await clearAssistantMemory(db, identity);
            }
            await replyQuietly(phone, error
              ? buildDailyRecordBatchPending(dailyBatchConversation.records, lang)
              : (lang === 'sw' ? 'Sawa. Rekodi zote za ujumbe huu zimeghairiwa.' : 'Okay. All records from this message were cancelled.'));
            await audit(db, identity, waMessageId, 'cancel_action', 'daily_record_batch', error ? 'failed' : 'voided');
          } else if (dailyConversation) {
            const { error } = await db.rpc('wa_cancel_daily_record_draft', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_id: dailyConversation.dailyRecordId,
              p_reason: 'WhatsApp user cancelled daily record draft',
            });
            if (!error) {
              await clearConversation(db, identity.id as string);
              await clearAssistantMemory(db, identity);
            }
            await replyQuietly(phone, error ? buildDailyRecordPending(dailyConversation.record, lang) : t('cancelled', lang));
            await audit(db, identity, waMessageId, 'cancel_action', 'daily_record', error ? 'failed' : 'voided');
          } else if (breakdownConfirmation) {
            const { error } = await db.rpc('wa_cancel_daily_record_draft', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_id: breakdownConfirmation.dailyRecordId,
              p_reason: 'WhatsApp user cancelled whole-animal breakdown draft',
            });
            if (!error) {
              await clearConversation(db, identity.id as string);
              await clearAssistantMemory(db, identity);
            }
            await replyQuietly(phone, error
              ? wholeAnimalBreakdownConfirmation(breakdownConfirmation.outputs, lang)
              : (lang === 'sw' ? 'Sawa. Breakdown imeghairiwa; stock haijabadilika.' : 'Okay. Breakdown cancelled; stock was unchanged.'));
            await audit(db, identity, waMessageId, 'cancel_action', 'whole_animal_breakdown', error ? 'failed' : 'voided');
          } else {
            await clearConversation(db, identity.id as string);
            await clearAssistantMemory(db, identity);
            await replyQuietly(phone, t('cancelled', lang));
            await audit(db, identity, waMessageId, 'cancel_action', 'clear_state', 'applied');
          }
          await finish('skipped');
          continue;
        }

        // A stock arrival with a known previous cost opens a real menu. The
        // numeric/letter response is the advertised protocol exception: it is
        // not ordinary language and cannot be allowed to fall through to the
        // model as a fresh, directionless message.
        if (stockPurchaseCostPending) {
          const choice = stockPurchaseCostChoice(body);
          if (choice === 'cancel') {
            await clearConversation(db, identity.id as string);
            await clearAssistantMemory(db, identity);
            await replyQuietly(phone, stockPurchaseCostCancelled(lang));
            await audit(db, identity, waMessageId, 'stock_purchase_cost', 'cancelled', 'skipped');
            await finish('skipped');
            continue;
          }
          if (choice === 'reuse') {
            await clearConversation(db, identity.id as string);
            await clearAssistantMemory(db, identity);
            const total = Math.round(stockPurchaseCostPending.lastUnitCost
              * stockPurchaseCostPending.quantity * 100) / 100;
            const result = await createStockPurchaseDraftFromCost(
              db, identity, waMessageId, stockPurchaseCostPending, total, lang,
            );
            await replyQuietly(phone, result.content);
            await audit(db, identity, waMessageId, 'stock_purchase_cost', 'last_cost', result.isError ? 'failed' : 'pending');
            await finish(result.isError ? 'skipped' : 'applied');
            continue;
          }
          if (choice === 'new') {
            const nextState: StockPurchaseCostPending = {
              ...stockPurchaseCostPending,
              kind: 'stock_purchase_cost_amount',
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'product_cost',
              receipt_id: null,
              options: nextState,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await replyQuietly(phone, stockPurchaseNewCostQuestion(lang));
            await audit(db, identity, waMessageId, 'stock_purchase_cost', 'new_cost', 'clarification');
            await finish('skipped');
            continue;
          }
          // A sentence that is not one of the menu answers is ordinary language.
          // Release this menu and let the AI understand the new sentence rather
          // than trapping the conversation in a repeated question.
          await clearConversation(db, identity.id as string);
          await clearAssistantMemory(db, identity);
          await audit(db, identity, waMessageId, 'stock_purchase_cost', 'released', 'to_model');
          convo = null;
        }

        // A pending money draft is not allowed to trap the whole chat. If the
        // person unmistakably starts another task, cancel the old draft through
        // its RPC first, clear both deterministic and AI short-term state, then
        // continue routing this same message. A failed cancellation blocks the
        // switch so two live drafts can never be left behind accidentally.
        const switchesPendingDailyTopic = Boolean(
          (dailyBatchConversation || dailyConversation)
          && !isDailyRecordConfirmation(body)
          && !isDailyRecordRejection(body)
          && !isCancel(body ?? ''),
        );
        if (switchesPendingDailyTopic && dailyBatchConversation) {
          const { error } = await db.rpc('wa_cancel_daily_record_batch', {
            p_profile_id: identity.profile_id,
            p_company_id: identity.company_id,
            p_daily_record_ids: dailyBatchConversation.dailyRecordIds,
            p_reason: 'WhatsApp user changed topic before confirming daily record batch',
          });
          if (error) {
            await replyDailyRecordBatchConfirmationQuietly(phone, dailyBatchConversation.records, lang, waMessageId);
            await audit(db, identity, waMessageId, 'daily_record_batch', 'topic_switch_cancel', 'failed');
            await finish('skipped', 'daily_record_batch_cancel_failed');
            continue;
          }
          await clearConversation(db, identity.id as string);
          await clearAssistantMemory(db, identity);
          await replyQuietly(phone, lang === 'sw'
            ? 'Nimeghairi draft ya awali kwa sababu umeanza mada mpya.'
            : 'I cancelled the earlier draft because you started a new topic.');
          await audit(db, identity, waMessageId, 'daily_record_batch', 'topic_switch_cancel', 'applied');
          dailyBatchConversation = null;
          convo = null;
        } else if (switchesPendingDailyTopic && dailyConversation) {
          const { error } = await db.rpc('wa_cancel_daily_record_draft', {
            p_profile_id: identity.profile_id,
            p_company_id: identity.company_id,
            p_daily_record_id: dailyConversation.dailyRecordId,
            p_reason: 'WhatsApp user changed topic before confirming daily record draft',
          });
          if (error) {
            await replyDailyRecordConfirmationQuietly(phone, dailyConversation.record, lang, waMessageId);
            await audit(db, identity, waMessageId, 'daily_record', 'topic_switch_cancel', 'failed');
            await finish('skipped', 'daily_record_cancel_failed');
            continue;
          }
          await clearConversation(db, identity.id as string);
          await clearAssistantMemory(db, identity);
          await replyQuietly(phone, lang === 'sw'
            ? 'Nimeghairi draft ya awali kwa sababu umeanza mada mpya.'
            : 'I cancelled the earlier draft because you started a new topic.');
          await audit(db, identity, waMessageId, 'daily_record', 'topic_switch_cancel', 'applied');
          dailyConversation = null;
          convo = null;
        }

        // "Mishikaki ipi?" The answer is put back into the sentence they wrote,
        // so the sale is read again exactly as if they had typed the full name.
        const variantAnswer = comboVariantPending
          ? parseComboVariant(body, comboVariantPending.candidates) : null;
        if (comboVariantPending && !variantAnswer && releasesParkedQuestion(body ?? '')) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'combo_variant', 'abandoned', 'skipped');
        } else if (comboVariantPending) {
          const chosen = parseComboVariant(body, comboVariantPending.candidates);
          if (!chosen) {
            await reply(phone, comboVariantQuestion(
              comboVariantPending.phrase, comboVariantPending.token,
              comboVariantPending.candidates, lang));
            await audit(db, identity, waMessageId, 'combo_variant', 'reask', 'skipped');
            await finish('skipped');
            continue;
          }
          const wanted = comboKey(comboVariantPending.token);
          resumedQuantitySale = {
            ...comboVariantPending.sale,
            items: comboVariantPending.sale.items.map((item) => (
              comboKey(item.product) === comboKey(comboVariantPending.phrase)
                ? {
                  ...item,
                  product: item.product.replace(
                    new RegExp(`\\b${wanted.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
                    chosen,
                  ),
                }
                : item)),
          };
          settledCombos = comboVariantPending.known;
          resumedQuantityCredit = comboVariantPending.credit ?? null;
          resumedQuantityPaymentMethod = comboVariantPending.paymentMethod ?? null;
          resumedQuantityOccurredAt = comboVariantPending.occurredAt ?? null;
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'combo_variant', 'answered', 'applied');
        }

        // "chips kuku" — which measure of chicken, and how many of what rides
        // along. One question, once, and the answer is offered for saving so it
        // is never asked twice.
        const comboAnswer = comboPending
          ? parseComboAnswer(body, comboQuestions(comboPending.split), new Map(comboPending.units)) : null;
        if (comboPending && !comboAnswer && releasesParkedQuestion(body ?? '')) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'combo', 'abandoned', 'skipped');
        } else if (comboPending) {
          const units = new Map(comboPending.units);
          const open = comboQuestions(comboPending.split);
          const heard = parseComboAnswer(body, open, units);
          if (!heard) {
            await reply(phone, comboQuestion(comboPending.split, comboPending.orders, units, lang));
            await audit(db, identity, waMessageId, 'combo', 'reask', 'skipped');
            await finish('skipped');
            continue;
          }
          const settled: ComboSplit = {
            ...comboPending.split,
            pieces: comboPending.split.pieces.map((piece) => {
              const at = open.findIndex((asked) => asked.key === piece.key);
              const answer = at < 0 ? null : heard[at];
              if (!answer) return piece;
              if ('unit' in answer) {
                const { unitMissing: _drop, ...rest } = piece;
                return { ...rest, unit: answer.unit };
              }
              const { quantityAssumed: _drop, ...rest } = piece;
              return { ...rest, quantity: answer.quantity };
            }),
          };
          const stillOpen = comboQuestions(settled);
          if (stillOpen.length > 0) {
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'product_cost',
              receipt_id: null,
              options: { ...comboPending, split: settled } satisfies ComboPending,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await reply(phone, comboQuestion(settled, comboPending.orders, units, lang));
            await audit(db, identity, waMessageId, 'combo', 'partial', 'pending');
            await finish('skipped');
            continue;
          }
          resumedQuantitySale = comboPending.sale;
          settledCombos = [...comboPending.known, settled];
          resumedQuantityCredit = comboPending.credit ?? null;
          resumedQuantityPaymentMethod = comboPending.paymentMethod ?? null;
          resumedQuantityOccurredAt = comboPending.occurredAt ?? null;
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'combo', 'answered', 'applied');
        }

        if (quantityPending) {
          const answer = parseQuantityAnswer(body ?? '');
          if (!answer) {
            // A message that plainly starts something else must not be trapped
            // inside the question. The pending state simply lapses and the new
            // subject is read by whoever owns it.
            // parseQuantityAnswer already found nothing, so this is not the
            // answer to the question we asked. Release it to the model rather
            // than asking a third time — that re-ask is what met every
            // correction the shop tried to make.
            await clearConversation(db, identity.id as string);
            await audit(db, identity, waMessageId, 'quantity_wanted', 'topic_change', 'skipped');
          } else {
            // Re-enter the ordinary quantity-sale pipeline below. It resolves
            // the current company product and units and recalculates the price;
            // conversation state contributes intent and wording, never money.
            resumedQuantitySale = {
              kind: 'quantity_sale',
              items: [{
                product: quantityPending.product,
                quantity: answer.quantity,
                band: null,
                ...(answer.unit
                  ? { spokenUnit: answer.unit, productWithoutUnit: quantityPending.product }
                  : {}),
              }],
              expenses: [],
            };
            resumedQuantityCredit = quantityPending.ledger === 'debt_issued'
              && quantityPending.party
              ? { party: quantityPending.party }
              : null;
            resumedQuantityPaymentMethod = quantityPending.paymentMethod;
            resumedQuantityOccurredAt = quantityPending.occurredAt ?? null;
            await audit(db, identity, waMessageId, 'quantity_wanted', 'answered', 'applied');
          }
        }

        if (productSetupPending) {
          await clearConversation(db, identity.id as string);
          if (!isDailyRecordConfirmation(body ?? '')) {
            await replyQuietly(phone, lang === 'sw'
              ? 'Sawa, sijabadilisha mpangilio wa bidhaa.'
              : 'Fine, I changed no product setup.');
            await audit(db, identity, waMessageId, 'product_setup', 'declined', 'applied');
            await finish('skipped');
            continue;
          }
          const setup = productSetupPending.setup;
          const named = productSetupPending.productName ?? setup.product;
          // Three shapes, three existing doors. MEASURED, by calling the real
          // RPC rather than reading its signature: configure_product_units
          // demands a base unit, a purchase unit, a size, a cost AND a priced
          // selling unit, and refuses a product it has already configured. It
          // is the right door for a full setup and the wrong one for the other
          // two, so those go where they belong instead of being forced.
          const saved = setup.kind === 'packaging_setup'
            // One more measure for a product that already has one (0125).
            ? await db.rpc('wa_add_product_unit', {
              p_phone: phone, p_name: named,
              p_unit: setup.packageUnit, p_base_quantity: setup.size, p_retail: null,
            })
            : setup.purchaseCost === null
              // A price with no cost behind it. MEASURED: wa_set_selling_price
              // writes a bare product price and never touches product_units, so
              // the "kilo" the shop just said was thrown away and the product
              // had no sellable unit at all. It goes through the unit door
              // instead, which stores the measure AND the price against it.
              // Nothing is invented: the buying cost stays unknown.
              ? await db.rpc('wa_add_product_unit', {
                p_phone: phone, p_name: named,
                p_unit: setup.saleUnit, p_base_quantity: 1, p_retail: setup.salePrice,
              })
              : await db.rpc('wa_configure_product_units', {
                p_phone: phone,
                p_name: named,
                p_base_unit: setup.baseUnit,
                p_purchase_unit: setup.purchaseUnit,
                p_purchase_size: setup.purchaseSize,
                p_purchase_cost: setup.purchaseCost,
                p_sale_units: setupSaleUnits(setup),
              });
          const setupError = saved.error;
          if (setupError) {
            await reply(phone, lang === 'sw'
              ? 'Sikuweza kuhifadhi mpangilio huu sasa.'
              : 'I could not save this setup just now.');
            await audit(db, identity, waMessageId, 'product_setup', 'failed', 'failed');
            await finish('skipped');
            continue;
          }
          await reply(phone, productSetupSaved(named, lang));
          await audit(db, identity, waMessageId, 'product_setup', setup.kind, 'applied');
          await finish('applied');
          continue;
        }

        if (vocabularyPending) {
          await clearConversation(db, identity.id as string);
          if (!isDailyRecordConfirmation(body ?? '')) {
            await replyQuietly(phone, lang === 'sw'
              ? 'Sawa, sijabadilisha neno lolote.'
              : 'Fine, I changed no words.');
            await audit(db, identity, waMessageId, 'vocabulary', 'declined', 'applied');
            await finish('skipped');
            continue;
          }
          const teaching = vocabularyPending.teaching;
          if (teaching.kind === 'forget') {
            const { data: gone } = await db.rpc('wa_forget_business_term', {
              p_phone: phone, p_term: teaching.term,
            });
            const removed = Boolean((gone as Record<string, unknown> | null)?.removed);
            await reply(phone, vocabularyForgotten(teaching.term, removed, lang));
            await audit(db, identity, waMessageId, 'vocabulary', 'forgotten', 'applied');
            await finish('applied');
            continue;
          }
          const { data: saved, error: saveError } = await db.rpc('wa_save_business_term', {
            p_phone: phone,
            p_kind: teaching.kind,
            p_term: teaching.term,
            p_product: vocabularyPending.productName,
            p_meaning: teaching.kind === 'semantic_term' ? teaching.meaning : null,
          });
          const result = (saved ?? null) as Record<string, unknown> | null;
          if (saveError || !result) {
            await reply(phone, lang === 'sw'
              ? 'Sikuweza kuhifadhi neno hilo sasa.'
              : 'I could not save that word just now.');
            await audit(db, identity, waMessageId, 'vocabulary', 'failed', 'failed');
            await finish('skipped');
            continue;
          }
          // The database refuses a silent remap and hands back what the word
          // already means, so the shop is told rather than surprised.
          if (result.conflict === true) {
            await reply(phone, vocabularyConflict(teaching.term, {
              kind: String(result.existing_kind ?? ''),
              productName: result.existing_product ? String(result.existing_product) : null,
              meaning: result.existing_meaning ? String(result.existing_meaning) : null,
            }, lang));
            await audit(db, identity, waMessageId, 'vocabulary', 'conflict', 'skipped');
            await finish('skipped');
            continue;
          }
          await reply(phone, vocabularySaved(teaching.term, lang));
          await audit(db, identity, waMessageId, 'vocabulary', teaching.kind, 'applied');
          await finish('applied');
          continue;
        }

        // "Nihifadhi chips yai = chips kavu + yai?" — asked after the sale is
        // safely recorded, so a no costs nothing.
        if (comboSavePending && !isDailyRecordConfirmation(body ?? '')) {
          await clearConversation(db, identity.id as string);
          if (!isDailyRecordRejection(body ?? '')) {
            // Anything that is not an answer is a new subject; the offer simply
            // lapses rather than standing in the way.
            await audit(db, identity, waMessageId, 'combo_save', 'lapsed', 'skipped');
          } else {
            await audit(db, identity, waMessageId, 'combo_save', 'declined', 'applied');
            await replyQuietly(phone, lang === 'sw' ? 'Sawa, sijahifadhi jina hilo.' : 'Fine, I did not save that name.');
            await finish('skipped');
            continue;
          }
        } else if (comboSavePending) {
          await clearConversation(db, identity.id as string);
          const saved: string[] = [];
          for (const split of comboSavePending.splits) {
            const { error } = await db.rpc('wa_save_combo', {
              p_phone: phone,
              p_name: split.phrase,
              p_pieces: split.pieces.map((piece) => ({
                key: piece.key, name: piece.name, quantity: piece.quantity, unit: piece.unit,
              })),
            });
            if (!error) saved.push(split.phrase);
          }
          await replyQuietly(phone, saved.length > 0
            ? comboSaved(saved.join(', '), lang)
            : (lang === 'sw' ? 'Sikuweza kuhifadhi jina hilo sasa.' : 'I could not save that name just now.'));
          await audit(db, identity, waMessageId, 'combo_save', String(saved.length),
            saved.length > 0 ? 'applied' : 'failed');
          await finish('skipped');
          continue;
        }

        // WHICH OF THE TWO DID HE MEAN — READ BY US, NOT GUESSED AT.
        //
        // The question numbers the candidates and says "Jibu kwa namba". Until
        // this branch existed nothing read that answer: "1" went to the model,
        // which had the list in the turn above and usually got it right. The
        // owner asked for the treatment the other numbered questions get, and
        // he is right to — this one decides which product a sale is written
        // against, and "usually" is not good enough for that.
        //
        // The answer does not restart anything. His original sentence is
        // replayed with the ambiguous word swapped for the product he picked,
        // so the quantities, the prices and the rest of the list survive.
        if (productChoicePending) {
          if (isPendingEscape(body)) {
            await clearConversation(db, identity.id as string);
            await reply(phone, productChoiceCancelled(lang));
            await audit(db, identity, waMessageId, 'product_choice', 'cancelled', 'skipped');
            await finish('skipped');
            continue;
          }
          const chosen = parseProductChoiceAnswer(body, productChoicePending.candidates);
          if (chosen) {
            const replaced = replaceAskedProduct(
              productChoicePending.originalText, productChoicePending.asked, chosen);
            await clearConversation(db, identity.id as string);
            convo = null;
            body = replaced;
            writeBody = replaced;
            assistantEvidenceBody = replaced;
            intent = routeFor(body);
            await audit(db, identity, waMessageId, 'product_choice', 'answered', 'applied');
          } else {
            // Not an answer. A new turn belongs to the model, and holding the
            // question open would re-ask it forever — the failure that cost
            // four other branches before this one.
            await clearConversation(db, identity.id as string);
            convo = null;
            await audit(db, identity, waMessageId, 'product_choice', 'released', 'to_model');
          }
        }

        // Which of the two prices was this sold at? The sale waits here, whole,
        // until the answer comes back, and then goes through pricing again as
        // though the message had said "jumla" in the first place.
        //
        // OUR OWN FORM IS AN ANSWER, NOT A NEW SUBJECT.
        //
        // A written answer such as "1 jumla 2 rejareja" is language, not a
        // numeric menu selection. Keep the parked sale visible to the LLM so
        // it can interpret every row with the product context still attached.
        if (bandPending && (isPendingEscape(body)
          || isPriceBandCancelChoice(body, bandPending.choices.length))) {
          // The question prints "Ukiamua kuacha, andika *GHAIRI*". Before this
          // it did not mean it: isCancel makes releasesParkedQuestion false, the
          // answer parser finds no band word, and the branch re-sent the same
          // question. A way out we advertise has to be one.
          await clearConversation(db, identity.id as string);
          await reply(phone, priceBandCancelled(lang));
          await audit(db, identity, waMessageId, 'price_band', 'cancelled', 'skipped');
          await finish('skipped');
          continue;
        }
        // A written price answer is ordinary language and must reach the LLM
        // with this pending sale as context. Only the advertised cancel words
        // above are protocol; the model decides whether "juml", "reja" or a
        // mixed numbered sentence means retail or wholesale, then returns
        // canonical values through resolve_pending_clarification.

        // A bare list such as "kitabu 7, biblia 3" is parked because it could
        // mean sales or stock. A short answer resumes the exact list instead of
        // being parsed as a brand-new one-line message.
        if (quantityMeaningPending && parseQuantityMeaningAnswer(body) === null
          && !((quantityMeaningPending.missingProducts?.length ?? 0) > 0
            && wantsToRegisterNewProducts(body))) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'quantity_meaning', 'abandoned', 'skipped');
        } else if (quantityMeaningPending) {
          const meaning = parseQuantityMeaningAnswer(body);
          if ((quantityMeaningPending.missingProducts?.length ?? 0) > 0
            && wantsToRegisterNewProducts(body)) {
            // SAJILI IS NOT A DIRECTION, AND MUST NOT BECOME ONE BY DEFAULT.
            //
            // MEASURED, and the owner's question is what exposed it: "what if
            // we add a, b when kukiwa na mada mbili". He is right that this
            // message carries two decisions — what these products ARE, and
            // what happened to them — and the second was being answered for
            // him. Choosing SAJILI parked the sale with no direction, the
            // resume fell through to the sale path, and every line was written
            // down as today's takings by somebody who had only said "these are
            // new products".
            //
            // 'ask' says so explicitly rather than leaving the field absent and
            // hoping a later branch notices. Registration finishes, and THEN
            // the direction is asked — one question at a time, which is the
            // rule that already governs every other message here.
            const state: NewProductOfferSetup = {
              kind: 'new_product_offer_setup',
              missingProducts: quantityMeaningPending.missingProducts ?? [],
              sourceMessageId: quantityMeaningPending.sourceMessageId,
              originalText: quantityMeaningPending.originalText,
              pendingSale: quantityMeaningPending.sale,
              pendingDirection: 'ask',
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'product_cost',
              receipt_id: null,
              options: state,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await reply(phone, newProductOffer(
                state.missingProducts, lang,
                Math.max(0, (state.pendingSale?.items.length ?? 0) - state.missingProducts.length),
              ));
            await audit(db, identity, waMessageId, 'quantity_meaning', 'register_new_products', 'clarification');
            await finish('skipped');
            continue;
          }
          if (meaning === 'sale') {
            resumedQuantitySale = quantityMeaningPending.sale;
            await clearConversation(db, identity.id as string);
            await audit(db, identity, waMessageId, 'quantity_meaning', 'sale', 'applied');
          } else if (meaning === 'stock_purchase') {
            if ((quantityMeaningPending.missingProducts?.length ?? 0) > 0) {
              // Everything he typed travels with the question, and what he
              // asked for travels with it. Without these two the nine products
              // he already sells were dropped the moment two new names appeared
              // beside them.
              const state: NewProductOfferSetup = {
                kind: 'new_product_offer_setup',
                missingProducts: quantityMeaningPending.missingProducts ?? [],
                sourceMessageId: quantityMeaningPending.sourceMessageId,
                originalText: quantityMeaningPending.originalText,
                pendingDirection: 'stock_purchase',
                pendingSale: quantityMeaningPending.sale,
              };
              await db.from('whatsapp_conversations').upsert({
                identity_id: identity.id,
                company_id: identity.company_id,
                profile_id: identity.profile_id,
                awaiting: 'product_cost',
                receipt_id: null,
                options: state,
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                updated_at: new Date().toISOString(),
              }, { onConflict: 'identity_id' });
              await reply(phone, newProductOffer(
                state.missingProducts, lang,
                Math.max(0, (state.pendingSale?.items.length ?? 0) - state.missingProducts.length),
              ));
              await audit(db, identity, waMessageId, 'quantity_meaning', 'stock_purchase_new_products', 'clarification');
              await finish('skipped');
              continue;
            }
            await clearConversation(db, identity.id as string);
            await reply(phone, stockPurchaseNeedsPrices(quantityMeaningPending, lang));
            await audit(db, identity, waMessageId, 'quantity_meaning', 'stock_purchase', 'clarification');
            await finish('skipped');
            continue;
          } else if (meaning === 'stock_count') {
            // A COUNT ONLY MEANS SOMETHING FOR A REGISTERED PRODUCT.
            //
            // wa_record_stock_counts inserts whatever product_key it is handed,
            // so counting a name nobody has registered creates a shelf entry
            // with no buying cost and no selling price. It then shows up in
            // "what is on hand" as a quantity that cannot be valued, cannot be
            // sold, and that nobody remembers creating.
            //
            // The known ones are counted — that work is real and there is no
            // reason to refuse it — and the rest are named, with the reason.
            // Skipping something silently is what this whole week has been
            // about.
            const unregistered = new Set(
              (quantityMeaningPending.missingProducts ?? []).map((name) => productKey(name)),
            );
            const countable = quantityMeaningPending.sale.items
              .filter((item) => !unregistered.has(productKey(item.product)));
            if (countable.length === 0) {
              // Nothing here can be counted yet. Registration is the only door
              // that is open, so go straight to it rather than showing an empty
              // list and asking about it.
              const state: NewProductOfferSetup = {
                kind: 'new_product_offer_setup',
                missingProducts: quantityMeaningPending.missingProducts ?? [],
                sourceMessageId: quantityMeaningPending.sourceMessageId,
                originalText: quantityMeaningPending.originalText,
                pendingSale: quantityMeaningPending.sale,
              };
              await db.from('whatsapp_conversations').upsert({
                identity_id: identity.id,
                company_id: identity.company_id,
                profile_id: identity.profile_id,
                awaiting: 'product_cost',
                receipt_id: null,
                options: state,
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                updated_at: new Date().toISOString(),
              }, { onConflict: 'identity_id' });
              await reply(phone, newProductOffer(
                state.missingProducts, lang,
                Math.max(0, (state.pendingSale?.items.length ?? 0) - state.missingProducts.length),
              ));
              await audit(db, identity, waMessageId, 'quantity_meaning', 'stock_count_all_new', 'clarification');
              await finish('skipped');
              continue;
            }
            const stockBatch: StockCountBatch = {
              kind: 'stock_count_batch',
              counts: countable.map((item) => ({
                product: item.product,
                quantity: item.quantity,
                unit: item.unit ?? null,
              })),
              unreadable: [],
              notRegistered: quantityMeaningPending.missingProducts ?? [],
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'product_cost',
              receipt_id: null,
              options: stockBatch,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await reply(phone, stockCountBatchConfirmation(stockBatch, lang));
            await audit(db, identity, waMessageId, 'quantity_meaning', 'stock_count', 'pending');
            await finish('skipped');
            continue;
          } else {
            // NOT A NUMBER AND NOT ONE OF THE THREE WORDS — SO IT IS LANGUAGE.
            //
            // The owner: "nachotaka hata mtu akijielezea kwa maswali ai iwe na
            // uwezo wa kuelewa kama chatgpt."
            //
            // He is right, and re-asking was the robot. "Hizi nimezinunua leo
            // asubuhi" is a perfectly clear answer that this parser cannot read
            // and the model reads without effort — reading language is the one
            // job a parser should never be given.
            //
            // The parked question stays exactly where it is. The model is told
            // what is waiting and answers it through
            // resolve_pending_clarification, or changes the subject and the
            // server releases the question. Either way nobody is asked the same
            // thing twice for having used their own words.
            await audit(db, identity, waMessageId, 'quantity_meaning', 'to_model', 'clarification');
            // Deliberately no finish() and no continue: falling through is the
            // whole point. The message carries on to the model with the parked
            // question still in its context.
          }
        }

        // "mafuta robo" already names an exact, company-declared portion. Keep
        // that context and ask only for the missing quantity; the short answer
        // "3" resumes the same product instead of falling into generic AI chat.
        if (portionQuantityPending) {
          const quantity = parsePortionQuantityAnswer(body);
          if (quantity !== null) {
            resumedQuantitySale = {
              kind: 'quantity_sale',
              items: [{
                product: `${portionQuantityPending.productName} ${portionQuantityPending.unitName}`,
                quantity,
                band: null,
              }],
              expenses: [],
            };
            await clearConversation(db, identity.id as string);
            await audit(db, identity, waMessageId, 'portion_quantity', 'resumed', 'applied');
          } else {
            // The quantity did not parse, so this is not the answer. Release
            // and let the model read it — including the corrections that used
            // to be met with the same question a third time.
            await clearConversation(db, identity.id as string);
            await audit(db, identity, waMessageId, 'portion_quantity', 'abandoned', 'skipped');
          }
        }

        if (hypotheticalPortionPending && !matchHypotheticalPortionAnswer(body, hypotheticalPortionPending)) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'hypothetical_product_profit', 'unit_abandoned', 'skipped');
        } else if (hypotheticalPortionPending) {
          const unit = matchHypotheticalPortionAnswer(body, hypotheticalPortionPending);
          if (!unit) {
            await reply(phone, hypotheticalPortionQuestion(hypotheticalPortionPending, lang));
            await audit(db, identity, waMessageId, 'hypothetical_product_profit', 'unit_reask', 'skipped');
            await finish('skipped');
            continue;
          }
          const result = await hypotheticalProfitToolReply(
            db, identity, `${hypotheticalPortionPending.productName} ${unit}`, lang,
          );
          await clearConversation(db, identity.id as string);
          await reply(phone, result.text);
          await audit(db, identity, waMessageId, 'hypothetical_product_profit', `unit:${unit}`, 'applied');
          await finish('skipped');
          continue;
        }
        // A pending question must not swallow a change of subject. Asked to
        // clarify a debt, the trader instead pasted 36 buying prices; the
        // clarification consumed the whole message and asked the same question
        // again, and not one price was saved. A person who has plainly moved on
        // gets the new thing done, and is told the old question was let go.
        if (breakdownSourcePending) {
          // "2" selects the second source here; it does not mean HAPANA.
          if (/^(?:ghairi|cancel)$/i.test(String(body ?? '').trim())) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, lang === 'sw'
              ? 'Sawa. Uchaguzi wa chanzo umeghairiwa; hakuna breakdown iliyohifadhiwa.'
              : 'Okay. Source selection was cancelled; no breakdown was saved.');
            await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'source_cancel', 'applied');
            await finish('skipped');
            continue;
          }
          const choice = parseWholeAnimalSourceChoice(body, breakdownSourcePending.candidates.length);
          if (choice === null) {
            await replyQuietly(phone, wholeAnimalSourceQuestion(breakdownSourcePending.candidates, lang));
            await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'source_choice', 'clarification');
            await finish('skipped');
            continue;
          }
          const source = breakdownSourcePending.candidates[choice];
          const result = await createWholeAnimalBreakdownDraft(
            db,
            identity,
            { kind: 'parsed', source: { relativeDate: null, purchaseTotal: null }, outputs: breakdownSourcePending.outputs },
            source,
            breakdownSourcePending.sourceMessageId,
          );
          if (result.clarification) {
            await replyQuietly(phone, result.clarification);
            await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'output', 'clarification');
            await finish('skipped');
            continue;
          }
          if (result.error || !result.id) {
            await replyQuietly(phone, lang === 'sw'
              ? 'Sikuweza kuhifadhi breakdown hii. Hakuna stock ya nyama iliyoongezwa; jaribu tena.'
              : 'I could not save this breakdown. No meat stock was added; please try again.');
            await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'draft', 'failed');
            await finish('skipped');
            continue;
          }
          const state: WholeAnimalBreakdownConfirmationState = {
            kind: 'whole_animal_breakdown_confirmation',
            dailyRecordId: result.id,
            sourceMessageId: breakdownSourcePending.sourceMessageId,
            outputs: result.outputs,
          };
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
            awaiting: 'payment_source', receipt_id: null, options: state,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await replyQuietly(phone, wholeAnimalBreakdownConfirmation(result.outputs, lang));
          await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'create', 'pending');
          await finish('applied');
          continue;
        }
        if (breakdownConfirmation) {
          if (isDailyRecordConfirmation(body)) {
            const { error } = await db.rpc('wa_confirm_daily_record', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_id: breakdownConfirmation.dailyRecordId,
            });
            if (!error) {
              await clearConversation(db, identity.id as string);
              await clearAssistantMemory(db, identity);
            }
            await replyQuietly(phone, error
              ? wholeAnimalBreakdownConfirmation(breakdownConfirmation.outputs, lang)
              : (lang === 'sw'
                ? '✅ Breakdown imethibitishwa. Outputs halisi zimeongezwa kwenye stock; gharama bado haijagawanywa kwa bidhaa.'
                : '✅ Breakdown confirmed. The measured outputs were added to stock; cost allocation remains incomplete.'));
            await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'confirm', error ? 'pending' : 'applied');
            await finish('skipped');
            continue;
          }
          if (isDailyRecordRejection(body)) {
            const { error } = await db.rpc('wa_cancel_daily_record_draft', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_id: breakdownConfirmation.dailyRecordId,
              p_reason: 'WhatsApp user declined whole-animal breakdown draft',
            });
            if (!error) {
              await clearConversation(db, identity.id as string);
              await clearAssistantMemory(db, identity);
            }
            await replyQuietly(phone, error
              ? wholeAnimalBreakdownConfirmation(breakdownConfirmation.outputs, lang)
              : (lang === 'sw' ? 'Sawa. Breakdown imeghairiwa; stock haijabadilika.' : 'Okay. Breakdown cancelled; stock was unchanged.'));
            await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'cancel', error ? 'failed' : 'applied');
            await finish('skipped');
            continue;
          }
          await replyQuietly(phone, wholeAnimalBreakdownConfirmation(breakdownConfirmation.outputs, lang));
          await finish('skipped');
          continue;
        }
        const changedSubject = (dailyBatchClarification || dailyClarification)
          ? parseProductCostBatch(body)
          : null;
        if (changedSubject) {
          await clearConversation(db, identity.id as string);
          await replyQuietly(phone, lang === 'sw'
            ? 'Nimeacha swali la awali.'
            : 'I have let the earlier question go.');
          await audit(db, identity, waMessageId, 'daily_record_batch', 'abandoned_for_costs', 'applied');
        }

        if (dailyBatchClarification && !changedSubject) {
          if (isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, lang === 'sw'
              ? 'Sawa. Ujumbe wote umeghairiwa; hakuna rekodi mpya iliyohifadhiwa.'
              : 'Okay. The whole message was cancelled; no new record was saved.');
            await audit(db, identity, waMessageId, 'daily_record_batch', 'clarification_cancel', 'applied');
            await finish('skipped');
            continue;
          }
          const resumed = resumeDailyRecordBatchClarification(dailyBatchClarification, body ?? '');
          if (resumed.kind === 'unsupported_payable' || resumed.kind === 'clarify') {
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'payment_source',
              receipt_id: null,
              options: resumed.state,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await replyQuietly(phone, resumed.kind === 'unsupported_payable' ? resumed.message : resumed.question);
            await audit(db, identity, waMessageId, 'daily_record_batch', 'clarification', resumed.kind);
            await finish('skipped');
            continue;
          }
          const guardedRecords = await Promise.all(resumed.records.map((record) =>
            addHistoricalPriceWarnings(db, identity.company_id, record)));
          const created = await createDailyRecordBatchDrafts(
            db, identity, dailyBatchClarification.sourceMessageId ?? waMessageId, guardedRecords, lang,
          );
          if (created.error || created.ids.length !== guardedRecords.length) {
            await replyQuietly(phone, lang === 'sw'
              ? 'Sikuweza kuandaa rekodi hizi pamoja. Hakuna rekodi mpya iliyohifadhiwa; tafadhali jaribu tena.'
              : 'I could not prepare these records together. No new record was saved; please try again.');
            await audit(db, identity, waMessageId, 'daily_record_batch', 'create', 'failed');
            await finish('skipped', 'daily_record_batch_create_failed');
            continue;
          }
          const state: DailyRecordBatchConversation = {
            kind: 'daily_record_batch_confirmation',
            sourceMessageId: dailyBatchClarification.sourceMessageId ?? waMessageId,
            dailyRecordIds: created.ids,
            records: guardedRecords,
          };
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'payment_source',
            receipt_id: null,
            options: state,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await replyDailyRecordBatchConfirmationQuietly(phone, guardedRecords, lang, waMessageId);
          await audit(db, identity, waMessageId, 'daily_record_batch', 'create', 'pending');
          await finish('skipped');
          continue;
        }
        if (dailyClarification && !changedSubject) {
          const choice = parseDailyRecordPriceChoice(body);
          if (isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, lang === 'sw' ? 'Sawa. Ujumbe huu wa mauzo umeghairiwa.' : 'Okay. This sale draft was cancelled.');
            await audit(db, identity, waMessageId, 'daily_record', 'clarification_cancel', 'applied');
            await finish('skipped');
            continue;
          }
          if (choice) {
            const resumed = resumeDailyRecordClarification(dailyClarification, choice);
            if (resumed.kind === 'parsed') {
              const guardedRecord = await addHistoricalPriceWarnings(db, identity.company_id, resumed.record);
              const created = await createDailyRecordDraft(
                db,
                identity,
                dailyClarification.sourceMessageId ?? waMessageId,
                guardedRecord,
                lang,
              );
              if (created.error || !created.id) {
                await replyQuietly(phone, lang === 'sw'
                  ? 'Sikuweza kuhifadhi draft hii. Tafadhali jaribu tena.'
                  : 'I could not save this draft. Please try again.');
                await audit(db, identity, waMessageId, 'daily_record', 'clarification_create', 'failed');
                await finish('skipped', 'daily_record_create_failed');
                continue;
              }
              const state: DailyRecordConversation = {
                kind: 'daily_record_confirmation',
                dailyRecordId: created.id,
                sourceMessageId: dailyClarification.sourceMessageId ?? waMessageId,
                record: guardedRecord,
              };
              await db.from('whatsapp_conversations').upsert({
                identity_id: identity.id,
                company_id: identity.company_id,
                profile_id: identity.profile_id,
                awaiting: 'payment_source',
                receipt_id: null,
                options: state,
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                updated_at: new Date().toISOString(),
              }, { onConflict: 'identity_id' });
              await replyDailyRecordConfirmationQuietly(phone, guardedRecord, lang, waMessageId);
              await audit(db, identity, waMessageId, 'daily_record', 'clarification_resumed', 'pending');
              await finish('skipped');
              continue;
            }
          }
          await replyQuietly(phone, lang === 'sw'
            ? `Jibu *bei ya kila moja* au *jumla* ili niendelee na mauzo haya. ${pendingEscapeHint(lang)}`
            : `Reply *unit price* or *total* so I can continue this sale. ${pendingEscapeHint(lang)}`);
          await finish('skipped');
          continue;
        }
        if (dailyBatchConversation) {
          if (isDailyRecordConfirmation(body)) {
            const { error } = await db.rpc('wa_confirm_daily_record_batch', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_ids: dailyBatchConversation.dailyRecordIds,
            });
            if (!error) {
              await clearConversation(db, identity.id as string);
              await clearAssistantMemory(db, identity);
            }
            await replyQuietly(phone, error
              ? buildDailyRecordBatchPending(dailyBatchConversation.records, lang)
              : buildDailyRecordBatchConfirmed(dailyBatchConversation.records, lang));
            await audit(db, identity, waMessageId, 'daily_record_batch', 'confirm', error ? 'pending' : 'applied');
            await finish('skipped');
            continue;
          }
          if (isDailyRecordRejection(body)) {
            const { error } = await db.rpc('wa_cancel_daily_record_batch', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_ids: dailyBatchConversation.dailyRecordIds,
              p_reason: 'WhatsApp user declined daily record batch',
            });
            if (!error) {
              await clearConversation(db, identity.id as string);
              await clearAssistantMemory(db, identity);
            }
            await replyQuietly(phone, error
              ? buildDailyRecordBatchPending(dailyBatchConversation.records, lang)
              : (lang === 'sw' ? 'Sawa. Rekodi zote za ujumbe huu zimeghairiwa.' : 'Okay. All records from this message were cancelled.'));
            await audit(db, identity, waMessageId, 'daily_record_batch', 'cancel', error ? 'failed' : 'applied');
            await finish('skipped');
            continue;
          }
          await replyDailyRecordBatchConfirmationQuietly(phone, dailyBatchConversation.records, lang, waMessageId);
          await finish('skipped');
          continue;
        }
        if (dailyConversation) {
          // "cash" arriving on its own, while a draft is on the screen waiting
          // for NDIYO. It is an answer to the question being asked, not a new
          // message about nothing — and before this the fact was simply lost.
          //
          // The draft is updated and the SAME confirmation is shown again, so
          // nothing is saved a moment earlier than it would have been.
          // OUTAGE ONLY. The model reads "mpesa" now and returns it through
          // resolve_pending_clarification; this phrase list of Tanzanian
          // mobile-money brands runs when the model was never consulted.
          const answeredMethod = messageGoesToModel(convo, body, systemCommand)
            ? null
            : parsePaymentMethodAnswer(body);
          if (answeredMethod && !isDailyRecordConfirmation(body) && !isDailyRecordRejection(body)) {
            const { data: methodSet } = await db.rpc('wa_set_draft_payment_method', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_id: dailyConversation.dailyRecordId,
              p_payment_method: answeredMethod,
            });
            const applied = Boolean((methodSet as Record<string, unknown> | null)?.updated);
            if (applied) {
              const withMethod = { ...dailyConversation.record, paymentMethod: answeredMethod };
              dailyConversation = { ...dailyConversation, record: withMethod };
              await db.from('whatsapp_conversations').upsert({
                identity_id: identity.id,
                company_id: identity.company_id,
                profile_id: identity.profile_id,
                awaiting: 'payment_source',
                receipt_id: null,
                options: dailyConversation,
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                updated_at: new Date().toISOString(),
              }, { onConflict: 'identity_id' });
              await reply(phone, `${identity.company_name} — ${buildDailyRecordConfirmation(withMethod, lang)}`);
              await audit(db, identity, waMessageId, 'daily_record', 'payment_method', 'applied');
              await finish('applied');
              continue;
            }
          }
          if (isDailyRecordConfirmation(body)) {
            const { error } = await db.rpc('wa_confirm_daily_record', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_id: dailyConversation.dailyRecordId,
            });
            if (error) {
              await replyQuietly(phone, buildDailyRecordPending(dailyConversation.record, lang));
              await audit(db, identity, waMessageId, 'daily_record', 'confirm', 'pending');
            } else {
              await clearConversation(db, identity.id as string);
              await clearAssistantMemory(db, identity);
              // The warning rides on a message that was going out anyway. An
              // unprompted one costs money and interrupts; this one arrives at
              // the single moment the shopkeeper is certainly looking.
              // A reading worth remembering is offered AFTER the sale is safely
              // recorded, so saying no to it costs nothing. Finance only: a
              // worker who saved "zege = chips + kuku kilo" would misprice
              // every zege sold after it.
              const worthSaving = ((dailyConversation.combos ?? []) as ComboSplit[])
                .filter((split) => split?.source === 'split' && Array.isArray(split.pieces));
              const mayTeach = canUseCompanyFinanceReads(identity.role);
              await replyQuietly(phone, buildDailyRecordConfirmed(dailyConversation.record, lang)
                + await lowStockNoticeFor(db, identity, dailyConversation.record, lang)
                + (worthSaving.length === 0
                  ? ''
                  : mayTeach
                    ? worthSaving.map((split) => comboSaveOffer(split, lang)).join('')
                    : comboSaveNotAllowed(lang)));
              await audit(db, identity, waMessageId, 'daily_record', 'confirm', 'applied');
              if (worthSaving.length > 0 && mayTeach) {
                await db.from('whatsapp_conversations').upsert({
                  identity_id: identity.id,
                  company_id: identity.company_id,
                  profile_id: identity.profile_id,
                  awaiting: 'product_cost',
                  receipt_id: null,
                  options: { kind: 'combo_save', splits: worthSaving } satisfies ComboSavePending,
                  expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                  updated_at: new Date().toISOString(),
                }, { onConflict: 'identity_id' });
                await finish('skipped');
                continue;
              }
              // The record is safely saved first. Asking what the product costs
              // is a separate, optional favour — if any of it fails, the sale is
              // still recorded and the person is simply not asked.
              await askForBuyingPrice(db, identity, phone, dailyConversation.dailyRecordId, waMessageId, lang);
              // And, at most once a day, how to send the whole till roll at
              // once. It checks for a parked question first, so it can never
              // land on top of the cost prompt above.
              const hint = await batchHintFor(db, identity, lang);
              if (hint) await replyQuietly(phone, hint);
            }
            await finish('skipped');
            continue;
          }
          if (isDailyRecordRejection(body)) {
            const { error } = await db.rpc('wa_cancel_daily_record_draft', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_id: dailyConversation.dailyRecordId,
              p_reason: 'WhatsApp user declined daily record draft',
            });
            if (!error) {
              await clearConversation(db, identity.id as string);
              await clearAssistantMemory(db, identity);
            }
            await replyQuietly(phone, error
              ? buildDailyRecordPending(dailyConversation.record, lang)
              : buildDailyRecordCancelled(lang));
            await audit(db, identity, waMessageId, 'daily_record', 'cancel', error ? 'failed' : 'applied');
            await finish('skipped');
            continue;
          }
          await replyDailyRecordConfirmationQuietly(phone, dailyConversation.record, lang, waMessageId);
          await finish('skipped');
          continue;
        }

        // ── A buying price ──────────────────────────────────────────────
        // Before the daily-record parser, because "unga unanigharimu 900 kwa
        // kilo" contains a product and a number and would otherwise be read as
        // something that moved money. Nothing here moves money: it records what a
        // product costs, which is what makes the profit estimate possible at all.
        // An answer to a price question Risip itself asked. No NDIYO here: the
        // question was the confirmation, and asking "are you sure?" straight
        // after somebody answered a direct question is the robotic move.
        if (stockBatchPending && releasesParkedQuestion(body)) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'stockBatchPending', 'abandoned', 'skipped');
        } else if (stockBatchPending) {
          if (isDailyRecordConfirmation(body)) {
            const { data: saved, error } = await db.rpc('wa_record_stock_counts', {
              p_phone: phone,
              p_items: stockBatchPending.counts.map((c) => ({
                product: c.product, quantity: c.quantity, unit: c.unit,
              })),
            });
            await clearConversation(db, identity.id as string);
            const result = saved as { saved?: number; company_name?: string } | null;
            await replyQuietly(phone, error
              ? productCostErrorMessage(error, lang)
              : stockCountBatchSaved(result?.saved ?? stockBatchPending.counts.length, result?.company_name ?? '', lang));
            await audit(db, identity, waMessageId, 'stock_count_batch',
              String(stockBatchPending.counts.length), error ? 'failed' : 'applied');
          } else if (isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, stockCountBatchCancelled(lang));
            await audit(db, identity, waMessageId, 'stock_count_batch', 'cancel', 'applied');
          } else {
            await replyQuietly(phone, stockCountBatchConfirmation(stockBatchPending, lang));
            await audit(db, identity, waMessageId, 'stock_count_batch', 'reask', 'skipped');
          }
          await finish('skipped');
          continue;
        }

        // NDIYO on a whole selling-price list. All or nothing: a list half
        // applied leaves the shop believing it set prices it did not set, and
        // the assistant then quotes the old ones with complete confidence.
        // Answering which role the invite is for. The role is what the code
        // grants, so it is asked and never guessed — a wrong answer here hands
        // a counter hand the whole company's finances.
        // A pending question must yield when the person has plainly moved on.
        // MEASURED FAILURE: "change language to kiswahili" was answered by
        // asking "what will they be? Reply 1 or 2" a second time, because the
        // invite branch treated every message that was not a role as a bad
        // answer to its own question. Nobody escapes a question by answering it
        // correctly; they escape by talking about something else.
        if (invitePending && !isCancel(body) && !isDailyRecordRejection(body) && !parseInviteRole(body)) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'invite', 'abandoned', 'skipped');
        } else if (queuePending) {
          // The batch. One NDIYO puts every draft on the books; one HAPANA
          // drops them all and writes nothing. Anything else falls through to
          // the model, because a shopkeeper who answers a batch with another
          // sale is adding to it, not answering it.
          if (isDailyRecordConfirmation(body)) {
            const { data: saved, error } = await db.rpc('wa_confirm_daily_record_batch', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_ids: queuePending.ids,
            });
            await clearConversation(db, identity.id as string);
            if (error) {
              // Nothing was written, so say that rather than implying it was.
              await replyQuietly(phone, lang === 'sw'
                ? 'Sikuweza kuhifadhi sasa. Hakuna kilichoingia; jaribu tena baada ya muda mfupi.'
                : 'I could not save just now. Nothing was recorded; please try again shortly.');
              await audit(db, identity, waMessageId, 'record_queue', 'failed', 'failed');
              await finish('failed');
              continue;
            }
            const count = Number((saved as { saved?: number } | null)?.saved ?? queuePending.ids.length);
            await replyQuietly(phone, queueSavedReply(count, lang));
            await audit(db, identity, waMessageId, 'record_queue', String(count), 'applied');
            await finish('skipped');
            continue;
          }
          if (isDailyRecordRejection(body) || isPendingEscape(body)) {
            const { error } = await db.rpc('wa_cancel_daily_record_batch', {
              p_profile_id: identity.profile_id,
              p_company_id: identity.company_id,
              p_daily_record_ids: queuePending.ids,
            });
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, error
              ? (lang === 'sw'
                ? 'Sikuweza kuondoa rasimu hizo sasa. Hakuna kilichohifadhiwa.'
                : 'I could not drop those drafts just now. Nothing was saved.')
              : queueDiscardedReply(queuePending.ids.length, lang));
            await audit(db, identity, waMessageId, 'record_queue', 'discarded', error ? 'failed' : 'applied');
            await finish('skipped');
            continue;
          }
          // Not an answer. Leave the batch parked and let the model read it.
        } else if (voidPending) {
          if (isCancel(body) || isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, voidCancelled(lang));
            await audit(db, identity, waMessageId, 'void_record', 'cancel', 'applied');
            await finish('skipped');
            continue;
          }
          if (!isDailyRecordConfirmation(body)) {
            await replyQuietly(phone, voidConfirmation(voidPending.target, lang));
            await audit(db, identity, waMessageId, 'void_record', 'reask', 'skipped');
            await finish('skipped');
            continue;
          }
          await clearConversation(db, identity.id as string);
          const { data: voided, error: voidError } = await db.rpc('wa_void_daily_record', {
            p_phone: phone,
            p_daily_record_id: voidPending.target.id,
            p_reason: 'Imeondolewa na mwenye biashara kupitia WhatsApp',
          });
          const done = (voided ?? {}) as Record<string, unknown>;
          if (voidError || done.voided !== true) {
            await replyQuietly(phone, voidError
              ? productCostErrorMessage(voidError, lang)
              : voidNothingFound(lang));
            await audit(db, identity, waMessageId, 'void_record', 'failed', 'failed');
            await finish('skipped');
            continue;
          }
          await replyQuietly(phone, voidDone(voidPending.target, lang));
          await audit(db, identity, waMessageId, 'void_record', String(done.kind ?? 'record'), 'applied');
          await finish('skipped');
          continue;
        } else if (invitePending) {
          if (isCancel(body) || isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, inviteCancelled(lang));
            await audit(db, identity, waMessageId, 'invite', 'cancel', 'applied');
            await finish('skipped');
            continue;
          }
          const role = parseInviteRole(body);
          if (!role) {
            await replyQuietly(phone, inviteRoleQuestion(lang));
            await audit(db, identity, waMessageId, 'invite', 'reask', 'skipped');
            await finish('skipped');
            continue;
          }
          const { data: made, error } = await db.rpc('wa_create_invite_code', {
            // Three days, not seven. An invite nobody used in three days was
            // not meant, and a live code sitting in somebody chat history is a
            // way into a shop ledger.
            p_phone: phone, p_role: role, p_days: 3,
          });
          await clearConversation(db, identity.id as string);
          if (error) {
            const hint = (error as { hint?: string } | null)?.hint;
            await replyQuietly(phone, hint === 'not_authorized'
              ? inviteNotAllowed(lang)
              : productCostErrorMessage(error, lang));
            await audit(db, identity, waMessageId, 'invite', role, 'failed');
            await finish('skipped');
            continue;
          }
          const result = made as { code?: string; company_name?: string } | null;
          const inviteCode = String(result?.code ?? '');
          const inviteBusiness = result?.company_name ?? '';
          const risipNumber = await whatsAppDisplayNumber();
          await replyQuietly(phone, inviteReady(
            inviteCode, role, lang,
          ));
          await replyQuietly(phone, inviteForwardMessage(
            inviteCode, inviteBusiness, risipNumber, lang,
          ));
          await audit(db, identity, waMessageId, 'invite', role, 'applied');
          await finish('skipped');
          continue;
        }

        if (productRenamePending && !isDailyRecordConfirmation(body) && !isDailyRecordRejection(body) && !isCancel(body)) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'product_rename', 'abandoned', 'skipped');
        } else if (productRenamePending) {
          if (isDailyRecordConfirmation(body)) {
            const { error } = await db.rpc('wa_rename_product', {
              p_phone: phone,
              p_from: productRenamePending.from,
              p_to: productRenamePending.to,
              p_reason: 'Confirmed through WhatsApp',
            });
            await clearConversation(db, identity.id as string);
            await reply(phone, error ? productCostErrorMessage(error, lang) : productRenameSaved(productRenamePending, lang));
            await audit(db, identity, waMessageId, 'product_rename', 'confirm', error ? 'failed' : 'applied');
          } else if (isDailyRecordRejection(body) || isCancel(body)) {
            await clearConversation(db, identity.id as string);
            await reply(phone, productRenameCancelled(lang));
            await audit(db, identity, waMessageId, 'product_rename', 'cancel', 'applied');
          } else {
            await reply(phone, productRenameConfirmation(productRenamePending, lang));
            await audit(db, identity, waMessageId, 'product_rename', 'reask', 'skipped');
          }
          await finish('skipped');
          continue;
        }

        // A portion setup is two-stage because words such as "robo" do not say
        // what they are a fraction of. The trader states every conversion, sees
        // the cost/margin arithmetic, and only NDIYO writes the transaction.
        if (portionSizePending && !isCancel(body) && !isDailyRecordRejection(body) && !resumePortionSetup(portionSizePending, body)) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'portion_setup', 'abandoned', 'skipped');
        } else if (portionSizePending) {
          if (isCancel(body) || isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, portionSetupCancelled(lang));
            await audit(db, identity, waMessageId, 'portion_setup', 'cancel', 'applied');
            await finish('skipped');
            continue;
          }
          const resumed = resumePortionSetup(portionSizePending, body);
          if (resumed.kind === 'ready') {
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'product_cost',
              receipt_id: null,
              options: resumed.setup,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await replyQuietly(phone, portionSetupConfirmation(resumed.setup, lang));
            await audit(db, identity, waMessageId, 'portion_setup', 'sizes', 'pending');
          } else {
            const missing = resumed.kind === 'missing'
              ? (lang === 'sw'
                ? `Bado sijapata ukubwa wa: ${resumed.units.join(', ')}.\n\n`
                : `I still need the size of: ${resumed.units.join(', ')}.\n\n`)
              : '';
            await replyQuietly(phone, missing + portionSizeQuestion(portionSizePending, lang));
            await audit(db, identity, waMessageId, 'portion_setup', 'sizes', 'clarification');
          }
          await finish('skipped');
          continue;
        }

        if (portionConfirmPending && !isDailyRecordConfirmation(body) && !isDailyRecordRejection(body) && !isCancel(body)) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'portion_setup', 'abandoned', 'skipped');
        } else if (portionConfirmPending) {
          if (isDailyRecordConfirmation(body)) {
            const { error } = await db.rpc('wa_configure_product_units', {
              p_phone: phone,
              p_name: portionConfirmPending.product,
              p_base_unit: portionConfirmPending.baseUnit,
              p_purchase_unit: portionConfirmPending.purchaseUnit,
              p_purchase_size: portionConfirmPending.purchaseSize,
              p_purchase_cost: portionConfirmPending.purchaseCost,
              p_sale_units: portionConfirmPending.saleUnits.map((item) => ({
                unit: item.unit,
                base_quantity: item.baseQuantity,
                retail: item.retail,
                wholesale: item.wholesale,
                min_qty: item.minQty,
              })),
            });
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, error
              ? productCostErrorMessage(error, lang)
              : portionSetupSaved(portionConfirmPending, lang));
            await audit(db, identity, waMessageId, 'portion_setup', 'confirm', error ? 'failed' : 'applied');
          } else if (isCancel(body) || isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, portionSetupCancelled(lang));
            await audit(db, identity, waMessageId, 'portion_setup', 'cancel', 'applied');
          } else {
            await replyQuietly(phone, portionSetupConfirmation(portionConfirmPending, lang));
            await audit(db, identity, waMessageId, 'portion_setup', 'reask', 'skipped');
          }
          await finish('skipped');
          continue;
        }

        if (newProductSaleSetup && (isDailyRecordRejection(body) || isCancel(body))) {
          await clearConversation(db, identity.id as string);
          await replyQuietly(phone, newProductCancelled(lang));
          await audit(db, identity, waMessageId, 'new_product_sale_setup', 'cancel', 'applied');
          await finish('skipped');
          continue;
        }

        if (newProductOfferSetup && (isDailyRecordRejection(body) || isCancel(body))) {
          await clearConversation(db, identity.id as string);
          await replyQuietly(phone, newProductCancelled(lang));
          await audit(db, identity, waMessageId, 'new_product_offer_setup', 'cancel', 'applied');
          await finish('skipped');
          continue;
        }

        if (newProductOfferSetup && wantsToRegisterNewProducts(body)) {
          await replyQuietly(phone, newProductOffer(newProductOfferSetup.missingProducts, lang));
          await audit(db, identity, waMessageId, 'new_product_offer_setup', 'prices_requested', 'clarification');
          await finish('skipped');
          continue;
        }

        if (newProductQuantityPending && (isDailyRecordRejection(body) || isCancel(body))) {
          await clearConversation(db, identity.id as string);
          await replyQuietly(phone, newProductCancelled(lang));
          await audit(db, identity, waMessageId, 'new_product_quantity', 'cancel', 'applied');
          await finish('skipped');
          continue;
        }

        // A bare number is a legitimate answer when one product is pending;
        // it is a protocol answer, so the normal router does not send it to
        // the model. Keep that short, safe path, while natural sentences such
        // as "vest vipande kumi" still go through the AI clarification tool.
        if (newProductQuantityPending) {
          const simple = newProductQuantityPending.products.length === 1
            ? parseQuantityAnswer(body)
            : null;
          const numericList = parseNewProductNumericList(body, newProductQuantityPending.products);
          const values = simple
            ? [{ field: 'quantity', raw_wording: body, canonical_value: null, numeric_value: simple.quantity }]
            : numericList?.map((quantity, index) => ({
              field: 'quantity',
              raw_wording: newProductQuantityPending.products[index].product,
              canonical_value: null,
              numeric_value: quantity,
            }));
          if (values) {
            const result = await executeClarification(db, identity, waMessageId, lang, { answers: values }, body);
            await replyQuietly(phone, result.content);
            await audit(db, identity, waMessageId, 'new_product_quantity', 'numeric_answer', result.isError ? 'failed' : 'pending');
            await finish('skipped');
            continue;
          }
        }

        if (newProductRegistrationPending) {
          if (isDailyRecordConfirmation(body)) {
            const pendingProducts = newProductRegistrationPending.products;
            const stock = newProductRegistrationPending.stock;
            const { error: costError } = await db.rpc('wa_set_product_costs', {
              p_phone: phone,
              p_items: pendingProducts.map((product, index) => ({
                product: product.product,
                unit_cost: product.unitCost,
                unit: stock[index]?.unit ?? product.unit,
              })),
            });
            const { error: priceError } = costError ? { error: null } : await db.rpc('wa_set_selling_prices', {
              p_phone: phone,
              p_items: pendingProducts.map((product) => ({
                product: product.product,
                retail: product.retail,
                wholesale: product.wholesale,
                min_qty: product.wholesaleMinQty,
              })),
            });
            const { error: stockError } = costError || priceError ? { error: null } : await db.rpc('wa_record_stock_counts', {
              p_phone: phone,
              p_items: stock.map((item) => ({
                product: item.product, quantity: item.quantity, unit: item.unit,
              })),
            });
            const failed = costError ?? priceError ?? stockError;
            if (failed) {
              // Keep the preview available on failure. No confirmation was
              // claimed, and the owner can retry without retyping prices or
              // quantities. The RPCs themselves are all-or-nothing batches.
              await replyQuietly(phone, `${productCostErrorMessage(failed, lang)}\n\n`
                + newProductRegistrationConfirmation(pendingProducts, stock, lang));
              await audit(db, identity, waMessageId, 'new_product_registration', 'confirm', 'failed');
            } else {
              const pendingSale = newProductRegistrationPending.pendingSale;
              if (pendingSale) {
                const resumed = await resumeSaleAfterNewProductRegistration(
                  db,
                  identity,
                  waMessageId,
                  lang,
                  pendingProducts,
                  pendingSale,
                  newProductRegistrationPending.sourceMessageId,
                  newProductRegistrationPending.pendingDirection,
                  newProductRegistrationPending.credit ?? null,
                  newProductRegistrationPending.paymentMethod ?? null,
                  newProductRegistrationPending.occurredAt ?? null,
                );
                await replyQuietly(phone, resumed.message);
                await audit(db, identity, waMessageId, 'new_product_registration',
                  'resume_sale', resumed.conversationKept ? 'pending' : 'applied');
              } else {
                await clearConversation(db, identity.id as string);
                await replyQuietly(phone, newProductSaved(pendingProducts, lang));
              }
              await audit(db, identity, waMessageId, 'new_product_registration', String(pendingProducts.length), 'applied');
            }
          } else if (isDailyRecordRejection(body) || isCancel(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, newProductCancelled(lang));
            await audit(db, identity, waMessageId, 'new_product_registration', 'cancel', 'applied');
          } else {
            await replyQuietly(phone, newProductRegistrationConfirmation(
              newProductRegistrationPending.products,
              newProductRegistrationPending.stock,
              lang,
            ));
            await audit(db, identity, waMessageId, 'new_product_registration', 'reask', 'skipped');
          }
          await finish('skipped');
          continue;
        }

        // NDIYO on a set of brand-new products. The cost and both selling prices
        // land together, because a product added with only one of them fails the
        // next sale in exactly the way that started this.
        if (newProductPending && releasesParkedQuestion(body)) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'newProductPending', 'abandoned', 'skipped');
        } else if (newProductPending) {
          const pendingProducts = newProductPending.products;
          if (isDailyRecordConfirmation(body)) {
            // Prices are not saved yet. First collect opening stock so a newly
            // registered product can never enter the catalogue with an
            // unknown quantity. The next answer is read by the AI with this
            // exact product list in its pending context.
            const quantityState: NewProductQuantityState = {
              ...newProductPending,
              kind: 'new_product_quantity',
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'product_cost',
              receipt_id: null,
              options: quantityState,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await replyQuietly(phone, newProductQuantityQuestion(pendingProducts, lang));
            await audit(db, identity, waMessageId, 'new_product_quantity', 'question', 'clarification');
          } else if (isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, newProductCancelled(lang));
            await audit(db, identity, waMessageId, 'new_product', 'cancel', 'applied');
          } else {
            await replyQuietly(phone, newProductConfirmation(pendingProducts, lang));
            await audit(db, identity, waMessageId, 'new_product', 'reask', 'skipped');
          }
          await finish('skipped');
          continue;
        }

        if (priceAndCostPending?.clarification && releasesParkedQuestion(body)) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'price_and_cost_pending', 'clarification_abandoned', 'skipped');
        } else if (priceAndCostPending?.clarification && isDailyRecordRejection(body)) {
          await clearConversation(db, identity.id as string);
          await replyQuietly(phone, sellingPriceBatchCancelled(lang));
          await audit(db, identity, waMessageId, 'price_and_cost_pending', 'clarification_cancel', 'applied');
        } else if (priceAndCostPending?.clarification) {
          const clarification = priceAndCostPending.clarification;
          let selectedProduct = clarification.productCandidates.length > 0
            ? chooseClarificationValue(body, clarification.productCandidates)
            : null;
          if (clarification.productCandidates.length > 0 && !selectedProduct) {
            const ask = priceAndCostClarificationText(clarification, lang);
            await replyQuietly(phone, ask);
            await audit(db, identity, waMessageId, 'price_and_cost_pending', 'clarification_reask', 'skipped');
          } else if (clarification.productCandidates.length === 0 && isSemanticallyAmbiguousProduct(clarification.product)) {
            // There is no safe mapping from “ya kupikia” to a catalogue item
            // that does not exist yet. Ask for the complete qualified product
            // line instead of silently turning a generic noun into a new item.
            const looksLikeQualifiedAnswer = normalizedChoice(body) !== normalizedChoice(clarification.product)
              && body.trim().length > clarification.product.length;
            const ask = looksLikeQualifiedAnswer
              ? (lang === 'sw'
                ? 'Sawa. Sasa tuma ujumbe mzima wa bei kwa jina kamili la bidhaa na kipimo, kwa mfano: “mafuta ya kupikia nimenunua kwa 5000 kwa ndoo, uza kwa 8000”.'
                : 'Okay. Now resend the complete price message with the exact product name and unit, for example: “cooking oil costs 5000 per bucket and sells for 8000”.')
              : priceAndCostClarificationText(clarification, lang);
            if (looksLikeQualifiedAnswer) await clearConversation(db, identity.id as string);
            await replyQuietly(phone, ask);
            await audit(db, identity, waMessageId, 'price_and_cost_pending', 'clarification_reask', 'skipped');
          } else {
            const oldProduct = clarification.product;
            const product = selectedProduct ?? oldProduct;
            const refreshedUnits = clarification.productCandidates.length > 0
              ? (await purchaseUnitsForProducts(db, identity)).get(productKey(product)) ?? []
              : clarification.unitOptions;
            const unit = refreshedUnits.length > 0
              ? chooseClarificationValue(body, refreshedUnits)
              : null;
            if (clarification.productCandidates.length > 0 && refreshedUnits.length > 0) {
              // Product selection is the first question; keep the unit question
              // for the next message so one answer cannot be applied twice.
              const next: PriceAndCostPending = {
                ...priceAndCostPending,
                prices: priceAndCostPending.prices.map((price) => productKey(price.product) === productKey(oldProduct)
                  ? { ...price, product } : price),
                costs: priceAndCostPending.costs.map((cost) => productKey(cost.product) === productKey(oldProduct)
                  ? { ...cost, product } : cost),
                clarification: { reason: 'purchase_unit', product, unitOptions: refreshedUnits, productCandidates: [] },
              };
              await db.from('whatsapp_conversations').update({
                options: next,
                updated_at: new Date().toISOString(),
              }).eq('identity_id', identity.id);
              const ask = unitChoiceQuestion(product, clarification.unitOptions, lang);
              await replyQuietly(phone, ask);
              await audit(db, identity, waMessageId, 'price_and_cost_pending', 'product_clarified', 'skipped');
            } else if (refreshedUnits.length > 0 && !unit) {
              const ask = unitChoiceQuestion(product, refreshedUnits, lang);
              await replyQuietly(phone, ask);
              await audit(db, identity, waMessageId, 'price_and_cost_pending', 'unit_clarification_reask', 'skipped');
            } else {
              const resolved: PriceAndCostPending = {
                ...priceAndCostPending,
                prices: priceAndCostPending.prices.map((price) => productKey(price.product) === productKey(oldProduct)
                  ? { ...price, product } : price),
                costs: priceAndCostPending.costs.map((cost) => productKey(cost.product) === productKey(oldProduct)
                  ? { ...cost, product, unit: unit ?? cost.unit } : cost),
                clarification: undefined,
              };
              await db.from('whatsapp_conversations').update({
                options: resolved,
                updated_at: new Date().toISOString(),
              }).eq('identity_id', identity.id);
              const ask = priceAndCostConfirmation(resolved, lang);
              await replyQuietly(phone, ask);
              await audit(db, identity, waMessageId, 'price_and_cost_pending', 'clarification_resolved', 'skipped');
            }
          }
        } else if (priceAndCostPending && releasesParkedQuestion(body)) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'price_and_cost_pending', 'abandoned', 'skipped');
        } else if (priceAndCostPending) {
          if (isDailyRecordConfirmation(body)) {
            // The model's mixed message is one business decision. Re-read and
            // validate both lists at the write boundary, then use the existing
            // audited RPCs; neither side is ever inferred from the other.
            const { data: savedCosts, error: costError } = await db.rpc('wa_set_product_costs', {
              p_phone: phone,
              p_items: priceAndCostPending.costs.map((cost) => ({
                product: cost.product, unit_cost: cost.unitCost, unit: cost.unit,
              })),
            });
            if (costError) {
              // Selling prices are already committed by the existing RPC. Keep
              // the response explicit so the owner knows which half needs
              // retrying; never claim the complete mixed draft was saved.
              await replyQuietly(phone, productCostErrorMessage(costError, lang));
              await audit(db, identity, waMessageId, 'price_and_cost_pending', 'failed_costs', 'failed');
              await finish('failed');
              continue;
            }
            const { error: priceError } = await db.rpc('wa_set_selling_prices', {
              p_phone: phone,
              p_items: priceAndCostPending.prices.map((price) => ({
                product: price.product,
                retail: price.retail,
                wholesale: price.wholesale,
                min_qty: price.minQty,
              })),
            });
            if (priceError) {
              // The costs have already been committed. Remove only that half
              // from the retry draft so pressing 1 again cannot duplicate the
              // successful cost write; the prices remain pending.
              await db.from('whatsapp_conversations').update({
                options: { ...priceAndCostPending, costs: [] },
                updated_at: new Date().toISOString(),
              }).eq('identity_id', identity.id);
              await replyQuietly(phone, productCostErrorMessage(priceError, lang));
              await audit(db, identity, waMessageId, 'price_and_cost_pending', 'failed_prices', 'failed');
              await finish('failed');
              continue;
            }
            await clearConversation(db, identity.id as string);
            const saved = (savedCosts ?? null) as { saved?: number; company_name?: string } | null;
            await replyQuietly(phone, lang === 'sw'
              ? `✅ Nimehifadhi bei za kuuza ${priceAndCostPending.prices.length} na bei za kununua ${saved?.saved ?? priceAndCostPending.costs.length}.`
              : `✅ Saved ${priceAndCostPending.prices.length} selling prices and ${saved?.saved ?? priceAndCostPending.costs.length} buying costs.`);
            await audit(db, identity, waMessageId, 'price_and_cost_pending', 'applied',
              `${priceAndCostPending.prices.length}+${priceAndCostPending.costs.length}`);
          } else if (isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, sellingPriceBatchCancelled(lang));
            await audit(db, identity, waMessageId, 'price_and_cost_pending', 'cancel', 'applied');
          } else {
            const batch: SellingPriceBatch = {
              kind: 'selling_price_batch',
              prices: priceAndCostPending.prices,
              unreadable: priceAndCostPending.unreadable,
            };
            await replyQuietly(phone, sellingPriceBatchConfirmation(batch, lang));
            await audit(db, identity, waMessageId, 'price_and_cost_pending', 'reask', 'skipped');
          }
          await finish('skipped');
          continue;
        }

        if (sellingBatchPending && releasesParkedQuestion(body)) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'sellingBatchPending', 'abandoned', 'skipped');
        } else if (sellingBatchPending) {
          if (isDailyRecordConfirmation(body)) {
            const { data: saved, error } = await db.rpc('wa_set_selling_prices', {
              p_phone: phone,
              p_items: sellingBatchPending.prices.map((price) => ({
                product: price.product,
                retail: price.retail,
                wholesale: price.wholesale,
                min_qty: price.minQty,
              })),
            });
            await clearConversation(db, identity.id as string);
            const result = saved as { saved?: number; company_name?: string } | null;
            await replyQuietly(phone, error
              ? productCostErrorMessage(error, lang)
              : sellingPriceBatchSaved(
                result?.saved ?? sellingBatchPending.prices.length, result?.company_name ?? '', lang));
            await audit(db, identity, waMessageId, 'selling_price_batch',
              String(sellingBatchPending.prices.length), error ? 'failed' : 'applied');
          } else if (isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, sellingPriceBatchCancelled(lang));
            await audit(db, identity, waMessageId, 'selling_price_batch', 'cancel', 'applied');
          } else {
            await replyQuietly(phone, sellingPriceBatchConfirmation(sellingBatchPending, lang));
            await audit(db, identity, waMessageId, 'selling_price_batch', 'reask', 'skipped');
          }
          await finish('skipped');
          continue;
        }

        // NDIYO on a whole price list. One transaction, so a half-applied list
        // can never leave the coverage figure reporting a number nobody chose.
        if (costBatchPending && releasesParkedQuestion(body)) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, 'costBatchPending', 'abandoned', 'skipped');
        } else if (costBatchPending) {
          if (isDailyRecordConfirmation(body)) {
            const { data: saved, error } = await db.rpc('wa_set_product_costs', {
              p_phone: phone,
              p_items: costBatchPending.costs.map((cost) => ({
                product: cost.product, unit_cost: cost.unitCost, unit: cost.unit,
              })),
            });
            await clearConversation(db, identity.id as string);
            const result = saved as { saved?: number; company_name?: string } | null;
            await replyQuietly(phone, error
              ? (productCostErrorMessage(error, lang) || costBatchFailed(lang))
              : costBatchSaved(result?.saved ?? costBatchPending.costs.length, result?.company_name ?? '', lang));
            await audit(db, identity, waMessageId, 'product_cost_batch',
              String(costBatchPending.costs.length), error ? 'failed' : 'applied');
          } else if (isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, costBatchCancelled(lang));
            await audit(db, identity, waMessageId, 'product_cost_batch', 'cancel', 'applied');
          } else {
            await replyQuietly(phone, costBatchConfirmation(costBatchPending, lang));
            await audit(db, identity, waMessageId, 'product_cost_batch', 'reask', 'skipped');
          }
          await finish('skipped');
          continue;
        }

        // THE DAY, waiting to be closed. Parked by propose_day_close; answered
        // here so the write happens on the shopkeeper's word, never the
        // model's. A rejection clears the draft and changes nothing — the
        // records stay exactly as they were.
        if (convo?.awaiting === 'day_close') {
          if (isPendingEscape(body) || isCancel(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, lang === 'sw'
              ? 'Sawa, sijafunga siku. Miamala yako yote ipo pale pale.'
              : 'Fine, I have not closed the day. All your records are exactly as they were.');
            await audit(db, identity, waMessageId, 'day_close', 'cancelled', null);
            await finish('cancelled');
            continue;
          }
          if (isConfirm(body)) {
            const facts = await buildDayCloseFacts(db, identity, lang);
            const workerLabel = facts.workers.length === 1
              ? facts.workers[0].name
              : (lang === 'sw' ? `Watu ${facts.workers.length}` : `${facts.workers.length} people`);
            const { data: closed, error: closeError } = await db.rpc('wa_close_business_day', {
              p_company_id: identity.company_id,
              p_profile_id: identity.profile_id,
              p_business_date: facts.businessDate,
              p_sales: facts.sales,
              p_cogs: facts.cogs,
              p_profit: facts.profit,
              p_purchases: facts.purchases,
              p_new_debt: facts.newDebt,
              p_debt_paid: facts.debtPaid,
              p_record_count: facts.recordCount,
              p_worker_count: facts.workers.length,
              p_worker_label: workerLabel,
            });
            await clearConversation(db, identity.id as string);
            if (closeError) {
              // The ledger is untouched, so say so rather than implying a save.
              await replyQuietly(phone, lang === 'sw'
                ? 'Sikuweza kufunga siku sasa. Miamala yako yote ipo salama — jaribu tena baada ya muda mfupi.'
                : 'I could not close the day just now. All your records are safe — please try again shortly.');
              await audit(db, identity, waMessageId, 'day_close', 'failed', null);
              await finish('failed');
              continue;
            }
            const alreadyClosed = Boolean((closed as Record<string, unknown> | null)?.already_closed);
            await replyQuietly(phone, alreadyClosed
              ? (lang === 'sw'
                ? `Siku ya ${facts.dateLabel} tayari ilikuwa imefungwa.`
                : `${facts.dateLabel} had already been closed.`)
              : dayClosedReply(facts, shopClock(new Date(), lang), lang));
            await audit(db, identity, waMessageId, 'day_close',
              alreadyClosed ? 'duplicate' : 'closed', facts.businessDate);
            await finish(alreadyClosed ? 'duplicate' : 'closed');
            continue;
          }
          // Anything else is a correction — "sodaa 2 zimebaki". Fall through so
          // the model reads it as a normal message; the draft stays parked and
          // the trader can say nafunga again once it is right.
        }

        if (costPrompt) {
          if (isSkip(body)) {
            await db.rpc('wa_skip_cost_prompt', { p_phone: phone, p_product: costPrompt.product });
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, costSkipped(lang));
            await audit(db, identity, waMessageId, 'product_cost', 'skipped', costPrompt.productKey);
            await finish('skipped');
            continue;
          }
          const answered = parseCostAnswer(body);
          if (answered === null) {
            // Not a price and not a skip. Almost always a new instruction, so
            // the question is dropped rather than held over the conversation.
            await clearConversation(db, identity.id as string);
            await db.rpc('wa_skip_cost_prompt', { p_phone: phone, p_product: costPrompt.product });
            await replyQuietly(phone, costUnclear(costPrompt, lang));
            await audit(db, identity, waMessageId, 'product_cost', 'unclear', costPrompt.productKey);
            await finish('skipped');
            continue;
          }
          const { error } = await db.rpc('wa_set_product_cost', {
            p_phone: phone, p_name: costPrompt.product, p_unit_cost: answered, p_unit: null,
          });
          await clearConversation(db, identity.id as string);
          await replyQuietly(phone, error
            ? productCostErrorMessage(error, lang)
            : costAccepted(costPrompt, answered, lang));
          await audit(db, identity, waMessageId, 'product_cost', costPrompt.productKey, error ? 'failed' : 'applied');
          await finish('skipped');
          continue;
        }

        if (costConversation) {
          const pending = costConversation.cost;
          if (isDailyRecordConfirmation(body)) {
            const { data: saved, error } = await db.rpc('wa_set_product_cost', {
              p_phone: phone, p_name: pending.product,
              p_unit_cost: pending.unitCost, p_unit: pending.unit,
            });
            await clearConversation(db, identity.id as string);
            const business = (saved as { company_name?: string } | null)?.company_name ?? '';
            await replyQuietly(phone, error ? productCostErrorMessage(error, lang) : costSaved(pending, business, lang));
            await audit(db, identity, waMessageId, 'product_cost', pending.product, error ? 'failed' : 'applied');
            await finish('skipped');
            continue;
          }
          if (isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await replyQuietly(phone, lang === 'sw' ? 'Sawa, sijaandika.' : 'Fine, nothing saved.');
            await audit(db, identity, waMessageId, 'product_cost', pending.product, 'cancelled');
            await finish('skipped');
            continue;
          }
        }

        // “Naongeza bidhaa” is a real start to a task, not a malformed product
        // sentence. Keep the two missing fields as explicit state so the user can
        // answer naturally: first the name, then the buying cost. A clear change
        // of subject releases the prompt instead of trapping the chat.
        if (addProductSetupPending) {
          if (isCancel(body) || isDailyRecordRejection(body)) {
            await clearConversation(db, identity.id as string);
            await clearAssistantMemory(db, identity);
            await replyQuietly(phone, lang === 'sw' ? 'Sawa, sijaongeza bidhaa.' : 'Okay, I did not add a product.');
            await audit(db, identity, waMessageId, 'add_product', 'guided_cancel', 'applied');
            await finish('skipped');
            continue;
          }

          if (addProductSetupPending.step === 'name') {
            if (isAddProductStart(body)) {
              await replyQuietly(phone, addProductNameQuestion(lang));
              await audit(db, identity, waMessageId, 'add_product', 'name_reask', 'clarification');
              await finish('skipped');
              continue;
            }
            // A parked question releases unless the message ANSWERS it. Asking
            // "is this another topic?" here meant a correction that named no
            // parseable product simply got the same question again.
            if (!parseAddProductName(body)) {
              await clearConversation(db, identity.id as string);
              await clearAssistantMemory(db, identity);
              await audit(db, identity, waMessageId, 'add_product', 'guided_abandoned', 'skipped');
              convo = null;
            } else {
              const product = parseAddProductName(body);
              if (!product) {
                await replyQuietly(phone, addProductNameQuestion(lang));
                await audit(db, identity, waMessageId, 'add_product', 'name_reask', 'clarification');
                await finish('skipped');
                continue;
              }
              await db.from('whatsapp_conversations').upsert({
                identity_id: identity.id,
                company_id: identity.company_id,
                profile_id: identity.profile_id,
                awaiting: 'product_cost',
                receipt_id: null,
                options: { kind: 'add_product_setup', step: 'cost', product },
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                updated_at: new Date().toISOString(),
              }, { onConflict: 'identity_id' });
              await replyQuietly(phone, lang === 'sw'
                ? `Unainunua “${product}” kwa bei gani? Jibu kiasi, kwa mfano: *10,000 kwa kilo*. ${pendingEscapeHint(lang)}`
                : `What do you pay for “${product}”? Reply with the amount, for example: *10,000 per kilo*. ${pendingEscapeHint(lang)}`);
              await audit(db, identity, waMessageId, 'add_product', 'cost_asked', 'clarification');
              await finish('skipped');
              continue;
            }
          } else if (addProductSetupPending.product) {
            const unitMatch = /\b(?:kwa|per)\s+(kilo|kg|gramu|lita|litre|ml|mita|futi|gunia|debe|ndoo|pakiti|boksi|rimu|dazeni|kipande|pcs)\b/iu.exec(body ?? '');
            const answerWithoutUnit = unitMatch
              ? `${(body ?? '').slice(0, unitMatch.index)} ${(body ?? '').slice(unitMatch.index + unitMatch[0].length)}`.trim()
              : body;
            const answered = parseCostAnswer(answerWithoutUnit);
            if (answered === null) {
              // Not the cost we asked for, so not the answer. Release it.
              if (true) {
                await clearConversation(db, identity.id as string);
                await clearAssistantMemory(db, identity);
                await audit(db, identity, waMessageId, 'add_product', 'guided_abandoned', 'skipped');
                convo = null;
              } else {
                await replyQuietly(phone, lang === 'sw'
                  ? `Sijapata bei ya kununua “${addProductSetupPending.product}”. Jibu kiasi, kwa mfano: *10,000 kwa kilo*. ${pendingEscapeHint(lang)}`
                  : `I did not get the buying cost for “${addProductSetupPending.product}”. Reply with an amount, for example: *10,000 per kilo*. ${pendingEscapeHint(lang)}`);
                await audit(db, identity, waMessageId, 'add_product', 'cost_reask', 'clarification');
                await finish('skipped');
                continue;
              }
            } else {
              const unit = unitMatch?.[1] ?? null;
              writeBody = `ongeza bidhaa ${addProductSetupPending.product} bei ya kununua ${answered}${unit ? ` kwa ${unit}` : ''}`;
              await clearConversation(db, identity.id as string);
              await clearAssistantMemory(db, identity);
              convo = null;
            }
          }
        }

        // A verification code, typed out. The last resort when the square will
        // not read: measured against a real close-up, ninety preprocessing
        // combinations failed on it — blur plus TRA's watermark over the finder
        // patterns is past what a decoder can recover. Twelve characters printed
        // in plain text above that square work every time.
        //
        // Still verified, never trusted: the typed code goes to TRA with the
        // receipt's own printed time, and only TRA's answer changes anything.
        const typedCode = parseTypedVerificationCode(body);
        if (typedCode) {
          const { data: pending } = await db
            .from('receipts')
            .select('id, vendor_name, total_amount, receipt_time, verification_code')
            .eq('company_id', identity.company_id)
            .eq('uploaded_by', identity.profile_id)
            .eq('tra_status', 'not_found')
            .not('receipt_time', 'is', null)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (pending) {
            const row = pending as Record<string, any>;
            const lookup = await fetchTraReceipt(typedCode, String(row.receipt_time));
            if (lookup.ok) {
              const official = lookup.receipt;
              const differences = compareWithTra({
                vendorName: row.vendor_name,
                totalInclTax: row.total_amount === null ? null : Number(row.total_amount),
                verificationCode: row.verification_code,
              }, official);
              await db.from('receipts').update({
                vendor_name: official.vendorName ?? row.vendor_name,
                vendor_tin: official.vendorTin ?? undefined,
                vendor_vrn: official.vendorVrn ?? undefined,
                receipt_number: official.receiptNumber ?? undefined,
                receipt_date: official.receiptDate ?? undefined,
                total_amount: official.totalInclTax ?? undefined,
                tax_amount: official.totalTax ?? undefined,
                verification_code: official.verificationCode ?? typedCode,
                tra_status: 'verified',
                tra_verified_at: new Date().toISOString(),
                tra_differences: differences.length ? differences : null,
              }).eq('id', row.id);
              await replyQuietly(phone, qrCorrectionReply(
                { vendorName: row.vendor_name, total: row.total_amount === null ? null : Number(row.total_amount) },
                official, lang, `${appUrl()}/receipts?receipt=${row.id}`,
              ));
              await audit(db, identity, waMessageId, 'tra_verify', 'typed_code', 'applied');
            } else {
              // Naming the look-alike characters is the useful part: these codes
              // are read off thermal paper, where 0/O and 1/I are a coin toss.
              await replyQuietly(phone, typedCodeRejected(typedCode, lang));
              await audit(db, identity, waMessageId, 'tra_verify', 'typed_code', 'not_found');
            }
            await finish('skipped');
            continue;
          }

          // A code with nothing to attach it to. Falling through sent it to the
          // assistant, which answered "sijaelewa unachomaanisha" to a perfectly
          // clear message — the worst possible reply, because the person did
          // exactly what they were asked to do.
          await replyQuietly(phone, lang === 'sw'
            ? `Nimepokea kodi ${typedCode}, lakini hakuna risiti inayosubiri kuthibitishwa kwa sasa.\n\n`
              + 'Tuma picha ya risiti kwanza, kisha kodi hii ikihitajika.'
            : `I have the code ${typedCode}, but no receipt is waiting to be verified right now.\n\n`
              + 'Send the receipt photo first, then this code if it is needed.');
          await audit(db, identity, waMessageId, 'tra_verify', 'typed_code', 'nothing_pending');
          await finish('skipped');
          continue;
        }

        let conversationalAiBudgetBlock: AiBudgetDecision | null = null;
        /**
         * The model was asked and came back with nothing.
         *
         * MEASURED FAILURE: when that happened the shop was sent the generic
         * "I can help you with Risip and your records..." menu — the same reply
         * an off-topic message gets. To somebody who had just watched Risip
         * answer two questions correctly, that reads as Risip not understanding
         * Swahili. The truth is narrower and worth saying: the question was
         * understood and the answer did not arrive.
         */
        let assistantCameBackEmpty = false;
        // Why the model did not answer, so the reply can say something true
        // and the telemetry can say something useful.
        let aiFailureClass: AssistantFailureClass | null = null;
        // ── the model decides, not a list of words ───────────────────────────
        //
        // The owner's instruction, and they were right: a parser has to be
        // taught every sentence. "Nimeuza" worked and "nimeuuza" did not;
        // "shingapi" cost three unanswered messages; "mambo yakoje" cost
        // another. Adding phrases one at a time never ends and never covers a
        // language.
        //
        // So the model now sees EVERY free-text message first and picks the
        // tool. What it may not do is unchanged and is the whole safety of
        // this: it never computes money, never names a product the catalogue
        // does not hold, and never writes a confirmed record. Its proposals go
        // through the same validation, the same product resolution, the same
        // pricing RPCs and the same NDIYO as before.
        //
        // The deterministic parsers below are no longer the gatekeepers and
        // are not a free-text outage fallback. If the model is unavailable,
        // over budget or silent, the user receives a truthful clarification;
        // ordinary business language is never handed to a parser instead.
        //
        // AI-FIRST, FOR REAL THIS TIME.
        //
        // Two deterministic parsers used to stand here and take ordinary
        // business language away from the model before it could look:
        //
        //   && !parseBareQuantityList(body)
        //   && !(deterministicBatch.kind === 'parsed' && records.length > 1)
        //
        // MEASURED FAILURE. A shop sent three lines — "Feni 7 / Nguvu 6 /
        // Antoni 4" — and Haiku never saw them. A parser counted the
        // quantities, asked MAUZO or MANUNUZI, and when "Antoni" did not match
        // "Anton wa Padua" letter for letter the shop was offered a NEW PRODUCT
        // registration for something it already sells. The same gate ate mixed
        // sale-and-purchase messages, and expense batches whose second line was
        // dropped in silence.
        //
        // That is two personalities in one product: some sentences met a
        // language model and others met a regular expression, and the shop
        // could not tell which it would get. Both are gone.
        //
        // What remains in front of the model is not language. It is the ANSWER
        // to a question Risip itself just asked, plus the system commands that
        // must never cost a model call. answersPendingQuestion is deliberately
        // narrow: a shop asked "Rejareja au jumla?" that instead types "leo
        // nimeuza shingapi" has changed the subject, and changing the subject
        // goes to Claude like any other sentence.
        // Ordinary words and sentences always reach the model, even when a
        // registration or clarification is parked. A pending state is context
        // for Claude; it is not permission for a business parser to intercept
        // the next message. Only system commands and exact protocol answers
        // are excluded by messageGoesToModel().
        // "1" AGAINST A BILL.
        //
        // A one-character answer to a question Risip asked, which is exactly
        // what the parser is for. Three guards, and all three are needed:
        //
        //   nothing else is parked, so this can never steal the "1" that
        //   belongs to MAUZO/ONGEZA/SAJILI or to a two-name product choice;
        //   an OPEN invoice exists, so "1" out of nowhere is still language;
        //   the answer is exactly a payment word, so "nitalipa kesho" goes to
        //   the model like any other sentence.
        //
        // Nothing here marks anything paid. It asks Snippe to ring the
        // handset; only the signed webhook may say the month was bought.
        if (!convo && identity?.company_id && parseBillingAnswer(body) === 'pay') {
          const { data: openInvoice } = await db
            .from('subscription_invoices')
            .select('id, amount_tzs, attempts, period_start')
            .eq('company_id', identity.company_id)
            .eq('status', 'open')
            .order('period_start', { ascending: true })
            .limit(1)
            .maybeSingle();

          if (openInvoice) {
            const provider = providerForPhone(phone);
            if (!provider) {
              // Guessing the network wrong is a prompt that reaches nobody,
              // which is the failure this whole flow already had once. An
              // unrecognised prefix asks rather than guesses.
              await reply(phone, billingAskProvider(lang));
              await audit(db, identity, waMessageId, 'billing', 'provider_unknown', 'clarification');
              await finish('skipped');
              continue;
            }

            const { data: owner } = await db
              .from('profiles')
              .select('id, full_name')
              .eq('company_id', identity.company_id)
              .eq('role', 'owner')
              .is('deactivated_at', null)
              .limit(1)
              .maybeSingle();
            const account = owner?.id ? await db.auth.admin.getUserById(owner.id) : null;
            const email = account?.data?.user?.email ?? '';

            const result = await createSnippePayment({
              invoiceId: String(openInvoice.id),
              amountTzs: Number(openInvoice.amount_tzs),
              phone,
              provider,
              customer: { ...splitName(owner?.full_name), email },
              webhookUrl: `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1/snippe-webhook`,
              apiKey: Deno.env.get('SNIPPE_API_KEY') ?? '',
              // Every "1" after the first starts a NEW payment, because the
              // previous one expires in ten minutes and the same key would
              // keep handing back the dead one forever.
              attempt: Number(openInvoice.attempts ?? 0) + 1,
            });

            await db.from('subscription_invoices').update({
              attempts: Number(openInvoice.attempts ?? 0) + 1,
              ...(result.reference ? { snippe_reference: result.reference } : {}),
              ...(result.status ? { snippe_status: result.status } : {}),
            }).eq('id', openInvoice.id);

            await db.from('subscription_events').insert({
              company_id: identity.company_id,
              invoice_id: openInvoice.id,
              kind: `payment.requested.${result.httpStatus}`,
              payload: { via: 'whatsapp', provider, received: result.payload },
            });

            await reply(phone, result.ok ? billingPushSent(lang) : billingPushFailed(lang));
            await audit(db, identity, waMessageId, 'billing',
              result.ok ? 'push_sent' : 'push_failed', result.ok ? 'applied' : 'failed');
            await finish('skipped');
            continue;
          }
        }

        // A protected product selection may have reconstructed the original
        // sentence; that sentence still goes through the same AI dispatcher.
        if (await handleAiText(convo, body, isProtectedSystemCommand(body), identity, assistantEvidenceBody)) continue;

        // Adding a product is checked before anything records money, because
        // the whole value of it is refusing to create the near-duplicate.
        if (isAddProductStart(writeBody)) {
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: { kind: 'add_product_setup', step: 'name' },
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await clearAssistantMemory(db, identity);
          await replyQuietly(phone, addProductNameQuestion(lang));
          await audit(db, identity, waMessageId, 'add_product', 'name_asked', 'clarification');
          await finish('skipped');
          continue;
        }
        const addProduct = parseAddProduct(writeBody);
        if (addProduct) {
          const resolved = await resolveProductForRead(db, identity, addProduct.product);
          if (!resolved.error && resolved.resolution.kind === 'matched') {
            const match = resolved.resolution.match;
            if (match.matchKind === 'exact') {
              const [stockResult, pricingResult] = await Promise.all([
                db.rpc('wa_stock_on_hand', { p_company_id: identity.company_id, p_product: match.productKey }),
                db.rpc('wa_product_pricing', { p_company_id: identity.company_id, p_product_keys: [match.productKey] }),
              ]);
              const stock = ((stockResult.data ?? []) as Array<Record<string, unknown>>)[0] ?? null;
              const pricing = ((pricingResult.data ?? []) as Array<Record<string, unknown>>)[0] ?? null;
              await reply(phone, productAlreadyExists(match.productName, {
                soldQuantity: pricing?.sold_quantity == null ? 0 : Number(pricing.sold_quantity),
                onHand: stock?.has_count ? Number(stock.on_hand) : null,
                unitCost: pricing?.unit_cost == null ? null : Number(pricing.unit_cost),
              }, lang));
              await audit(db, identity, waMessageId, 'add_product', 'exists', 'refused');
              await finish('skipped');
              continue;
            }
            await reply(phone, productLooksLikeExisting(addProduct.product, match.productName, lang));
            await audit(db, identity, waMessageId, 'add_product', 'near_duplicate', 'clarification');
            await finish('skipped');
            continue;
          }
          if (!resolved.error && resolved.resolution.kind === 'ambiguous') {
            await parkProductChoice(db, identity, waMessageId,
              resolved.resolution.asked, choiceNames(resolved.resolution), body);
            await reply(phone, productReadClarification(resolved.resolution, lang));
            await audit(db, identity, waMessageId, 'add_product', 'ambiguous', 'clarification');
            await finish('skipped');
            continue;
          }
          if (addProduct.unitCost === null) {
            await reply(phone, addProductNeedsCost(addProduct.product, lang));
            await audit(db, identity, waMessageId, 'add_product', 'needs_cost', 'clarification');
            await finish('skipped');
            continue;
          }
          const { error: addError } = await db.rpc('wa_set_product_cost', {
            p_phone: phone,
            p_name: addProduct.product,
            p_unit_cost: addProduct.unitCost,
            p_unit: addProduct.unit,
          });
          if (addError) {
            await reply(phone, productCostErrorMessage(addError, lang));
            await audit(db, identity, waMessageId, 'add_product', 'create', 'failed');
            await finish('skipped');
            continue;
          }
          await reply(phone, costSaved(
            { product: addProduct.product, unitCost: addProduct.unitCost, unit: addProduct.unit },
            identity.company_name, lang));
          await audit(db, identity, waMessageId, 'add_product', 'create', 'applied');
          await finish('skipped');
          continue;
        }

        // A pasted selling-price list. Checked against what the shop pays before
        // it is confirmed, because a retail price under the buying cost reads
        // and saves perfectly while turning every future sale into a loss.
        // ONBOARDING STEP 7 — the worker offer, answered.
        //
        // Checked here, before the ordinary parsers, because "1" and "2" are
        // exactly the kind of bare token that anything else would happily read
        // as a quantity. It is only ever reached while this precise question is
        // parked, and it clears the parked state either way.
        const workerOfferPending = convo?.awaiting === 'product_cost'
          && (convo.options as { kind?: string } | null)?.kind === 'onboarding_worker_offer'
          ? convo.options as { kind: string; category: string | null; subCategory: string | null }
          : null;
        if (workerOfferPending) {
          const said = String(body ?? '').trim().toLowerCase();
          const wantsWorker = /^1$/.test(said) || /\b(?:ndiyo|ndio|yes|naam|sawa)\b/.test(said);
          const later = /^2$/.test(said) || /\b(?:baadaye|later|hapana|no|bado)\b/.test(said);
          if (wantsWorker || later) {
            await clearConversation(db, identity.id as string);
            if (wantsWorker) {
              const { data: made, error: madeError } = await db.rpc('wa_create_invite_code', {
                p_phone: phone, p_role: 'worker', p_days: 3,
              });
              if (madeError) {
                await reply(phone, inviteNotAllowed(lang));
              } else {
                const invite = made as { code?: string; company_name?: string } | null;
                await reply(phone, inviteReady(
                  String(invite?.code ?? ''), 'worker', lang,
                ));
                await sendReplyText(phone, inviteForwardMessage(
                  String(invite?.code ?? ''), invite?.company_name ?? '',
                  await whatsAppDisplayNumber(), lang,
                ), waMessageId);
              }
            }
            // Either answer leads here. The offer was a detour; products are
            // the road, and a new shop cannot do anything else until it has one.
            await sendReplyText(phone, firstProductsPrompt(
              workerOfferPending.category, workerOfferPending.subCategory, lang,
            ), waMessageId);
            await audit(db, identity, waMessageId, 'onboarding', wantsWorker ? 'invite_now' : 'invite_later', 'applied');
            await finish('answered');
            continue;
          }
          // Anything else is not an answer to this. Release the question rather
          // than holding somebody hostage to it, and let the message be read as
          // what it is.
          await clearConversation(db, identity.id as string);
        }

        // "nataka kumuinvite mtu". Risip does not send the invite — see
        // whatsappInvite.ts for why — it writes it out for the owner to forward.
        if (parseInviteRequest(writeBody)) {
          if (identity.role !== 'owner') {
            await reply(phone, inviteNotAllowed(lang));
            await audit(db, identity, waMessageId, 'invite', 'role', 'blocked');
            await finish('skipped');
            continue;
          }
          // ONE ROLE, SO NO QUESTION.
          //
          // The owner: "hii risip haitaji tena muhasibu ni mfanyakazi tu sasa
          // hivi kwasaabu kazi yake ni kuripot na risip yenye ni mhasibu."
          //
          // A question with one answer is not a question — it is a tap between
          // somebody and the thing they asked for. He asked to invite a worker;
          // he gets a worker invite.
          const { data: made, error: inviteError } = await db.rpc('wa_create_invite_code', {
            p_phone: phone, p_role: 'worker', p_days: 3,
          });
          if (inviteError) {
            const hint = (inviteError as { hint?: string } | null)?.hint;
            await reply(phone, hint === 'not_authorized'
              ? inviteNotAllowed(lang)
              : productCostErrorMessage(inviteError, lang));
            await audit(db, identity, waMessageId, 'invite', 'worker', 'failed');
            await finish('skipped');
            continue;
          }
          const invite = made as { code?: string; company_name?: string } | null;
          await reply(phone, inviteReady(
            String(invite?.code ?? ''), 'worker', lang,
          ));
          // Its own message, with no owner-facing instructions mixed into it,
          // so the owner can forward this bubble as-is.
          await sendReplyText(phone, inviteForwardMessage(
            String(invite?.code ?? ''), invite?.company_name ?? '',
            await whatsAppDisplayNumber(), lang,
          ), waMessageId);
          await audit(db, identity, waMessageId, 'invite', 'worker', 'applied');
          await finish('skipped');
          continue;
        }

        // ── Bucha phase 2: goods that left the shelf without being sold ────
        //
        // Deterministic from end to end. The parser identifies the intent and
        // the words; the product comes from THIS company's catalogue through
        // the existing resolver; the cost comes from the existing pricing RPC;
        // and the multiplication happens here, in code. Nothing about the
        // money is asked of the model, and when no cost exists nothing is
        // guessed — the quantity is recorded and the preview says plainly that
        // ── Bucha phase 3: teaching Risip how this shop talks ──────────────
        // ── Bucha phase 4: setting a product up in the shop's own words ────
        //
        // No new engine. Every sentence here is read into the arguments
        // wa_configure_product_units already takes, and the conversion
        // arithmetic — 18,000 a box of twelve makes a packet cost 1,500 —
        // stays in SQL where it has always been. The preview shows that
        // division so the shop can disagree with it now rather than in a
        // margin report next month.
        const productSetup = parseProductSetup(writeBody);
        if (productSetup) {
          if (!['owner', 'accountant'].includes(identity.role)) {
            await reply(phone, lang === 'sw'
              ? 'Ni owner au accountant pekee anayeweza kuweka vipimo na bei za bidhaa.'
              : 'Only an owner or accountant can configure product units and prices.');
            await audit(db, identity, waMessageId, 'product_setup', 'role', 'blocked');
            await finish('skipped');
            continue;
          }

          let knownName: string | null = null;
          const existing = await resolveProductForRead(db, identity, productSetup.product);
          if (!existing.error && existing.resolution.kind === 'matched') {
            knownName = existing.resolution.match.productName;
          }
          // A package can only hold something the shop already has. Declaring
          // "one kifuko is a kilo" of a product nobody sells describes nothing.
          if (productSetup.kind === 'packaging_setup' && !knownName) {
            await reply(phone, lang === 'sw'
              ? `Sina *${productSetup.product}* kwenye bidhaa zako bado. Isajili kwanza, kisha niambie kipimo cha kifungashio.`
              : `I do not have *${productSetup.product}* among your products yet. Register it first, then tell me the package size.`);
            await audit(db, identity, waMessageId, 'product_setup', 'unknown_product', 'skipped');
            await finish('skipped');
            continue;
          }

          const setupPending: ProductSetupPending = {
            kind: 'product_setup_pending', setup: productSetup, productName: knownName,
          };
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: setupPending,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });

          await reply(phone, productSetup.kind === 'packaging_setup'
            ? packagingConfirmation(productSetup, lang)
            : productSetupConfirmation(productSetup, derivedUnitCost(productSetup), lang));
          await audit(db, identity, waMessageId, 'product_setup', productSetup.kind, 'pending');
          await finish('applied');
          continue;
        }

        //
        // Nothing is saved from this message. Vocabulary changes how every
        // future message is read, so it is previewed and confirmed like a
        // price — and the product named is resolved against THIS company's
        // catalogue first, so a word can never be taught to mean something the
        // shop does not sell.
        const teaching = parseVocabularyTeaching(writeBody);
        if (teaching) {
          if (!['owner', 'accountant'].includes(identity.role)) {
            // A worker may USE the shop's words. Only an owner or accountant
            // may change what they mean.
            await reply(phone, vocabularyNotAllowed(lang));
            await audit(db, identity, waMessageId, 'vocabulary', 'role', 'blocked');
            await finish('skipped');
            continue;
          }

          let productName: string | null = null;
          const wanted = teaching.kind === 'forget' ? null : teaching.product;
          if (wanted) {
            const found = await resolveProductForRead(db, identity, wanted);
            if (!found.error && found.resolution.kind === 'matched') {
              productName = found.resolution.match.productName;
            } else if (teaching.kind === 'product_alias') {
              await reply(phone, lang === 'sw'
                ? `Sina *${wanted}* kwenye bidhaa zako, kwa hiyo siwezi kuifanya *${teaching.term}* iwe jina lake.`
                : `I do not have *${wanted}* among your products, so I cannot make *${teaching.term}* a name for it.`);
              await audit(db, identity, waMessageId, 'vocabulary', 'unknown_product', 'skipped');
              await finish('skipped');
              continue;
            }
          }

          const pending: VocabularyPending = { kind: 'vocabulary_teaching', teaching, productName };
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: pending,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });

          await reply(phone, teaching.kind === 'forget'
            ? forgetConfirmation(teaching.term, lang)
            : teaching.kind === 'product_alias'
              ? aliasConfirmation(teaching.term, productName ?? teaching.product, lang)
              : semanticConfirmation(teaching.term, productName, lang));
          await audit(db, identity, waMessageId, 'vocabulary', teaching.kind, 'pending');
          await finish('applied');
          continue;
        }

        // the value is unknown.
        const parsedLoss = parseStockLoss(writeBody);
        // A word the shop has TAUGHT us stops being ambiguous. "Mzoga" is not
        // in any shipped dictionary and never will be, but if this company has
        // said what it means here, that is a fact about this company and the
        // question no longer needs asking.
        let lossReading = parsedLoss;
        if (parsedLoss?.kind === 'clarify_spoilage') {
          const { data: vocabRows } = await db.rpc('wa_company_vocabulary', {
            p_company_id: identity.company_id,
          });
          const taught = ((vocabRows ?? []) as Array<Record<string, unknown>>).find((row) =>
            String(row.meaning ?? '') === 'stock_loss'
            && productKey(String(row.term ?? '')) === productKey(parsedLoss.word));
          const taughtProduct = taught ? String(taught.product_name ?? '').trim() : '';
          // Only when the shop also said WHICH product. Knowing that a word
          // means spoilage is not knowing what spoiled, and subtracting the
          // wrong meat is the failure this whole path exists to avoid.
          if (taughtProduct) {
            lossReading = {
              kind: 'stock_loss',
              product: taughtProduct,
              quantity: parsedLoss.quantity,
              unit: parsedLoss.unit,
              reason: parsedLoss.word,
            };
          }
        }
        if (lossReading) {
          if (lossReading.kind === 'clarify_spoilage') {
            // A word that means spoilage in one yard and a fresh carcass in the
            // next, and this shop has not said which. No draft is created,
            // because either guess destroys or invents stock.
            await reply(phone, spoilageClarification(lossReading, lang));
            await audit(db, identity, waMessageId, 'stock_loss', lossReading.word, 'pending');
            await finish('skipped');
            continue;
          }
          const found = await resolveProductForRead(db, identity, lossReading.product);
          if (found.error || found.resolution.kind !== 'matched') {
            // Ambiguity is answered with a question, never with the closest
            // guess: subtracting the wrong product is worse than subtracting
            // nothing at all.
            await reply(phone, found.resolution.kind === 'ambiguous'
              ? (lang === 'sw'
                ? `Sina uhakika ni bidhaa ipi kati ya hizi: ${found.resolution.candidates.map((c) => `*${c.productName}*`).join(', ')}. Itaje kwa jina kamili.`
                : `I am not sure which product this is: ${found.resolution.candidates.map((c) => `*${c.productName}*`).join(', ')}. Name it in full.`)
              : (lang === 'sw'
                ? `Sina *${lossReading.product}* kwenye bidhaa zako, kwa hiyo siwezi kuipunguza kwenye stock.`
                : `I do not have *${lossReading.product}* among your products, so I cannot take it off your stock.`));
            await audit(db, identity, waMessageId, lossReading.kind, found.resolution.kind, 'skipped');
            await finish('skipped');
            continue;
          }

          const match = found.resolution.match;
          const { data: costRows } = await db.rpc('wa_product_pricing', {
            p_company_id: identity.company_id,
            p_product_keys: [match.productKey],
          });
          const costRow = ((costRows ?? []) as Array<Record<string, unknown>>)[0];
          const rawCost = Number(costRow?.unit_cost ?? 0);
          // product_costs enforces unit_cost > 0, so anything else means the
          // shop has never told us what this product costs.
          const unitCost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : null;
          const value = unitCost === null
            ? null
            : Math.round(unitCost * lossReading.quantity * 100) / 100;

          const record: import('../_shared/whatsappDailyRecords.ts').ParsedDailyRecord = {
            kind: lossReading.kind,
            // Zero here means "not valued", and it is only ever reachable when
            // the cost engine returned nothing. daily_profit_estimate counts
            // these separately so no report can call an unvalued loss free.
            amount: value ?? 0,
            partyName: null,
            description: null,
            lines: [{
              description: match.productName,
              quantity: lossReading.quantity,
              unit_amount: unitCost ?? 0,
              ...(lossReading.unit ? { unit: lossReading.unit } : {}),
            }],
            confidence: 0.99,
            ...(lossReading.kind === 'stock_loss' ? { lossReason: lossReading.reason || null } : {}),
          };

          const created = await createDailyRecordDraft(db, identity, waMessageId, record, lang, body ?? undefined);
          if (created.error || !created.id) {
            await reply(phone, lang === 'sw'
              ? 'Sikuweza kuhifadhi draft hii. Hakuna rekodi iliyothibitishwa; tafadhali jaribu tena.'
              : 'I could not save this draft. Nothing was confirmed; please try again.');
            await audit(db, identity, waMessageId, lossReading.kind, 'draft', 'failed');
            await finish('skipped');
            continue;
          }

          // The same pending-confirmation state every financial mutation uses.
          // Nothing has left the shelf until NDIYO.
          const lossState: DailyRecordConversation = {
            kind: 'daily_record_confirmation',
            dailyRecordId: created.id,
            sourceMessageId: waMessageId,
            record,
          };
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'payment_source',
            receipt_id: null,
            options: lossState,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });

          await reply(phone, lossReading.kind === 'stock_loss'
            ? stockLossConfirmation(lossReading, match.productName, value, lang)
            : ownerUseConfirmation(lossReading, match.productName, value, lang));
          await audit(db, identity, waMessageId, lossReading.kind,
            value === null ? 'unvalued' : String(value), 'pending');
          await finish('applied');
          continue;
        }

        // Buying in one unit and selling in declared smaller portions. Nothing
        // is written yet: the compact first message has prices but not the
        // What a portion is cut from. "kilo 1 ya nyama ya ngombe inatoa
        // mishikaki 18" — the one fact that lets a skewer sale come off the
        // beef, and a fact only this shop can supply: one kijiwe cuts big and
        // gets twelve from a kilo, the one next door gets twenty.
        //
        // Stored as a one-piece recipe (0119), so the sale path that already
        // prices and counts combinations does the rest with no new machinery.
        const portionYield = parsePortionYield(writeBody);
        if (portionYield) {
          if (!['owner', 'accountant'].includes(identity.role)) {
            await reply(phone, lang === 'sw'
              ? 'Ni owner au accountant pekee anayeweza kuweka vipimo vya bidhaa.'
              : 'Only an owner or accountant can configure product measures.');
            await audit(db, identity, waMessageId, 'portion_yield', 'role', 'blocked');
            await finish('skipped');
            continue;
          }
          const { error: yieldError } = await db.rpc('wa_save_combo', {
            p_phone: phone,
            p_name: portionYield.portionName,
            p_pieces: portionYieldPieces(portionYield),
          });
          if (yieldError) {
            // wa_save_combo refuses a piece that is not a product of this
            // business, which is the common case here: the meat has to exist
            // before a skewer can be cut from it. Say which, rather than
            // "could not save".
            await reply(phone, lang === 'sw'
              ? `Sina *${portionYield.productName}* kwenye bidhaa zako bado, kwa hiyo siwezi kuunganisha ${portionYield.portionName} nayo.\n\nSajili ${portionYield.productName} kwanza, kisha rudia.`
              : `I do not have *${portionYield.productName}* among your products yet, so I cannot tie ${portionYield.portionName} to it.\n\nRegister ${portionYield.productName} first, then send this again.`);
            await audit(db, identity, waMessageId, 'portion_yield', 'unknown_product', 'failed');
            await finish('skipped');
            continue;
          }
          await reply(phone, portionYieldSaved(portionYield, lang));
          await audit(db, identity, waMessageId, 'portion_yield', String(portionYield.perBaseUnit), 'applied');
          await finish('applied');
          continue;
        }

        // conversion sizes, and those must never be inferred from words.
        const portionOffer = parsePortionSetupOffer(writeBody);
        if (portionOffer) {
          if (!['owner', 'accountant'].includes(identity.role)) {
            await reply(phone, lang === 'sw'
              ? 'Ni owner au accountant pekee anayeweza kuweka vipimo na bei za bidhaa.'
              : 'Only an owner or accountant can configure product units and prices.');
            await audit(db, identity, waMessageId, 'portion_setup', 'role', 'blocked');
            await finish('skipped');
            continue;
          }
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: portionOffer,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await reply(phone, portionSizeQuestion(portionOffer, lang));
          await audit(db, identity, waMessageId, 'portion_setup', 'start', 'pending');
          await finish('skipped');
          continue;
        }

        // Answering the offer to add a product: cost and both selling prices on
        // one line. Checked BEFORE the selling-price batch, which would read the
        // same line as a price change for a product that does not exist yet.
        const newProducts = parseNewProductPricing(writeBody);
        if (newProducts.length > 0) {
          const activeNewProductSetup = newProductSaleSetup ?? newProductOfferSetup;
          const stillMissing = activeNewProductSetup?.missingProducts.filter((required) =>
            !newProducts.some((product) => productKey(product.product) === productKey(required))) ?? [];
          if (stillMissing.length > 0) {
            await replyQuietly(phone, newProductPricingIncomplete(stillMissing, lang));
            await audit(db, identity, waMessageId,
              activeNewProductSetup?.kind ?? 'new_product', 'prices_incomplete', 'clarification');
            await finish('skipped');
            continue;
          }
          // THE EXACT LINE WHERE NINE PRODUCTS FELL OUT.
          //
          // The sale was carried forward only when it arrived from
          // newProductSaleSetup. Arriving from newProductOfferSetup — which is
          // the path a bare list takes when the trader answers MANUNUZI — it
          // was silently not carried, so registration finished and there was
          // nothing left to resume. Two new names went in; nine known products
          // went nowhere.
          //
          // Registration is a blockage being cleared, never the end of the road.
          const state: NewProductPricingState = {
            kind: 'new_product_pricing',
            products: newProducts,
            ...(newProductSaleSetup ? {
              pendingSale: newProductSaleSetup.sale,
              sourceMessageId: newProductSaleSetup.sourceMessageId,
              credit: newProductSaleSetup.credit ?? null,
              paymentMethod: newProductSaleSetup.paymentMethod ?? null,
              occurredAt: newProductSaleSetup.occurredAt ?? null,
            } : newProductOfferSetup?.pendingSale ? {
              pendingSale: newProductOfferSetup.pendingSale,
              sourceMessageId: newProductOfferSetup.sourceMessageId,
              // The answer he already gave, carried across the interruption.
              ...(newProductOfferSetup.pendingDirection
                ? { pendingDirection: newProductOfferSetup.pendingDirection }
                : {}),
            } : {}),
          };
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: state,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await reply(phone, newProductConfirmation(newProducts, lang));
          await audit(db, identity, waMessageId, 'new_product', String(newProducts.length), 'pending');
          await finish('skipped');
          continue;
        }

        // MEASURED FAILURE: this re-sent the same registration question for any
        // message at all. The owner asked about a different product, then asked
        // how their business was doing, and got the ugali question back three
        // times. A parked question must let go the moment somebody moves on —
        // the same rule the invite already follows.
        // MEASURED FAILURE, twice. The first fix released the question only when
        // the message started a topic Risip already RECOGNISED, which is a
        // whitelist — so "bidhaa ziko ngapi store" and even "sihitaji kusajili
        // bidhaa" were treated as bad answers and got the same question back,
        // four times running.
        //
        // The test is the other way round: this is only an ANSWER if it is
        // trying to be one. Prices were already tried above and failed, so what
        // is left qualifies only when it mentions the product or carries a
        // number — a botched price attempt worth one more go. A question, or a
        // refusal, or anything else, releases the parked sale.
        const activeNewProductQuestion = newProductSaleSetup ?? newProductOfferSetup;
        const looksLikeAnAnswer = activeNewProductQuestion
          ? /[0-9]/.test(body)
            && activeNewProductQuestion.missingProducts.some((name) =>
              body.toLocaleLowerCase('sw-TZ').includes(name.toLocaleLowerCase('sw-TZ')))
          : false;
        if (activeNewProductQuestion && !looksLikeAnAnswer) {
          await clearConversation(db, identity.id as string);
          await audit(db, identity, waMessageId, activeNewProductQuestion.kind, 'abandoned', 'skipped');
        } else if (activeNewProductQuestion) {
          await replyQuietly(phone, activeNewProductQuestion.kind === 'new_product_sale_setup'
            ? newProductSaleOffer(activeNewProductQuestion.missingProducts, lang)
            : newProductOffer(activeNewProductQuestion.missingProducts, lang));
          await audit(db, identity, waMessageId, activeNewProductQuestion.kind, 'prices_unreadable', 'clarification');
          await finish('skipped');
          continue;
        }

        const sellingBatch = parseSellingPriceBatch(writeBody);
        if (sellingBatch) {
          // MEASURED FAILURE, the owner's own thread: they set two prices in one
          // sentence and typed "velvet" for Velvet napkin. Risip asked about
          // velvet — reasonably — but answering HAPANA threw BOTH prices away,
          // including sodaa, which had never been in doubt. One uncertain name
          // must not cost the certain ones.
          //
          // So names are resolved here, before anything is asked. A name that
          // reaches a real product is rewritten to that product's own spelling
          // and is no longer a question. Only a name nothing in the catalogue
          // matches is still worth asking about, and by then it is a genuinely
          // new product rather than a typo.
          for (const price of sellingBatch.prices) {
            const named = await resolveProductForWrite(db, identity, price.product);
            if (named.kind === 'matched') price.product = named.match.productName;
          }
          const { data: costRows } = await db.rpc('wa_product_pricing', {
            p_company_id: identity.company_id,
            p_product_keys: sellingBatch.prices.map((price) => price.product),
          });
          const costs = new Map<string, number>();
          const known = new Set<string>();
          for (const row of (costRows ?? []) as Array<Record<string, unknown>>) {
            const key = String(row.product_key).toLowerCase();
            if (row.unit_cost != null) costs.set(key, Number(row.unit_cost));
            // Bought or sold at some point: the shop has met this product.
            if (row.unit_cost != null || Number(row.sold_quantity ?? 0) > 0) known.add(key);
          }
          const unknown = sellingBatch.prices
            .filter((price) => !known.has(price.product.toLowerCase()))
            .map((price) => price.product);
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: sellingBatch,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          // For each unrecognised name, ask the read resolver what it is nearest
          // to. Reads are allowed to be forgiving, so this is safe — it only
          // suggests, and the write itself still uses the exact name given.
          const suggestions = new Map<string, string>();
          for (const name of unknown) {
            const near = await resolveProductForRead(db, identity, name);
            if (!near.error && near.resolution.kind === 'matched'
              && near.resolution.match.matchKind !== 'exact') {
              suggestions.set(name.toLowerCase(), near.resolution.match.productName);
            }
          }
          await reply(phone, sellingPriceBatchConfirmation(
            sellingBatch,
            lang,
            sellingPriceBatchCostWarnings(sellingBatch.prices, costs, lang),
            sellingPriceBatchUnknownProducts(unknown, lang, suggestions),
          ));
          await audit(db, identity, waMessageId, 'selling_price_batch',
            String(sellingBatch.prices.length), 'pending');
          await finish('skipped');
          continue;
        }

        // "Naongeza X 30" and "stock X 30" are not safe writes. The first can
        // mean thirty MORE or thirty in total; the second used to become a
        // stock-purchase draft worth TSh 30. Stop before both the stock-count
        // and money parsers and ask for one explicit meaning.
        const ambiguousStockChange = parseAmbiguousStockChange(writeBody);
        if (ambiguousStockChange) {
          // Short forms are resolved only against this company's catalogue.
          // One prefix is useful ("nguvu" -> "nguvu ya sala"); two are a
          // question, never permission to create or overwrite the shorter one.
          const { data: catalogueRows } = await db.rpc('company_product_names', {
            p_company_id: identity.company_id,
          });
          const catalogueNames = ((catalogueRows ?? []) as Array<Record<string, unknown>>)
            .map((row) => String(row.product_name ?? '').trim())
            .filter(Boolean);
          const prefixResolution = cataloguePrefixResolution(ambiguousStockChange.product, catalogueNames);
          if (prefixResolution?.kind === 'ambiguous') {
            await parkProductChoice(db, identity, waMessageId,
              prefixResolution.asked, choiceNames(prefixResolution), body);
            await reply(phone, productReadClarification(prefixResolution, lang));
          } else {
            const canonical = prefixResolution?.kind === 'matched'
              ? prefixResolution.match.productName
              : ambiguousStockChange.product;
            await reply(phone, ambiguousStockChangeReply({ ...ambiguousStockChange, product: canonical }, lang));
          }
          await audit(db, identity, waMessageId, 'stock_change', ambiguousStockChange.product, 'clarification');
          await finish('skipped');
          continue;
        }

        const stockBatch = parseStockCountBatch(writeBody);
        if (stockBatch) {
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: stockBatch,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await reply(phone, stockCountBatchConfirmation(stockBatch, lang));
          await audit(db, identity, waMessageId, 'stock_count_batch', String(stockBatch.counts.length), 'pending');
          await finish('skipped');
          continue;
        }

        // A physical count. Checked before the record parser because "nina
        // daftari 90" states what is on the shelf, not what moved — and reading
        // it as a movement would be the one mistake that silently rewrites a
        // stock figure the trader is about to rely on.
        const stockCount = parseStockCount(writeBody);
        if (stockCount) {
          const { data: saved, error } = await db.rpc('wa_record_stock_count', {
            p_phone: phone,
            p_name: stockCount.product,
            p_quantity: stockCount.quantity,
            p_unit: stockCount.unit,
          });
          if (error) {
            await reply(phone, productCostErrorMessage(error, lang));
            await audit(db, identity, waMessageId, 'stock_count', stockCount.product, 'failed');
          } else {
            const previous = (saved as { previous?: number | null } | null)?.previous;
            await reply(phone, stockCountConfirmation(
              stockCount, previous === null || previous === undefined ? null : Number(previous), lang,
            ));
            await audit(db, identity, waMessageId, 'stock_count', stockCount.product, 'applied');
          }
          await finish('skipped');
          continue;
        }

        // What the shop CHARGES, as opposed to what it pays. Checked before the
        // record parser because a price list names a product and numbers just
        // like a sale does, and reading it as a sale would invent revenue.
        const sellingPrice = parseSellingPrice(writeBody);
        if (sellingPrice) {
          // Which product, according to the shop's own list — not according to
          // however the name was typed. A price written against a name nobody
          // sells creates a product nobody sells.
          const named = await resolveProductForWrite(db, identity, sellingPrice.product);
          if (named.kind === 'ambiguous') {
            await parkProductChoice(db, identity, waMessageId,
              named.asked, choiceNames(named), body);
            await reply(phone, productReadClarification(named, lang));
            await audit(db, identity, waMessageId, 'selling_price', 'ambiguous', 'clarification');
            await finish('skipped');
            continue;
          }
          if (named.kind === 'matched') sellingPrice.product = named.match.productName;
          const notice = named.kind === 'matched'
            ? productReadMatchNotice(named, lang)
            : (lang === 'sw'
              ? `_Sijaiona "${sellingPrice.product}" kwenye orodha yako — nimeisajili kama bidhaa mpya._\n`
              : `_I did not find "${sellingPrice.product}" in your catalogue — recorded as a new product._\n`);
          const { data: saved, error } = await db.rpc('wa_set_selling_price', {
            p_phone: phone,
            p_name: sellingPrice.product,
            p_retail: sellingPrice.retail,
            p_wholesale: sellingPrice.wholesale,
            p_min_qty: sellingPrice.minQty,
          });
          if (error) {
            await reply(phone, productCostErrorMessage(error, lang));
            await audit(db, identity, waMessageId, 'selling_price', sellingPrice.product, 'failed');
          } else {
            void saved;
            await reply(phone, notice + sellingPriceSaved(sellingPrice, lang));
            await audit(db, identity, waMessageId, 'selling_price', sellingPrice.product, 'applied');
          }
          await finish('skipped');
          continue;
        }

        // A whole price list in one message. Checked before the single-price
        // path and before the record parser, because a 36-line paste matched
        // neither and was silently dropped.
        const costBatch = parseProductCostBatch(writeBody);
        if (costBatch) {
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: costBatch,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await reply(phone, costBatchConfirmation(costBatch, lang));
          await audit(db, identity, waMessageId, 'product_cost_batch', String(costBatch.costs.length), 'pending');
          await finish('skipped');
          continue;
        }

        const costCandidate = parseProductCost(writeBody);
        if (costCandidate) {
          // The previous price is read here so the confirmation can show what it
          // was changing from. "Saved" alone hides a number that quietly rewrites
          // every profit figure after it.
          const { data: prev } = await db
            .from('product_costs')
            .select('unit_cost')
            .eq('company_id', identity.company_id)
            .eq('product_key', costCandidate.product.trim().toLowerCase())
            .order('effective_from', { ascending: false })
            .limit(1)
            .maybeSingle();
          const { data: company } = await db
            .from('companies').select('name').eq('id', identity.company_id).maybeSingle();

          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            options: costCandidate,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });

          await reply(phone, costConfirmation(
            costCandidate,
            (company as { name?: string } | null)?.name ?? '',
            prev ? Number((prev as { unit_cost: number }).unit_cost) : null,
            lang,
          ));
          await finish('skipped');
          continue;
        }

        const renameRequest = parseProductRename(writeBody);
        if (renameRequest) {
          const { data, error } = await db.rpc('wa_preview_product_rename', {
            p_phone: phone,
            p_from: renameRequest.from,
            p_to: renameRequest.to,
          });
          if (error || !data) {
            await reply(phone, productCostErrorMessage(error, lang));
            await audit(db, identity, waMessageId, 'product_rename', 'preview', 'failed');
            await finish('skipped');
            continue;
          }
          const row = data as Record<string, unknown>;
          const state: ProductRenamePreview = {
            kind: 'product_rename_confirmation',
            from: renameRequest.from,
            to: String(row.to_name ?? renameRequest.to),
            records: Number(row.records ?? 0),
            saleLines: Number(row.sale_lines ?? 0),
            costRows: Number(row.cost_rows ?? 0),
            priceRows: Number(row.price_rows ?? 0),
            stockCounts: Number(row.stock_counts ?? 0),
            unitRows: Number(row.unit_rows ?? 0),
          };
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: state,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await reply(phone, productRenameConfirmation(state, lang));
          await audit(db, identity, waMessageId, 'product_rename', 'preview', 'pending');
          await finish('skipped');
          continue;
        }

        // A sale written the way a person writes it, with no verb in front.
        //
        // The owner's objection: "sentences should not depend on kitenzi." They
        // are right — a shopkeeper types "Nguvu ya sala 21" and expects to be
        // understood, and demanding "nimeuza" first is a bot's rule.
        //
        // The safety is not in the words, because a bare name and a number is
        // genuinely ambiguous. It is in the catalogue: this only claims the
        // message when EVERY name is already a product of this company and every
        // one of them has a price the shop set itself. Anything else falls
        // through untouched, exactly as before.
        if (!resumedQuantitySale && !isDailyRecordCandidate(writeBody)) {
          // Buying, with no verb in front of it. Checked first: a restock names
          // a wholesale unit or a source, and neither ever belongs to a sale.
          const bareSpending = parseBareExpense(writeBody);
          if (bareSpending) {
            const records: ParsedDailyRecord[] = bareSpending.map((spent) => ({
              kind: 'expense',
              amount: spent.amount,
              partyName: null,
              description: spent.label,
              lines: [],
              confidence: 0.9,
            }));
            const batch = await createDailyRecordBatchDrafts(db, identity, waMessageId, records, lang);
            if (!batch.error && batch.ids.length > 0) {
              await db.from('whatsapp_conversations').upsert({
                identity_id: identity.id,
                company_id: identity.company_id,
                profile_id: identity.profile_id,
                awaiting: 'payment_source',
                receipt_id: null,
                options: {
                  kind: 'daily_record_batch_confirmation',
                  dailyRecordIds: batch.ids,
                  sourceMessageId: waMessageId,
                  records,
                },
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                updated_at: new Date().toISOString(),
              }, { onConflict: 'identity_id' });
              await replyDailyRecordBatchConfirmationQuietly(phone, records, lang, waMessageId);
              await audit(db, identity, waMessageId, 'bare_expense', String(records.length), 'pending');
              await finish('skipped');
              continue;
            }
          }

          const bare = parseBareQuantityList(writeBody);
          if (bare) {
            const priced = await priceQuantitySale(db, identity, bare, lang);
            // "viberiti 2" with two prices on the shelf. This is the owner's own
            // example, and it arrives with no verb at all — which is exactly why
            // the question has to live here too and not only on the sale path.
            if (priced.kind === 'combo_variant') {
              await askWhichVariant(priced.phrase, priced.token, priced.candidates, priced.sale, waMessageId);
              await audit(db, identity, waMessageId, 'quantity_sale', 'combo_variant', 'pending');
              await finish('skipped');
              continue;
            }
            if (priced.kind === 'combo_question') {
              await askAboutCombo(priced.splits[0], priced.sale, priced.units, waMessageId,
                bare.items.find((item) =>
                  comboKey(item.product) === comboKey(priced.splits[0].phrase))?.quantity ?? 1);
              await audit(db, identity, waMessageId, 'bare_quantity_sale', 'combo', 'pending');
              await finish('skipped');
              continue;
            }
            if (priced.kind === 'band') {
              await askForPriceBand(
                priced.choices, priced.sale, waMessageId, '', null, null, null,
                priced.settled ?? [],
              );
              await audit(db, identity, waMessageId, 'bare_quantity_sale', 'band', 'pending');
              await finish('skipped');
              continue;
            }
            if (priced.kind === 'priced' && priced.notCounted.length === 0) {
              const guarded = await addHistoricalPriceWarnings(db, identity.company_id, priced.record);
              const created = await createDailyRecordDraft(db, identity, waMessageId, guarded, lang, body ?? undefined);
              if (!created.error && created.id) {
                await db.from('whatsapp_conversations').upsert({
                  identity_id: identity.id,
                  company_id: identity.company_id,
                  profile_id: identity.profile_id,
                  awaiting: 'payment_source',
                  receipt_id: null,
                  options: {
                    kind: 'daily_record_confirmation',
                    dailyRecordId: created.id,
                    sourceMessageId: waMessageId,
                    record: guarded,
                  } satisfies DailyRecordConversation,
                  expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                  updated_at: new Date().toISOString(),
                }, { onConflict: 'identity_id' });
                await replyQuietly(phone, quantitySaleConfirmation(priced.lines, lang, bare.expenses, []) + comboNotice(priced.combos, lang));
                await audit(db, identity, waMessageId, 'bare_quantity_sale',
                  String(priced.lines.length), 'pending');
                await finish('skipped');
                continue;
              }
            }
            // Unknown product, no saved price, or a failed draft: this was
            // probably never a sale. Leave it for the model to read.
          }
        }

        const bareQuantityList = resumedQuantitySale ? null : parseBareQuantityList(writeBody);
        if (bareQuantityList) {
          const pricingHint = await priceQuantitySale(db, identity, bareQuantityList, lang);
          const missingProducts = pricingHint.kind === 'unknown' ? pricingHint.products : [];
          const resolvedProducts = pricingHint.kind === 'unknown' ? pricingHint.resolvedProducts : [];
          const state: ParkedQuantityMeaning = {
            kind: 'quantity_meaning_clarification',
            sourceMessageId: waMessageId,
            originalText: writeBody,
            sale: bareQuantityList,
            missingProducts,
            resolvedProducts,
          };
          await db.from('whatsapp_conversations').upsert({
            identity_id: identity.id,
            company_id: identity.company_id,
            profile_id: identity.profile_id,
            awaiting: 'product_cost',
            receipt_id: null,
            options: state,
            expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'identity_id' });
          await reply(phone, quantityMeaningQuestion(lang, missingProducts));
          await audit(db, identity, waMessageId, 'quantity_meaning', 'clarify', 'pending');
          await finish('skipped');
          continue;
        }


        // A known measured product and portion with no quantity should not go to
        // the broad assistant. Load only this company's declared sale units and
        // park the exact match so the next short number can finish the sentence.
        if (!resumedQuantitySale && !/\d/.test(writeBody) && writeBody.length <= 100 && !writeBody.includes('?')) {
          const { data: declaredRows, error: declaredError } = await db.rpc('wa_company_product_sale_units', {
            p_company_id: identity.company_id,
          });
          const declaredUnits: DeclaredSaleUnit[] = declaredError ? []
            : ((declaredRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
              productKey: String(row.product_key),
              productName: String(row.product_name),
              unitKey: String(row.unit_key),
              unitName: String(row.unit_name),
              baseQuantity: Number(row.base_quantity),
              retail: row.retail_price == null ? null : Number(row.retail_price),
              wholesale: row.wholesale_price == null ? null : Number(row.wholesale_price),
              wholesaleMinQty: row.wholesale_min_qty == null ? null : Number(row.wholesale_min_qty),
            }));
          const prompt = matchPortionMissingQuantity(writeBody, declaredUnits);
          if (prompt) {
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'product_cost',
              receipt_id: null,
              options: prompt,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await reply(phone, portionQuantityQuestion(prompt, lang));
            await audit(db, identity, waMessageId, 'portion_quantity', 'ask', 'pending');
            await finish('skipped');
            continue;
          }
        }

        const hypotheticalProduct = mixed ? null : parseHypotheticalProfitRequest(body);
        if (hypotheticalProduct) {
          const result = await hypotheticalProfitToolReply(
            db, identity, hypotheticalProduct, lang, parseHypotheticalQuantity(body));
          if (result.pending) {
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'product_analytics',
              receipt_id: null,
              options: result.pending,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
          }
          await reply(phone, result.text);
          await audit(db, identity, waMessageId, 'read_only_tool', 'hypothetical_product_profit', 'applied');
          await finish('skipped');
          continue;
        }

        // ── Risip conversational AI ─────────────────────────────────────
        // Protected control/confirmation states stay deterministic above.
        // Every other linked free-text business turn is interpreted by the
        // model first, with bounded client tools and recent company-scoped
        // conversation history. The deterministic parsers below remain the
        // Protocol/validation handlers below are not a free-text fallback;
        // ordinary language has already been stopped above if AI was eligible.
        const outOfStockQuestion = parseOutOfStockQuestion(body);

        // MEASURED FAILURE, three replies in the owner's own screenshot:
        //
        //   "nimeingiza trei 3 na mayai 15 leo"
        //   -> "Sijaelewa vizuri. Andika mauzo, matumizi, mkopo, au malipo..."
        //   "Mzigo mpya nimeingiza trei 3 na mayai 15 leo"
        //   -> the same sentence again, word for word.
        //
        // The model was never asked. isDailyRecordCandidate is true for any
        // record-SHAPED message, and it excluded all of them from the
        // assistant — including the ones the record parser then FAILS to read.
        // So a parser that could not understand the sentence still owned the
        // reply, and the only thing it had to say was that it did not
        // understand. Repeating that at somebody who has just rephrased for us
        // is the rudest thing this product does.
        //
        // The distinction that matters is not "does this look like a record"
        // but "can the deterministic path actually produce one":
        //
        //   parsed             -> code owns it. Exact, free, instant.
        //   clarify: amount    -> understood the record, needs the figure. A
        //                         targeted question is a real answer.
        //   clarify: ambiguity -> a draft exists and a specific choice is
        //                         being offered. Also a real answer.
        //   clarify: message   -> "I do not understand." That is a confession,
        //                         not an answer, and it is exactly the case
        //                         the model should have.
        //
        // Only the last one is handed over. Ordinary sales — the highest
        // volume messages in the product — still never touch the network.
        const wholeAnimalReading = parseWholeAnimalProcurement(body, lang);
        const wholeAnimalBreakdownReading = parseWholeAnimalBreakdown(body, lang);
        const supplierCreditReading = parseSupplierCreditPurchase(body, lang);
        const supplierPaymentReading = parseSupplierPayment(body, lang);
        const supplierBalanceQuestion = parseSupplierBalanceQuestion(body);
        const recordReading = isDailyRecordCandidate(body) ? parseDailyRecord(body, lang) : null;
        const recordUnreadable = recordReading?.kind === 'clarify' && recordReading.reason === 'message';
        const deterministicRecord = (Boolean(recordReading) && !recordUnreadable)
          || wholeAnimalReading.kind !== 'none'
          || supplierCreditReading.kind !== 'none'
          || supplierPaymentReading.kind !== 'none'
          || wholeAnimalBreakdownReading.kind !== 'none';
        // Product sales have a stricter catalogue-backed path than the generic
        // money parser. If any of these parsers understands the wording, Claude
        // is not called: aliases, units, pricing and missing-quantity state stay
        // free, exact and deterministic.
        const deterministicCatalogueTransaction = Boolean(
          parseSaleMissingQuantity(body)
          || parseCreditQuantitySale(body)
          || parseQuantityOnlySale(body),
        );


        if (!mixed && outOfStockQuestion) {
          const answered = await executeAssistantTool(
            db, identity, waMessageId, lang, 'get_stock_on_hand', { only_out_of_stock: true },
          );
          await reply(phone, answered.content);
          await audit(db, identity, waMessageId, 'stock_question', 'out_of_stock', 'applied');
          await finish('skipped');
          continue;
        }

        const productRequest = mixed ? null : (parseProductAnalyticsFollowUp(body, productContext) ?? parseProductAnalyticsRequest(body));
        if (productRequest) {
          await answerProductAnalytics(db, identity, phone, productRequest, lang, waMessageId);
          await audit(db, identity, waMessageId, 'product_analytics', productRequest.rankBy, 'applied');
          await finish('skipped');
          continue;
        }

        if (!mixed && supplierBalanceQuestion) {
          try {
            await reply(phone, await supplierBalanceReply(db, identity, supplierBalanceQuestion, lang));
            await audit(db, identity, waMessageId, 'supplier_balance', supplierBalanceQuestion.supplierName ?? 'all', 'applied');
          } catch {
            await reply(phone, lang === 'sw'
              ? 'Sikuweza kupata salio la suppliers sasa. Jaribu tena baadaye.'
              : 'I could not load supplier balances right now. Please try again later.');
            await audit(db, identity, waMessageId, 'supplier_balance', 'read', 'failed');
          }
          await finish('skipped');
          continue;
        }

        // There is deliberately no direct read-request classifier here.
        // Natural-language questions are owned by Claude and its read tools.
        // Keeping a second classifier after the AI gate is exactly what made
        // ordinary questions appear to be answered by a parser in production.

        // Unga, sukari, mafuta — a thing the shop WEIGHS, arriving before
        // anybody has said how it is measured. "Nimeuza unga 3" is three of
        // something, and three of something is a number no report can use.
        // Asked once, before the sale parsers see it; a product already in the
        // catalogue has been measured before and is never asked about again.
        if (!mixed && (isDailyRecordCandidate(writeBody)
          || parseSupplierCreditPurchase(writeBody, lang).kind !== 'none'
          || parseSupplierPayment(writeBody, lang).kind !== 'none'
          || parseWholeAnimalBreakdown(writeBody, lang).kind !== 'none')) {
          const supplierPayment = parseSupplierPayment(writeBody, lang);
          if (supplierPayment.kind !== 'none') {
            if (supplierPayment.kind !== 'parsed') {
              await replyQuietly(phone, supplierPayment.question);
              await audit(db, identity, waMessageId, 'supplier_payment', supplierPayment.kind, 'clarification');
              await finish('skipped');
              continue;
            }
            const wantedDate = resolveTransactionDate(writeBody);
            if (wantedDate.kind === 'invalid') {
              await replyQuietly(phone, transactionDateQuestion(wantedDate.reason, lang));
              await audit(db, identity, waMessageId, 'supplier_payment', 'date', 'clarification');
              await finish('skipped');
              continue;
            }
            const payment = supplierPayment.payment;
            const created = await createSupplierPaymentDraft(
              db, identity, waMessageId, payment, wantedDate.occurredAt,
            );
            const hint = String((created.error as { hint?: string } | null)?.hint ?? '');
            if (created.error || !created.id || !created.record) {
              await replyQuietly(phone, hint === 'supplier_overpayment'
                ? (lang === 'sw'
                  ? `Malipo ya TSh ${payment.amount.toLocaleString('en-US')} yanazidi deni la ${payment.supplierName}. Siwezi kuunda advance bila sera ya supplier prepayment.`
                  : `That payment exceeds ${payment.supplierName}'s outstanding balance. I cannot create a supplier advance without an explicit policy.`)
                : (lang === 'sw' ? 'Sikuweza kuhifadhi draft ya malipo haya. Tafadhali hakiki supplier, kiasi na njia ya malipo.' : 'I could not save this payment draft. Please check the supplier, amount, and payment method.'));
              await audit(db, identity, waMessageId, 'supplier_payment', 'draft', 'failed');
              await finish('skipped');
              continue;
            }
            const state: DailyRecordConversation = {
              kind: 'daily_record_confirmation', dailyRecordId: created.id,
              sourceMessageId: waMessageId, record: created.record,
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
              awaiting: 'payment_source', receipt_id: null, options: state,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await replyQuietly(phone, supplierPaymentConfirmation(payment, lang));
            await audit(db, identity, waMessageId, 'supplier_payment', 'create', 'pending');
            await finish('applied');
            continue;
          }

          const supplierCredit = parseSupplierCreditPurchase(writeBody, lang);
          if (supplierCredit.kind !== 'none') {
            if (supplierCredit.kind !== 'parsed') {
              await replyQuietly(phone, supplierCredit.question);
              await audit(db, identity, waMessageId, 'supplier_payable', supplierCredit.kind, 'clarification');
              await finish('skipped');
              continue;
            }
            const wantedDate = resolveTransactionDate(writeBody);
            if (wantedDate.kind === 'invalid') {
              await replyQuietly(phone, transactionDateQuestion(wantedDate.reason, lang));
              await audit(db, identity, waMessageId, 'supplier_payable', 'date', 'clarification');
              await finish('skipped');
              continue;
            }
            const created = await createSupplierCreditPurchaseDraft(
              db, identity, waMessageId, supplierCredit.purchase, wantedDate.occurredAt,
            );
            if (created.clarification) {
              await replyQuietly(phone, created.clarification);
              await audit(db, identity, waMessageId, 'supplier_payable', 'product', 'clarification');
              await finish('skipped');
              continue;
            }
            const hint = String((created.error as { hint?: string } | null)?.hint ?? '');
            if (created.error || !created.id || !created.record) {
              await replyQuietly(phone, hint === 'purchase_cost_required'
                ? (lang === 'sw'
                  ? 'Sina purchase cost iliyowekwa kwa bidhaa hii. Taja jumla ya ununuzi, kwa mfano: “kwa deni TSh 40000”.'
                  : 'No purchase cost is configured for this product. State the purchase total, for example: “on credit TZS 40000”.')
                : (lang === 'sw' ? 'Sikuweza kuhifadhi draft ya ununuzi huu wa deni. Tafadhali hakiki bidhaa, kiasi na jumla.' : 'I could not save this credit-purchase draft. Please check the product, quantity, and total.'));
              await audit(db, identity, waMessageId, 'supplier_payable', 'draft', 'failed');
              await finish('skipped');
              continue;
            }
            const state: DailyRecordConversation = {
              kind: 'daily_record_confirmation', dailyRecordId: created.id,
              sourceMessageId: waMessageId, record: created.record,
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
              awaiting: 'payment_source', receipt_id: null, options: state,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await replyDailyRecordConfirmationQuietly(phone, created.record, lang, waMessageId);
            await audit(db, identity, waMessageId, 'supplier_payable', 'create', 'pending');
            await finish('applied');
            continue;
          }

          const breakdownReading = parseWholeAnimalBreakdown(writeBody, lang);
          if (breakdownReading.kind === 'missing_quantity' || breakdownReading.kind === 'missing_product') {
            await replyQuietly(phone, breakdownReading.question);
            await audit(db, identity, waMessageId, 'whole_animal_breakdown', breakdownReading.kind, 'clarification');
            await finish('skipped');
            continue;
          }
          if (breakdownReading.kind === 'parsed') {
            const allSources = await listWholeAnimalBreakdownSources(db, identity);
            const sources = breakdownCandidatesFor(allSources, breakdownReading, writeBody);
            if (sources.length === 0) {
              await replyQuietly(phone, lang === 'sw'
                ? 'Sina procurement ya ng\'ombe iliyothibitishwa na ambayo bado haijavunjwa. Thibitisha ununuzi kwanza; hakuna stock iliyoongezwa.'
                : 'I found no confirmed whole-animal procurement that is still available for breakdown. Confirm the purchase first; no stock was added.');
              await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'source', 'clarification');
              await finish('skipped');
              continue;
            }
            if (sources.length > 1) {
              const state: WholeAnimalBreakdownSourceSelection = {
                kind: 'whole_animal_breakdown_source_selection',
                sourceMessageId: waMessageId,
                outputs: breakdownReading.outputs,
                candidates: sources,
              };
              await db.from('whatsapp_conversations').upsert({
                identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
                awaiting: 'payment_source', receipt_id: null, options: state,
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
              }, { onConflict: 'identity_id' });
              await replyQuietly(phone, wholeAnimalSourceQuestion(sources, lang));
              await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'source', 'clarification');
              await finish('skipped');
              continue;
            }
            const result = await createWholeAnimalBreakdownDraft(
              db, identity, breakdownReading, sources[0], waMessageId,
            );
            if (result.clarification) {
              await replyQuietly(phone, result.clarification);
              await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'output', 'clarification');
              await finish('skipped');
              continue;
            }
            if (result.error || !result.id) {
              await replyQuietly(phone, lang === 'sw'
                ? 'Sikuweza kuhifadhi breakdown hii. Hakuna stock ya nyama iliyoongezwa; jaribu tena.'
                : 'I could not save this breakdown. No meat stock was added; please try again.');
              await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'draft', 'failed');
              await finish('skipped');
              continue;
            }
            const state: WholeAnimalBreakdownConfirmationState = {
              kind: 'whole_animal_breakdown_confirmation',
              dailyRecordId: result.id,
              sourceMessageId: waMessageId,
              outputs: result.outputs,
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
              awaiting: 'payment_source', receipt_id: null, options: state,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await replyQuietly(phone, wholeAnimalBreakdownConfirmation(result.outputs, lang));
            await audit(db, identity, waMessageId, 'whole_animal_breakdown', 'create', 'pending');
            await finish('applied');
            continue;
          }
          // ── Bucha phase 6: the animal arrives, but its products do not ───
          //
          // A whole cow is procured as one input asset. It intentionally has
          // no daily_record_lines: those are product-stock movements, and the
          // kilograms and offal do not exist until a later measured breakdown.
          const procurementReading = parseWholeAnimalProcurement(writeBody, lang);
          if (procurementReading.kind === 'missing') {
            await replyQuietly(phone, procurementReading.question);
            await audit(db, identity, waMessageId, 'whole_animal_procurement',
              procurementReading.missing.join(','), 'clarification');
            await finish('skipped');
            continue;
          }
          if (procurementReading.kind === 'parsed') {
            const wantedDate = resolveTransactionDate(writeBody);
            if (wantedDate.kind === 'invalid') {
              await replyQuietly(phone, transactionDateQuestion(wantedDate.reason, lang));
              await audit(db, identity, waMessageId, 'whole_animal_procurement', 'date', 'clarification');
              await finish('skipped');
              continue;
            }
            const procurement = procurementReading.procurement;
            const occurredAt = wantedDate.occurredAt;
            const { data: procurementId, error: procurementError } = await db.rpc(
              'wa_create_whole_animal_procurement_draft',
              {
                p_profile_id: identity.profile_id,
                p_company_id: identity.company_id,
                p_animal_type: procurement.animalType,
                p_animal_count: procurement.animalCount,
                p_purchase_total: procurement.purchaseTotal,
                p_supplier_name: procurement.supplierName,
                p_payment_method: procurement.paymentMethod,
                p_occurred_at: occurredAt ?? new Date().toISOString(),
                p_source_message_id: waMessageId,
                p_reference: procurement.reference,
                p_note: procurement.note,
              },
            );
            if (procurementError || !procurementId) {
              await replyQuietly(phone, lang === 'sw'
                ? 'Sikuweza kuhifadhi draft ya ununuzi huu. Hakuna stock ya nyama iliyoongezwa; jaribu tena.'
                : 'I could not save this procurement draft. No meat stock was added; please try again.');
              await audit(db, identity, waMessageId, 'whole_animal_procurement', 'draft', 'failed');
              await finish('skipped');
              continue;
            }
            const record: ParsedDailyRecord = {
              kind: 'whole_animal_procurement',
              amount: procurement.purchaseTotal,
              partyName: procurement.supplierName,
              description: `${procurement.animalType} mzima`,
              lines: [],
              paymentMethod: procurement.paymentMethod,
              occurredAt,
              confidence: 0.99,
            };
            const state: DailyRecordConversation = {
              kind: 'daily_record_confirmation',
              dailyRecordId: String(procurementId),
              sourceMessageId: waMessageId,
              record,
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'payment_source',
              receipt_id: null,
              options: state,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await replyQuietly(phone, wholeAnimalProcurementConfirmation(procurement, occurredAt, lang));
            await audit(db, identity, waMessageId, 'whole_animal_procurement', 'create', 'pending');
            await finish('applied');
            continue;
          }

          const { data: catalogueRows } = await db.rpc('company_product_names', {
            p_company_id: identity.company_id,
          });
          const measured = findUnregisteredMeasure(
            writeBody,
            ((catalogueRows ?? []) as Array<Record<string, unknown>>)
              .map((row) => String(row.product_name ?? '').trim()).filter(Boolean),
          );
          if (measured) {
            await reply(phone, unregisteredMeasureQuestion(measured.product, lang));
            await audit(db, identity, waMessageId, 'measure_setup', measured.product, 'clarification');
            await finish('skipped');
            continue;
          }
        }

        // "Futa ile" is propose_record_void now, not a regex.
        //
        // The parser that used to sit here needed one of nine undo verbs AND
        // one of a dozen nouns, and could only ever reach the LAST record. So
        // "nimekosea" reached nothing, "ondoa manunuzi ya feni" reached the
        // wrong entry, and a shopkeeper who had recorded two more sales since
        // the mistake had no way back at all.
        //
        // The model reads the wording; the server still finds the record,
        // shows it, and waits for NDIYO. Nothing about who may delete what
        // moved — the same role check and the same confirmation guard the same
        // write.

        // REMOVED: the last four parsers standing in front of Claude.
        //
        // A trend question, a request for advice, "bei ya daftari ni ngapi" and
        // "nina birika ngapi" each had a regex gate here that answered before
        // the model ever saw the message. Every one of the four already has a
        // tool — get_sales_trend, get_business_advice, get_selling_price,
        // get_stock_on_hand — so the gate added nothing except a second, worse
        // way of understanding the same sentence: the parser matched its own
        // phrasings and nobody else's, and a message it half-recognised was
        // answered with the wrong period or the wrong product rather than
        // passed on.
        //
        // The owner's rule, and it is the right one: no parser in front of the
        // model except a confirmation and a one-word command, where the wording
        // IS the protocol.

        // REMOVED: the legacy semantic-read path.
        //
        // It ran whenever the model was skipped, read the trader's business
        // language with its own intent classifier, and answered from a fixed
        // renderer. That is the parser standing in front of Claude that this
        // programme spent weeks removing, still breathing behind an
        // "!aiEligible" guard — and it was still costing real answers: asked
        // "niambie siku gani biashara ilifanya vizuri", it replied with today's
        // summary, all zeros, in the voice the owner had objected to.
        //
        // Every reason a message could be ineligible now has its own branch
        // above this line: a parked question is answered by the handler that
        // parked it, and a system command by the command itself. A language
        // instruction carrying a question no longer counts as either — the
        // instruction is obeyed and the question travels on to the model.
        //
        // Nothing takes its place on purpose. A business question that reaches
        // here without being eligible is a routing bug, and it should look like
        // one rather than be papered over with a template.

        if (resumedQuantitySale || isDailyRecordCandidate(writeBody)) {
          // MEASURED FAILURE: a thirty-line till roll naming no money at all was
          // reaching parseDailyRecordBatch first, which asked "is this the total
          // or the price for each?" — a question with no answer, since the
          // message contains no price to be either. The quantity path below
          // already knows what to do with it; the batch parser must stand aside
          // rather than ask.
          const namesNoMoney = resumedQuantitySale !== null
            || parseQuantityOnlySale(writeBody) !== null;
          const batch: DailyRecordBatchParse = namesNoMoney
            ? { kind: 'none' }
            : parseDailyRecordBatch(writeBody, lang);
          if (batch.kind === 'clarify') {
            const state: DailyRecordBatchClarification = {
              ...batch.state,
              sourceMessageId: waMessageId,
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'payment_source',
              receipt_id: null,
              options: state,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await reply(phone, batch.question);
            await audit(db, identity, waMessageId, 'daily_record_batch', 'clarify', 'pending');
            await finish('skipped');
            continue;
          }
          if (batch.kind === 'unreadable') {
            await reply(phone, batch.message);
            await audit(db, identity, waMessageId, 'daily_record_batch', 'clarify', 'unreadable');
            await finish('skipped');
            continue;
          }
          if (batch.kind === 'parsed') {
            if (batch.records.length === 1) {
              const guardedRecord = await addHistoricalPriceWarnings(db, identity.company_id, batch.records[0]);
              const created = await createDailyRecordDraft(db, identity, waMessageId, guardedRecord, lang, body ?? undefined);
              if (created.error || !created.id) {
                await reply(phone, lang === 'sw'
                  ? 'Sikuweza kuhifadhi draft hii. Tafadhali jaribu tena.'
                  : 'I could not save this draft. Please try again.');
                await audit(db, identity, waMessageId, 'daily_record', 'create', 'failed');
                await finish('skipped', 'daily_record_create_failed');
                continue;
              }
              const state: DailyRecordConversation = {
                kind: 'daily_record_confirmation',
                dailyRecordId: created.id,
                sourceMessageId: waMessageId,
                record: guardedRecord,
              };
              await db.from('whatsapp_conversations').upsert({
                identity_id: identity.id,
                company_id: identity.company_id,
                profile_id: identity.profile_id,
                awaiting: 'payment_source',
                receipt_id: null,
                options: state,
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                updated_at: new Date().toISOString(),
              }, { onConflict: 'identity_id' });
              await replyDailyRecordConfirmationQuietly(phone, guardedRecord, lang, waMessageId);
              await audit(db, identity, waMessageId, 'daily_record', 'create', 'pending');
              await finish('skipped');
              continue;
            }
            const guardedRecords = await Promise.all(batch.records.map((record) =>
              addHistoricalPriceWarnings(db, identity.company_id, record)));
            const created = await createDailyRecordBatchDrafts(db, identity, waMessageId, guardedRecords, lang);
            if (created.error || created.ids.length !== guardedRecords.length) {
              await reply(phone, lang === 'sw'
                ? 'Sikuweza kuandaa rekodi hizi pamoja. Hakuna rekodi mpya iliyohifadhiwa; tafadhali jaribu tena.'
                : 'I could not prepare these records together. No new record was saved; please try again.');
              await audit(db, identity, waMessageId, 'daily_record_batch', 'create', 'failed');
              await finish('skipped', 'daily_record_batch_create_failed');
              continue;
            }
            const state: DailyRecordBatchConversation = {
              kind: 'daily_record_batch_confirmation',
              sourceMessageId: waMessageId,
              dailyRecordIds: created.ids,
              records: guardedRecords,
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'payment_source',
              receipt_id: null,
              options: state,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
              await replyDailyRecordBatchConfirmationQuietly(phone, guardedRecords, lang, waMessageId);
            await audit(db, identity, waMessageId, 'daily_record_batch', 'create', 'pending');
            await finish('skipped');
            continue;
          }
          // A sale that states quantities and no money is priced from the shop's
          // own list before anything asks the trader to retype a price they
          // already gave. Only reached when no parser above claimed the message.
          // Goods that walked out unpaid. The wrapper is read here and the
          // ── the goods were named and the number was not ──────────────────
          //
          // Before this, every such message reached the record parser, which
          // asked for the AMOUNT — the money — because that is the field it
          // knew was missing. Answering "5" to "how much?" made a sale of five
          // shillings.
          //
          // The product is resolved NOW, so a question is never asked about
          // something this shop does not sell, and the measure is settled now
          // too: where the shop declared several ways of selling it, asking
          // "how many?" would invite an answer nobody could price.
          const wantsQuantity = resumedQuantitySale ? null : parseSaleMissingQuantity(writeBody);
          if (wantsQuantity) {
            const wantedDate = resolveTransactionDate(writeBody);
            if (wantedDate.kind === 'invalid') {
              await replyQuietly(phone, transactionDateQuestion(wantedDate.reason, lang));
              await audit(db, identity, waMessageId, 'quantity_wanted', 'date', 'clarification');
              await finish('skipped');
              continue;
            }
            const found = await resolveProductForRead(db, identity, wantsQuantity.product);
            if (!found.error && found.resolution.kind === 'matched') {
              const match = found.resolution.match;
              const { data: unitRows } = await db.rpc('wa_company_product_sale_units', {
                p_company_id: identity.company_id,
              });
              const units = ((unitRows ?? []) as Array<Record<string, unknown>>)
                .filter((row) => String(row.product_key ?? '') === match.productKey)
                .map((row) => String(row.unit_name ?? '')).filter(Boolean);

              await db.from('whatsapp_conversations').upsert({
                identity_id: identity.id,
                company_id: identity.company_id,
                profile_id: identity.profile_id,
                awaiting: 'daily_record_quantity',
                receipt_id: null,
                options: {
                  ...wantsQuantity, product: match.productName, occurredAt: wantedDate.occurredAt,
                },
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                updated_at: new Date().toISOString(),
              }, { onConflict: 'identity_id' });

              await reply(phone, units.length > 1
                ? quantityUnitQuestion(match.productName, units, lang)
                : quantityQuestion(match.productName, units[0] ?? null, lang));
              await audit(db, identity, waMessageId, 'quantity_wanted',
                units.length > 1 ? 'unit_required' : 'asked', 'pending');
              await finish('applied');
              continue;
            }
          }

          // GOODS go through the ordinary quantity parser, so an alias and a
          // measure said out loud behave exactly as they do in a paid sale.
          const creditSale = resumedQuantitySale ? null : parseCreditQuantitySale(writeBody);
          const quantitySale = resumedQuantitySale ?? creditSale?.sale ?? parseQuantityOnlySale(writeBody);
          if (quantitySale) {
            const requestedDate = resumedQuantitySale
              ? { kind: 'historical' as const, occurredAt: resumedQuantityOccurredAt }
              : resolveTransactionDate(writeBody);
            if (requestedDate.kind === 'invalid') {
              await replyQuietly(phone, transactionDateQuestion(requestedDate.reason, lang));
              await audit(db, identity, waMessageId, 'quantity_sale', 'date', 'clarification');
              await finish('skipped');
              continue;
            }
            const quantityOccurredAt = resumedQuantitySale
              ? resumedQuantityOccurredAt
              : requestedDate.occurredAt;
            const quantityCredit = resumedQuantityCredit
              ?? (creditSale ? { party: creditSale.party } : null);
            const quantityPaymentMethod = resumedQuantityPaymentMethod
              ?? extractPaymentMethod(writeBody)?.method
              ?? null;
            const priced = await priceQuantitySale(
              db, identity, quantitySale, lang, settledCombos,
              quantityCredit, quantityOccurredAt,
            );
            if (priced.kind === 'unknown') {
              if (!canUseCompanyFinanceReads(identity.role)) {
                await replyQuietly(phone, newProductSaleWorkerBlocked(priced.products, lang));
                await audit(db, identity, waMessageId, 'quantity_sale', 'unknown_product', 'blocked');
                await finish('skipped');
                continue;
              }
              const state: NewProductSaleSetup = {
                kind: 'new_product_sale_setup',
                missingProducts: priced.products,
                sale: priced.sale,
                sourceMessageId: waMessageId,
                credit: quantityCredit,
                paymentMethod: quantityPaymentMethod,
                occurredAt: quantityOccurredAt,
              };
              await db.from('whatsapp_conversations').upsert({
                identity_id: identity.id,
                company_id: identity.company_id,
                profile_id: identity.profile_id,
                awaiting: 'product_cost',
                receipt_id: null,
                options: state,
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                updated_at: new Date().toISOString(),
              }, { onConflict: 'identity_id' });
              await replyQuietly(phone, newProductSaleOffer(priced.products, lang));
              await audit(db, identity, waMessageId, 'quantity_sale', 'unknown_product', 'pending');
              await finish('skipped');
              continue;
            }
            if (priced.kind === 'combo_variant') {
              await askWhichVariant(
                priced.phrase, priced.token, priced.candidates, priced.sale, waMessageId,
                quantityCredit, quantityPaymentMethod,
                quantityOccurredAt,
              );
              await audit(db, identity, waMessageId, 'quantity_sale', 'combo_variant', 'pending');
              await finish('skipped');
              continue;
            }
            if (priced.kind === 'combo_question') {
              await askAboutCombo(priced.splits[0], priced.sale, priced.units, waMessageId,
                quantitySale.items.find((item) =>
                  comboKey(item.product) === comboKey(priced.splits[0].phrase))?.quantity ?? 1,
                quantityCredit, quantityPaymentMethod, quantityOccurredAt);
              await audit(db, identity, waMessageId, 'quantity_sale', 'combo', 'pending');
              await finish('skipped');
              continue;
            }
            if (priced.kind === 'band') {
              await askForPriceBand(
                priced.choices, priced.sale, waMessageId, '',
                quantityCredit, quantityPaymentMethod,
                quantityOccurredAt,
                priced.settled ?? [],
              );
              await audit(db, identity, waMessageId, 'quantity_sale', 'band', 'pending');
              await finish('skipped');
              continue;
            }
            if (priced.kind === 'blocked') {
              if (priced.choice) {
                const state: ProductChoicePending = {
                  kind: 'product_read_choice',
                  asked: priced.choice.asked,
                  candidates: priced.choice.candidates,
                  originalText: body ?? '',
                  sourceMessageId: waMessageId,
                };
                await db.from('whatsapp_conversations').upsert({
                  identity_id: identity.id,
                  company_id: identity.company_id,
                  profile_id: identity.profile_id,
                  awaiting: 'product_cost',
                  receipt_id: null,
                  options: state,
                  expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                  updated_at: new Date().toISOString(),
                }, { onConflict: 'identity_id' });
              }
              await reply(phone, priced.message);
              await audit(db, identity, waMessageId, 'quantity_sale', 'priced', 'clarification');
              await finish('skipped');
              continue;
            }
            if (priced.kind === 'priced') {
              const recordWithPayment = quantityPaymentMethod
                ? { ...priced.record, paymentMethod: quantityPaymentMethod }
                : priced.record;
              const guardedRecord = await addHistoricalPriceWarnings(
                db, identity.company_id, recordWithPayment);
              // Money out, written at the foot of the same paste, is a separate
              // record — never netted off the takings. Both are drafted in one
              // transaction so a NDIYO can never confirm the sales and lose the
              // spending, which is the half nobody would notice was missing.
              const closingRecords: ParsedDailyRecord[] = [guardedRecord];
              for (const spent of quantitySale.expenses) {
                closingRecords.push({
                  kind: 'expense',
                  amount: spent.amount,
                  partyName: null,
                  description: spent.label,
                  lines: [],
                  confidence: 0.95,
                  occurredAt: quantityOccurredAt,
                });
              }
              if (closingRecords.length > 1) {
                const batch = await createDailyRecordBatchDrafts(
                  db, identity, waMessageId, closingRecords, lang);
                if (!batch.error && batch.ids.length > 0) {
                  await db.from('whatsapp_conversations').upsert({
                    identity_id: identity.id,
                    company_id: identity.company_id,
                    profile_id: identity.profile_id,
                    awaiting: 'payment_source',
                    receipt_id: null,
                    options: {
                      kind: 'daily_record_batch_confirmation',
                      dailyRecordIds: batch.ids,
                      sourceMessageId: waMessageId,
                      records: closingRecords,
                    },
                    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                    updated_at: new Date().toISOString(),
                  }, { onConflict: 'identity_id' });
                  await replyQuietly(phone,
                    quantitySaleConfirmation(priced.lines, lang, quantitySale.expenses, priced.notCounted)
                  + comboNotice(priced.combos, lang)
                  + offerNewProducts(priced.notCounted, lang));
                  await audit(db, identity, waMessageId, 'quantity_sale',
                    `${priced.lines.length}+${quantitySale.expenses.length}`, 'pending');
                  await finish('skipped');
                  continue;
                }
              }
              const created = await createDailyRecordDraft(db, identity, waMessageId, guardedRecord, lang, body ?? undefined);
              if (!created.error && created.id) {
                const state: DailyRecordConversation = {
                  kind: 'daily_record_confirmation',
                  dailyRecordId: created.id,
                  sourceMessageId: waMessageId,
                  record: guardedRecord,
                  ...(priced.combos.length > 0 ? { combos: priced.combos } : {}),
                };
                await db.from('whatsapp_conversations').upsert({
                  identity_id: identity.id,
                  company_id: identity.company_id,
                  profile_id: identity.profile_id,
                  awaiting: 'payment_source',
                  receipt_id: null,
                  options: state,
                  expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                  updated_at: new Date().toISOString(),
                }, { onConflict: 'identity_id' });
                await replyQuietly(phone, quantitySaleConfirmation(priced.lines, lang, quantitySale.expenses, priced.notCounted)
                  + comboNotice(priced.combos, lang)
                  + offerNewProducts(priced.notCounted, lang));
                await audit(db, identity, waMessageId, 'quantity_sale', 'create', 'pending');
                await finish('skipped');
                continue;
              }
            }
            // Anything else falls through to the parsers below, unchanged.
          }

          let parsed = parseDailyRecord(writeBody, lang);
          // "Bei hii ni jumla au bei ya kila moja?" is a fair question about a
          // product nobody has priced. It is a silly one about a product the
          // shop priced last week — the owner's words: "its insane to ask if
          // this is reja reja or jumla for ugali". The price list can tell the
          // two readings apart, so it does, and the question survives only when
          // neither reading matches what the shop actually charges.
          if (parsed.kind === 'clarify' && parsed.reason === 'ambiguity' && parsed.draft) {
            const settled = await settlePriceAmbiguity(db, identity, parsed.draft);
            if (settled) parsed = settled;
          }
          if (parsed.kind === 'clarify') {
            if (parsed.draft) {
              await db.from('whatsapp_conversations').upsert({
                identity_id: identity.id,
                company_id: identity.company_id,
                profile_id: identity.profile_id,
                awaiting: 'payment_source',
                receipt_id: null,
                options: { ...parsed.draft, sourceMessageId: waMessageId },
                expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
                updated_at: new Date().toISOString(),
              }, { onConflict: 'identity_id' });
            }
            if (!parsed.draft && parsed.reason !== 'ambiguity') {
              const budget = await consumeAiBudget(db, identity, body.length);
              if (!budget.allowed) {
                await reply(phone, aiBudgetMessage(lang, budget.resetAt, budget.reason));
                await audit(db, identity, waMessageId, 'daily_record_ai_fallback', 'budget', 'blocked');
                await finish('skipped', 'ai_budget_blocked');
                continue;
              }
              const aiRecord = await interpretDailyRecordWithAi(body, lang);
              if (aiRecord) {
                const guardedRecord = await addHistoricalPriceWarnings(db, identity.company_id, aiRecord);
                const created = await createDailyRecordDraft(db, identity, waMessageId, guardedRecord, lang, body ?? undefined);
                if (!created.error && created.id) {
                  const state: DailyRecordConversation = {
                    kind: 'daily_record_confirmation', dailyRecordId: created.id, sourceMessageId: waMessageId, record: guardedRecord,
                  };
                  await db.from('whatsapp_conversations').upsert({
                    identity_id: identity.id, company_id: identity.company_id, profile_id: identity.profile_id,
                    awaiting: 'payment_source', receipt_id: null, options: state,
                    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), updated_at: new Date().toISOString(),
                  }, { onConflict: 'identity_id' });
                await replyDailyRecordConfirmationQuietly(phone, guardedRecord, lang, waMessageId);
                  await audit(db, identity, waMessageId, 'daily_record_ai_fallback', 'create', 'pending');
                  await finish('skipped');
                  continue;
                }
              }
            }
            await reply(phone, parsed.question);
            await audit(db, identity, waMessageId, 'daily_record', 'clarify', parsed.reason);
            await finish('skipped');
            continue;
          }
          if (parsed.kind === 'parsed') {
            const guardedRecord = await addHistoricalPriceWarnings(db, identity.company_id, parsed.record);
            const created = await createDailyRecordDraft(db, identity, waMessageId, guardedRecord, lang, body ?? undefined);
            if (created.error || !created.id) {
              await reply(phone, lang === 'sw'
                ? 'Sikuweza kuhifadhi draft hii. Tafadhali jaribu tena.'
                : 'I could not save this draft. Please try again.');
              await audit(db, identity, waMessageId, 'daily_record', 'create', 'failed');
              await finish('skipped', 'daily_record_create_failed');
              continue;
            }
            const state: DailyRecordConversation = {
              kind: 'daily_record_confirmation',
              dailyRecordId: created.id,
              sourceMessageId: waMessageId,
              record: guardedRecord,
            };
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'payment_source',
              receipt_id: null,
              options: state,
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
              await replyDailyRecordConfirmationQuietly(phone, guardedRecord, lang, waMessageId);
            await audit(db, identity, waMessageId, 'daily_record', 'create', 'pending');
            await finish('skipped');
            continue;
          }
        }

        // ── Which business am I recording into? ─────────────────────────
        if (isSwitchRequest(body)) {
          const { data: rows } = await db.rpc('wa_memberships', { p_phone: phone });
          const list = (rows ?? []) as { company_id: string; company_name: string; role: string; is_active: boolean }[];
          if (list.length <= 1) {
            await reply(phone, lang === 'sw'
              ? `Una biashara moja tu: ${list[0]?.company_name ?? '-'}`
              : `You only have one business: ${list[0]?.company_name ?? '-'}`);
          } else {
            await db.from('whatsapp_conversations').upsert({
              identity_id: identity.id,
              company_id: identity.company_id,
              profile_id: identity.profile_id,
              awaiting: 'business',
              options: list.map((r) => ({ id: r.company_id, name: r.company_name })),
              expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
              updated_at: new Date().toISOString(),
            }, { onConflict: 'identity_id' });
            await reply(phone, businessList(list, lang));
          }
          await finish('skipped', 'business_list');
          continue;
        }

        if (convo?.awaiting === 'business') {
          const options = (convo.options ?? []) as { id: string; name: string }[];
          const idx = parseBusinessChoice(body, options.length);
          if (idx === null) {
            await reply(phone, businessList(
              options.map((o) => ({ company_name: o.name, role: '', is_active: false })), lang));
            await finish('skipped', 'business_choice_unclear');
            continue;
          }
          // Only ever an index into the list we just sent. A company id typed
          // into a message is never trusted.
          const { data: name, error: swErr } = await db.rpc('wa_switch_active_company', {
            p_phone: phone, p_company: options[idx].id,
          });
          await clearConversation(db, identity.id as string);
          await reply(phone, swErr
            ? swErr.message
            : (lang === 'sw' ? `Sasa unatumia: ${name}` : `You are now using: ${name}`));
          await audit(db, identity, waMessageId, 'switch_business', String(options[idx].id), swErr ? 'failed' : 'applied');
          await finish('skipped');
          continue;
        }

        if (intent === 'change_language') {
          const next = parseLanguageCommand(body)!;
          // Syncs the choice onto the person too, so the web opens in the
          // language they picked here. The browser keeps its own override.
          await db.rpc('wa_set_language', { p_phone: phone, p_lang: next });
          await clearConversation(db, identity.id as string);
          await reply(phone, t('languageSet', next));
          await audit(db, identity, waMessageId, 'change_language', next, 'applied');
          await finish('skipped');
          continue;
        }

        if (intent === 'cancel_action') {
          await clearConversation(db, identity.id as string);
          await clearAssistantMemory(db, identity);
          await reply(phone, t('cancelled', lang));
          await audit(db, identity, waMessageId, 'cancel_action', 'clear_state', 'applied');
          await finish('skipped');
          continue;
        }

        // Answering a question we asked. Language selection is handled first
        // because it is the only one a brand-new user can be in.
        if (convo?.awaiting === 'language') {
          const picked = /^1$/.test((body ?? '').trim()) ? 'sw'
            : /^2$/.test((body ?? '').trim()) ? 'en'
            : parseLanguageCommand(body);
          if (picked) {
            await db.from('whatsapp_identities').update({ lang: picked, updated_at: new Date().toISOString() })
              .eq('id', identity.id);
            await clearConversation(db, identity.id as string);
            await reply(phone, `${t('languageSet', picked)}\n\n${t('help', picked)}`);
            await finish('skipped');
            continue;
          }
          await reply(phone, t('chooseLanguage', lang));
          await finish('skipped');
          continue;
        }

        if (convo?.awaiting === 'project' && isProjectSetupState(convo.options)) {
          const setup = convo.options as ProjectSetupState;
          const { data: company } = await db.from('companies')
            .select('name').eq('id', identity.company_id).maybeSingle();
          const companyName = String(company?.name ?? 'your business');

          if (setup.stage === 'choose') {
            const choice = parseProjectSetupChoice(body);
            if (choice === 3) {
              const next: ProjectSetupState = { ...setup, stage: 'name' };
              await db.from('whatsapp_conversations').update({ options: next, updated_at: new Date().toISOString() })
                .eq('identity_id', identity.id);
              await reply(phone, projectSetupNamePrompt(lang));
            } else if (choice === 1 || choice === 2) {
              const projectName = choice === 1 ? 'General' : (sanitizeProjectName(companyName) ?? 'General');
              const next: ProjectSetupState = { ...setup, stage: 'confirm', projectName };
              await db.from('whatsapp_conversations').update({ options: next, updated_at: new Date().toISOString() })
                .eq('identity_id', identity.id);
              await reply(phone, projectSetupConfirmation(lang, projectName));
            } else {
              await reply(phone, projectSetupPrompt(lang, companyName));
            }
            await finish('skipped');
            continue;
          }

          if (setup.stage === 'name') {
            const projectName = sanitizeProjectName(body);
            if (!projectName) {
              await reply(phone, lang === 'sw'
                ? 'Jina la project ni fupi sana. Jaribu tena.'
                : 'That project name is too short. Try again.');
              await finish('skipped');
              continue;
            }
            const next: ProjectSetupState = { ...setup, stage: 'confirm', projectName };
            await db.from('whatsapp_conversations').update({ options: next, updated_at: new Date().toISOString() })
              .eq('identity_id', identity.id);
            await replyQuietly(phone, projectSetupConfirmation(lang, projectName));
            await finish('skipped');
            continue;
          }

          const confirmed = parseProjectSetupConfirmation(body);
          if (confirmed === false) {
            const next: ProjectSetupState = { ...setup, stage: 'choose', projectName: undefined };
            await db.from('whatsapp_conversations').update({ options: next, updated_at: new Date().toISOString() })
              .eq('identity_id', identity.id);
            await replyQuietly(phone, projectSetupPrompt(lang, companyName));
            await finish('skipped');
            continue;
          }
          if (confirmed !== true || !setup.projectName) {
            await replyQuietly(phone, projectSetupConfirmation(lang, setup.projectName ?? 'General'));
            await finish('skipped');
            continue;
          }

          const project = await createOrReuseProject(db, identity, setup.projectName);
          if (!project) {
            await replyQuietly(phone, lang === 'sw'
              ? 'Sikuweza kutengeneza project sasa. Hakikisha wewe ni owner au accountant, kisha jaribu tena.'
              : 'I could not create that project right now. Make sure you are the owner or accountant, then try again.');
            await finish('skipped');
            continue;
          }
          const resumed = await resumePendingReceipt(db, identity, setup.mediaMessageId);
          await clearConversation(db, identity.id as string);
          await replyQuietly(phone, resumed
            ? projectSetupCreatedReply(lang, project.name)
            : (lang === 'sw' ? `Project "${project.name}" iko tayari.` : `Project "${project.name}" is ready.`));
          await audit(db, identity, waMessageId, 'project_setup', project.created ? 'created' : 'reused', resumed ? 'applied' : 'no_pending_receipt');
          await finish('skipped');
          continue;
        }

        if (convo?.awaiting === 'project' && convo.receipt_id) {
          const options = (convo.options as ProjectRef[] | null) ?? [];
          const chosen = parseProjectChoice(body, options);
          if (!chosen) {
            await replyQuietly(
              phone,
              lang === 'sw'
                ? 'Sijaelewa. Jibu na namba ya mradi kutoka kwenye orodha, au andika *ghairi*.'
                : 'I did not catch that. Reply with the number of the project from the list, or type *cancel*.',
            );
            await finish('skipped');
            continue;
          }
          // Scope the write by company as well as id: a stale conversation row can
          // never be used to move a receipt belonging to another tenant.
          await db.from('receipts')
            .update({ project_id: chosen.id })
            .eq('id', convo.receipt_id)
            .eq('company_id', identity.company_id);
          await clearConversation(db, identity.id as string);
          await replyQuietly(
            phone,
            lang === 'sw'
              ? `Sawa. Risiti imewekwa kwenye ${chosen.name}. Kamilisha kategoria na chanzo cha malipo hapa:\n${appUrl()}/receipts?receipt=${convo.receipt_id}`
              : `Done. Filed under ${chosen.name}. Finish the category and payment source here:\n${appUrl()}/receipts?receipt=${convo.receipt_id}`,
          );
          await audit(db, identity, waMessageId, 'clarification_reply', 'project_selected', 'applied', convo.receipt_id as string);
          await finish('skipped');
          continue;
        }

        // Nothing pending: help, a truthful failure, or a polite scope boundary.
        // Two honest outcomes and no third. Either the model answered, or the
        // shop is told the AI could not — never an old template sent under the
        // assistant's name, which is what "Biashara inaendaje so far" received
        // after a two-minute wait.
        const aiWasTried = assistantCameBackEmpty || aiFailureClass !== null;
        const fallbackIsOperational = Boolean(conversationalAiBudgetBlock || aiWasTried);
        await replyQuietly(phone, conversationalAiBudgetBlock
          ? aiBudgetMessage(lang, conversationalAiBudgetBlock.resetAt, conversationalAiBudgetBlock.reason)
          : aiWasTried
            ? assistantClarificationQuestion(lang, body, pendingClarificationOf(convo))
            : (intent === 'help' ? `${t('help', lang)}\n\n${buildKnowledgeReply(body, lang)}` : t('onlyRisip', lang)),
          !fallbackIsOperational);
        await finish('skipped');
        } catch (err) {
          // Whatever went wrong is recorded on the message itself, so the next
          // person looking has the reason instead of a row stuck on 'pending'.
          const reason = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown_error';
          try {
            await db.from('whatsapp_messages')
              .update({ status: 'failed', last_error: reason.slice(0, 500), processed_at: new Date().toISOString() })
              .eq('wa_message_id', waMessageId);
          } catch { /* the update must never mask the original failure */ }
          console.error('message failed', maskPhone(phone), reason);
          // And the shop is told. Silence reads as Risip ignoring them, which
          // is worse than an error and harder to report.
          try {
            await sendReplyText(phone, 'Samahani, kuna hitilafu kwa upande wangu. Jaribu tena baada ya dakika moja.', waMessageId);
          } catch { /* nothing more can be done for this message */ }
        } finally {
          stopTypingHeartbeat();
          stopTurnHeartbeat();
          // The seal is per message and the turn is over, so it has nothing
          // left to protect. Left behind it would grow for the life of the
          // isolate.
          clearTypingSeal(waMessageId);
          await releaseWhatsAppTurn(db, phone, turnOwner);
        }
  }

  nudgeWorker();
  };

  const runtime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (work: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (typeof runtime?.waitUntil === 'function') {
    // Keeps the isolate alive past the response instead of racing its teardown.
    runtime.waitUntil(processAll());
  } else {
    await processAll();
  }

  // Always 200: a non-200 makes Meta retry a payload we have already recorded.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
