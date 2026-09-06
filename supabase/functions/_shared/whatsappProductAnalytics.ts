import type { Lang } from './whatsappIntent.ts';
import { resolveDateRange } from './whatsappDateRange.ts';
import { correctControlWords } from './whatsappSpelling.ts';

export type ProductRankBy = 'quantity' | 'revenue' | 'margin';
export type ProductPeriod = 'today' | 'week' | 'month' | 'year';

/**
 * Which end of the ranking the question is about.
 *
 * MEASURED FAILURE, the owner's own thread: the web app showed Velvet napkin
 * at a margin of −1,200 and Sodaa at −100, both flagged "Below cost". Asked
 * "bidhaa gani inaleta hasara", Risip replied "hakuna bidhaa yenye hasara
 * kwenye orodha hii" — true of the list it was looking at, and the opposite of
 * the truth. Every ranking sorted DESCENDING and took the top five, so a
 * question about losses was answered with the five biggest winners.
 *
 * A loss is not a small profit. It is the one number a shopkeeper most needs
 * to be told without being asked twice.
 */
export type RankDirection = 'best' | 'worst';

export type ProductAnalyticsRequest = {
  rankBy: ProductRankBy;
  direction: RankDirection;
  period: ProductPeriod;
  compareNames: string[];
  /** Exact server-resolved window for jana/juzi/specific dates. */
  range?: { from: string; to: string; sw: string; en: string } | null;
};

export type ProductAnalyticsContext = {
  kind: 'product_analytics_context';
  request: ProductAnalyticsRequest;
  focusNames: string[];
};

export type ProductSaleLine = {
  description: string;
  quantity: number;
  lineTotal: number;
  occurredAt: string;
  unit?: string | null;
};

export type ProductCostPoint = {
  productKey: string;
  unitCost: number;
  effectiveFrom: string;
};

export type ProductAggregate = {
  product: string;
  quantity: number;
  revenue: number;
  margin: number | null;
  costed: boolean;
  /** Quantities stay separated by measure; litres must never be added to pieces. */
  quantityByUnit?: Record<string, number>;
};

const clean = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();

/** Negatives keep their sign: "−1,200" is the whole point of a loss line. */
const money = (value: number) =>
  `${value < 0 ? '−' : ''}TSh ${Math.abs(Math.round(value)).toLocaleString('en-US')}`;

function quantityUnit(unit: string | null | undefined): string {
  const value = clean(unit ?? '');
  if (!value || ['kipande', 'vipande', 'piece', 'pieces', 'pcs', 'count'].includes(value)) return 'piece';
  if (['kilo', 'kilos', 'kg'].includes(value)) return 'kilo';
  if (['lita', 'litre', 'litres', 'liter', 'liters'].includes(value)) return 'lita';
  return value;
}

function quantityLabel(unit: string, lang: Lang): string {
  if (unit === 'piece') return lang === 'sw' ? 'vipande' : 'pieces';
  if (unit === 'kilo') return lang === 'sw' ? 'kilo' : 'kg';
  if (unit === 'lita') return lang === 'sw' ? 'lita' : 'litres';
  return unit;
}

function quantityText(items: ProductAggregate[], lang: Lang): string {
  const totals = new Map<string, number>();
  for (const item of items) {
    const quantities = item.quantityByUnit && Object.keys(item.quantityByUnit).length > 0
      ? item.quantityByUnit
      : { piece: item.quantity };
    for (const [unit, quantity] of Object.entries(quantities)) {
      totals.set(unit, (totals.get(unit) ?? 0) + quantity);
    }
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([unit, quantity]) => `${quantity.toLocaleString('en-US')} ${quantityLabel(unit, lang)}`)
    .join(', ');
}

