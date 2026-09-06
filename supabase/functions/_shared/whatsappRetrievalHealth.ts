/** Retrieval availability is a fact, not an empty product catalogue. */
export type RetrievalSource = 'vocabulary' | 'products' | 'units' | 'prices';
export type RetrievalHealth = Record<RetrievalSource, 'available' | 'partial' | 'unavailable'>;
export type RetrievalStatus = 'available' | 'partial' | 'unavailable';

export function overallRetrievalStatus(health: RetrievalHealth): RetrievalStatus {
  const values = Object.values(health);
  if (values.includes('unavailable')) return 'unavailable';
  if (values.includes('partial')) return 'partial';
  return 'available';
}

export function retrievalHealthContext(health: RetrievalHealth): string {
  return 'LIVE RETRIEVAL STATUS: ' + JSON.stringify(health)
    + '\nThis is a bounded sample, not the complete inventory. A missing item is NOT proof that it does not exist. '
    + 'Unavailable means a lookup failed, not zero stock, zero price, or a missing product. '
    + 'Use the company-scoped database tools to verify the specific product before making claims. '
    + 'Never use a current price sample to price a historical sale; the backend reprices at the transaction date.';
}

/** Fail closed for proposals that depend on the failed catalogue lookup. */
export function catalogueProposalBlocked(name: string, health: RetrievalHealth): boolean {
  return ['propose_business_event', 'propose_price_update', 'propose_product_cost'].includes(name)
    && ['products', 'units', 'prices'].some((source) => health[source as RetrievalSource] === 'unavailable');
}