export function parseProductAnalyticsRequest(text: string | null | undefined, now = new Date()): ProductAnalyticsRequest | null {
  // "ni bdhaa gani zimeuzwa wiki hii", "nini kiemuzika leo" — one slip in the
  // question word and a table that exists went unbuilt. The leading "ni" is
  // dropped for the same reason: it is how the question gets opened out loud.
  const value = clean(correctControlWords(text)).replace(/^ni\s+(?=bidhaa|kitu|vitu)/, '');
  if (!value) return null;
  // MEASURED FAILURE: "Bidhaa gani zimeisha" — which products have RUN OUT —
  // was answered with a ranking of which products sold most. Both questions
  // start "bidhaa gani", and this parser saw its own words first. What is
  // finished is a stock question and belongs to the shelf, not to a league
  // table of sales.
  if (/\b(?:zimeisha|zilizoisha|zimekwisha|kimeisha|out of stock)\b/.test(value)) return null;
  // Price is a neighbouring concept, not a performance metric. A product can
  // have the lowest selling price while making a healthy margin, and a product
  // can be sold below cost while having a high configured price today. Leave
  // both price-comparison and missing-price questions for their dedicated read
  // capabilities; this is a category boundary, not a sentence patch.
  const asksPrice = /\b(?:bei|price|cheapest|cheap|lowest|expensive)\b/.test(value);
  if (asksPrice && !/hasara\b|chini ya gharama|below cost|loss|losing money/.test(value)) return null;
  const asksProduct = /(?:\b(?:bidhaa|bidha|product|products)\b.*\b(?:gani|which|zote|inauza|inauzika|imeuzwa|iliuzwa|ninazouza|ninauza|selling|sold|faida|profit|revenue|mapato)\b)|(?:\b(?:inauza zaidi|inauza sana|inauza ngapi|imeuzw\w* ngap\w*|iliuzwa ngapi|(?:ina|kina)uzika sana|nini (?:kiliuza|iliuza|kiliuzwa|iliyouzwa) (?:zaidi|sana)|best selling|(?:what |wht )?sold (?:the )?most|top)\b)/.test(value);
  // MEASURED FAILURE: "nini kimeuzika leo" — what sold today — was answered
  // with the day's cash summary, because this parser only recognised the
  // question when it carried the word "bidhaa". A shopkeeper asking what moved
  // says "nini", not "bidhaa gani".
  const asksWhatSold = /^(?:nini|vitu gani|what)(?:\s+na\s+nini)?\s+(?:ki|zi|vi)?(?:me|li)uz\w*/i.test(value);
  // "Je kuna hasara?", "bidhaa gani inaleta hasara", "nini kinauzwa chini ya
  // gharama". This is claimed even without the word "bidhaa", because a loss
  // only exists per product — the ledger's sales-minus-expenses cannot see one,
  // and answering from it is how "hakuna hasara" got said about a shop selling
  // napkins at four hundred shillings below cost.
  // MEASURED FAILURE, the owner's own thread: "biashara yangu inahasara?" was
  // not read as a loss question, while "je kuna hasara?" was. Swahili glues its
  // prefixes onto the word — "ina" + "hasara" — so a leading `\b` before
  // "hasara" never matches "inahasara". The word is distinctive enough that its
  // root, however it is prefixed, is a loss signal; only the END needs a
  // boundary, so "hasarani" (a place) is not swept in.
  const asksLoss = /hasara\b|\b(?:inapoteza|napoteza|zinapoteza|chini ya gharama|below cost|losing money|loss)\b/.test(value);
  const asksProfit = /\b(faida|margin|profit|earn)\b/.test(value);
  // “Faida au hasara?” without a product asks about the business-level result;
  // product analytics cannot answer that ledger question. Keep the two
  // neighbouring concepts separate instead of letting the loss branch claim it.
  if (asksLoss && asksProfit && !asksProduct) return null;
  const asksRevenue = /\b(mapato|revenue|money|fedha nyingi|pesa nyingi)\b/.test(value);
  // A bare "faida ya leo" is a period profit question, not a product ranking.
  // Product analytics only claims messages that explicitly mention products or
  // selling; this prevents it from stealing the future profit-intent route.
  if (!asksProduct && !asksWhatSold && !asksLoss) return null;

  const period: ProductPeriod = /\b(leo|today)\b/.test(value)
    ? 'today'
    : /\b(wiki|week)\b/.test(value)
      ? 'week'
      : /\b(mwezi|month)\b/.test(value)
        ? 'month'
        : /\b(mwaka|year)\b/.test(value) ? 'year' : 'month';
  const rankBy: ProductRankBy = asksLoss || asksProfit ? 'margin' : asksRevenue ? 'revenue' : 'quantity';
  const direction: RankDirection = asksLoss ? 'worst' : 'best';
  const compareMatch = value.match(/^(.+?)\s+(?:au|or)\s+(.+?)(?:\s+(?:ipi|which|inauza|sells|inauzika)\b|\s*$)/u);
  const namedProductMatch = value.match(/^(.+?)\s+(?:inauza|inauzika|imeuzwa|iliuzwa|sold)\s+(?:ngapi|sana|zaidi|vipi|most)\b/u);
  const namedProduct = namedProductMatch?.[1].trim();
  const isGenericProductPhrase = Boolean(namedProduct && /^(?:bidhaa|bidha|product|products|kitu|what|which)\b/.test(namedProduct));
  const compareNames = compareMatch
    ? [clean(compareMatch[1]), clean(compareMatch[2])].filter(Boolean).slice(0, 2)
    : namedProduct && !isGenericProductPhrase ? [clean(namedProduct)] : [];
  const resolved = resolveDateRange(text ?? '', now);
  const range = resolved ? {
    from: resolved.from.toISOString(), to: resolved.to.toISOString(), sw: resolved.sw, en: resolved.en,
  } : null;
  return { rankBy, direction, period, compareNames, ...(range ? { range } : {}) };
}

export function parseProductAnalyticsFollowUp(
  text: string | null | undefined,
  context: ProductAnalyticsContext | null | undefined,
  now = new Date(),
): ProductAnalyticsRequest | null {
  if (!context || context.kind !== 'product_analytics_context' || context.focusNames.length === 0) return null;
  const value = clean(text ?? '');
  if (!value) return null;
  const period: ProductPeriod = /\b(leo|today)\b/.test(value)
    ? 'today'
    : /\b(wiki|week)\b/.test(value)
      ? 'week'
      : /\b(mwezi|month)\b/.test(value)
        ? 'month'
        : /\b(mwaka|year)\b/.test(value) ? 'year' : context.request.period;
  const asksRevenue = /^(?:na\s+)?(?:jumla|jumla yake|jumla yao|mapato|mapato yake|mapato yao|revenue|total|total revenue|how much money)(?:\s+(?:ni|is|je))?\??$/.test(value);
  const asksMargin = /^(?:na\s+)?(?:faida|faida yake|faida yao|profit|margin|what about profit)(?:\s+(?:ni|is|je))?\??$/.test(value);
  const asksQuantity = /^(?:na\s+)?(?:ngapi|idadi|idadi yake|imeuzwa ngapi|inauza ngapi|quantity|how many)(?:\s+(?:leo|today|je))?\??$/.test(value);
  const changesPeriodOnly = /^(?:na\s+)?(?:leo|today|wiki hii|this week|mwezi huu|this month|mwaka huu|this year)(?:\s+je)?\??$/.test(value);
  if (!asksRevenue && !asksMargin && !asksQuantity && !changesPeriodOnly) return null;
  const resolved = resolveDateRange(text ?? '', now);
  const range = resolved ? {
    from: resolved.from.toISOString(), to: resolved.to.toISOString(), sw: resolved.sw, en: resolved.en,
  } : context.request.range ?? null;
  return {
    rankBy: asksRevenue ? 'revenue' : asksMargin ? 'margin' : asksQuantity ? 'quantity' : context.request.rankBy,
    direction: context.request.direction ?? 'best',
    period,
    compareNames: context.focusNames.slice(0, 2),
    ...(range ? { range } : {}),
  };
}

function darParts(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Dar_es_Salaam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  return {
    year: Number(parts.find((part) => part.type === 'year')?.value),
    month: Number(parts.find((part) => part.type === 'month')?.value),
    day: Number(parts.find((part) => part.type === 'day')?.value),
  };
}

/** Return UTC instant for midnight in the business timezone (Tanzania, UTC+3). */
function darMidnight(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day) - 3 * 60 * 60 * 1000);
}

export function periodStart(period: ProductPeriod, now = new Date()): Date {
  const parts = darParts(now);
  const start = darMidnight(parts.year, parts.month, parts.day);
  if (period === 'today') return start;
  if (period === 'week') {
    const localDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
    const mondayOffset = (localDate.getUTCDay() + 6) % 7;
    localDate.setUTCDate(localDate.getUTCDate() - mondayOffset);
    return darMidnight(localDate.getUTCFullYear(), localDate.getUTCMonth() + 1, localDate.getUTCDate());
  }
  if (period === 'month') {
    return darMidnight(parts.year, parts.month, 1);
  }
  return darMidnight(parts.year, 1, 1);
}

function currentCost(description: string, occurredAt: string, costs: ProductCostPoint[]): number | null {
  const key = clean(description);
  const saleTime = new Date(occurredAt).getTime();
  const eligible = costs
    .filter((cost) => cost.productKey === key && new Date(cost.effectiveFrom).getTime() <= saleTime)
    .sort((a, b) => new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime());
  return eligible[0]?.unitCost ?? null;
}

export function aggregateProducts(lines: ProductSaleLine[], costs: ProductCostPoint[]): ProductAggregate[] {
  const byProduct = new Map<string, ProductAggregate>();
  for (const line of lines) {
    const product = line.description.trim().replace(/^[\s\-–—•*]+/u, '').trim();
    if (!product || line.quantity <= 0 || line.lineTotal <= 0) continue;
    const key = clean(product);
    const unitCost = currentCost(product, line.occurredAt, costs);
    const existing = byProduct.get(key) ?? {
      product, quantity: 0, revenue: 0, margin: 0, costed: true, quantityByUnit: {},
    };
    existing.quantity += line.quantity;
    existing.revenue += line.lineTotal;
    const unit = quantityUnit(line.unit);
    existing.quantityByUnit = existing.quantityByUnit ?? {};
    existing.quantityByUnit[unit] = (existing.quantityByUnit[unit] ?? 0) + line.quantity;
    if (unitCost === null) {
      existing.costed = false;
      existing.margin = null;
    } else if (existing.costed) {
      existing.margin = (existing.margin ?? 0) + line.lineTotal - line.quantity * unitCost;
    }
    byProduct.set(key, existing);
  }
  return Array.from(byProduct.values());
}

export function rankProducts(
  items: ProductAggregate[],
  rankBy: ProductRankBy,
  compareNames: string[] = [],
  direction: RankDirection = 'best',
): ProductAggregate[] {
  const filtered = compareNames.length > 0
    ? items.filter((item) => compareNames.some((name) => clean(item.product) === clean(name) || clean(item.product).includes(clean(name))))
    : items;
  const worst = direction === 'worst';
  return filtered
    .filter((item) => rankBy !== 'margin' || item.costed)
    .sort((a, b) => {
      const value = (item: ProductAggregate) => rankBy === 'quantity'
        ? item.quantity
        : rankBy === 'revenue' ? item.revenue : (item.margin ?? (worst ? Infinity : -Infinity));
      const [first, second] = worst ? [a, b] : [b, a];
      return value(first) - value(second)
        || (worst ? a.revenue - b.revenue : b.revenue - a.revenue)
        || a.product.localeCompare(b.product);
    });
}

export function productAnalyticsReply(
  request: ProductAnalyticsRequest,
  items: ProductAggregate[],
  lang: Lang,
): string {
  const periodLabel = request.range
    ? (lang === 'sw' ? request.range.sw : request.range.en)
    : lang === 'sw'
      ? { today: 'leo', week: 'wiki hii', month: 'mwezi huu', year: 'mwaka huu' }[request.period]
      : { today: 'today', week: 'this week', month: 'this month', year: 'this year' }[request.period];
  if (items.length === 0) {
    return lang === 'sw'
      ? 'Bado hujaandika mauzo yenye majina ya bidhaa katika kipindi hiki. Taja bidhaa na kiasi ili Risip iweze kuonyesha kinachouza zaidi.'
      : 'I do not have itemised product sales for this period yet. Include product names and quantities so Risip can rank what sells most.';
  }
  const ranked = rankProducts(items, request.rankBy, request.compareNames, request.direction);
  // Products with no buying cost cannot be ranked by margin. They used to be
  // dropped out of the ranking without a word, and when EVERY product lacked one
  // the whole question was refused — "bidhaa gani inafaida kubwa?" answered with
  // a list of five things to go and do. Both are the same mistake: all or
  // nothing, where some is the honest answer.
  const uncosted = request.rankBy === 'margin'
    ? items.filter((item) => !item.costed).map((item) => item.product)
    : [];
  const uncostedNote = uncosted.length === 0 ? '' : (lang === 'sw'
    ? `\n\n_Hazipo kwenye hesabu hii (hazina bei ya kununua): ${uncosted.slice(0, 6).join(', ')}`
      + `${uncosted.length > 6 ? ` na nyingine ${uncosted.length - 6}` : ''}._`
    : `\n\n_Left out of this ranking, no buying cost: ${uncosted.slice(0, 6).join(', ')}`
      + `${uncosted.length > 6 ? ` and ${uncosted.length - 6} more` : ''}._`);

  if (ranked.length === 0 && request.rankBy === 'margin') {
    const missing = uncosted.slice(0, 5).join(', ');
    return lang === 'sw'
      ? `Siwezi kukadiria faida bado kwa sababu hakuna bei ya kununua iliyowekwa kwa ${missing || 'bidhaa hizi'}. Tuma mfano: “unga unanigharimu 900 kwa kilo”.`
      : `I cannot estimate margin yet because no buying cost is recorded for ${missing || 'these products'}. Send for example: “cost of flour is 900 per kilo”.`;
  }
  if (ranked.length === 0) {
    return lang === 'sw' ? 'Sikupata bidhaa ulizotaja katika kipindi hiki.' : 'I could not find the named products in this period.';
  }

  // A loss question gets a loss answer: the products actually sold below what
  // they cost, and nothing else. Padding this with the rest of the ranking is
  // how "hakuna hasara" ended up being said about a shop losing money on two
  // lines every day.
  if (request.direction === 'worst') {
    const losing = ranked.filter((item) => (item.margin ?? 0) < 0);
    if (losing.length === 0) {
      return (lang === 'sw'
        ? `Hakuna bidhaa inayouzwa chini ya gharama ${periodLabel}.`
        : `No product sold below cost ${periodLabel}.`) + uncostedNote;
    }
    const total = losing.reduce((sum, item) => sum + (item.margin ?? 0), 0);
    const rows = losing.slice(0, 8).map((item) =>
      `• ${item.product} — ${money(item.margin ?? 0)}`);
    return (lang === 'sw'
      ? `Ndiyo. Bidhaa ${losing.length} ziliuzwa chini ya gharama ${periodLabel} — jumla ${money(total)}:\n`
        + `${rows.join('\n')}\n\nHii ni historia ya mauzo ya kipindi hicho; angalia bei ya sasa na gharama ya sasa tofauti.`
      : `Yes. ${losing.length} product(s) were sold below cost ${periodLabel} — ${money(total)} in total:\n`
        + `${rows.join('\n')}\n\nThis is historical sales for that period; review today’s selling price and cost separately.`) + uncostedNote;
  }
  const basis = request.rankBy === 'quantity'
    ? (lang === 'sw' ? 'idadi ya bidhaa' : 'quantity sold')
    : request.rankBy === 'revenue'
      ? (lang === 'sw' ? 'mapato' : 'revenue')
      : (lang === 'sw' ? 'faida ya makisio' : 'estimated margin');
  const rows = ranked.slice(0, 5).map((item, index) => {
    const value = request.rankBy === 'quantity'
      ? quantityText([item], lang)
      : request.rankBy === 'revenue'
        ? `TSh ${Math.round(item.revenue).toLocaleString('en-US')}`
        : `TSh ${Math.round(item.margin ?? 0).toLocaleString('en-US')}`;
    return `${index + 1}. ${item.product} — ${value}`;
  });
  const total = request.rankBy === 'quantity'
    ? (lang === 'sw'
      ? `Jumla ya bidhaa zote zilizouzwa ${periodLabel}: *${quantityText(items, lang)}*. Bidhaa tofauti: ${items.length}.`
      : `Total products sold ${periodLabel}: *${quantityText(items, lang)}*. Distinct products: ${items.length}.`)
    : request.rankBy === 'revenue'
      ? (lang === 'sw'
        ? `Jumla ya mapato ya bidhaa zote ${periodLabel}: *${money(items.reduce((sum, item) => sum + item.revenue, 0))}*.`
        : `Total product revenue ${periodLabel}: *${money(items.reduce((sum, item) => sum + item.revenue, 0))}*.`)
      : '';
  return lang === 'sw'
    ? `${total}${total ? '\n\n' : ''}Kwa ${periodLabel}, bidhaa ${rows.length} za juu kwa ${basis}:\n${rows.join('\n')}\n\nHii ni ${basis}, si kipimo kingine.${uncostedNote}`
    : `${total}${total ? '\n\n' : ''}For ${periodLabel}, the top ${rows.length} products by ${basis}:\n${rows.join('\n')}\n\nThis is ranked by ${basis}, not another measure.${uncostedNote}`;
}
