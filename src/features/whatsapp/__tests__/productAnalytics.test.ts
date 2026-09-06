import { describe, expect, it } from 'vitest';
import {
  aggregateProducts,
  parseProductAnalyticsRequest,
  parseProductAnalyticsFollowUp,
  periodStart,
  productAnalyticsReply,
  rankProducts,
  type ProductSaleLine,
} from '../../../../supabase/functions/_shared/whatsappProductAnalytics';

const lines: ProductSaleLine[] = [
  { description: 'unga', quantity: 30, lineTotal: 75000, occurredAt: '2026-08-13T08:00:00Z' },
  { description: 'soda', quantity: 200, lineTotal: 200000, occurredAt: '2026-08-13T08:00:00Z' },
];

describe('WhatsApp product analytics', () => {
  it('distinguishes volume, revenue, and margin requests', () => {
    expect(parseProductAnalyticsRequest('bidhaa gani inauza zaidi?')?.rankBy).toBe('quantity');
    expect(parseProductAnalyticsRequest('Bidhaa gani inauza sana leo')?.rankBy).toBe('quantity');
    expect(parseProductAnalyticsRequest('Bidha gani inauza sana leo')?.rankBy).toBe('quantity');
    expect(parseProductAnalyticsRequest('What sold the most today')).toMatchObject({ rankBy: 'quantity', period: 'today' });
    expect(parseProductAnalyticsRequest('Nguvu ya sala imeuzwa ngapi leo')).toMatchObject({ compareNames: ['nguvu ya sala'] });
    expect(parseProductAnalyticsRequest('which product gives me the most revenue')?.rankBy).toBe('revenue');
    expect(parseProductAnalyticsRequest('bidhaa gani ilinipa faida kubwa?')?.rankBy).toBe('margin');
  });

  it('continues the previous product question when a pronoun is used', () => {
    const context = {
      kind: 'product_analytics_context' as const,
      request: {
        rankBy: 'quantity' as const,
        direction: 'best' as const,
        period: 'today' as const,
        compareNames: ['nguvu ya sala'],
      },
      focusNames: ['nguvu ya sala'],
    };
    expect(parseProductAnalyticsFollowUp('Jumla yake?', context))
      .toEqual({ rankBy: 'revenue', direction: 'best', period: 'today', compareNames: ['nguvu ya sala'] });
    expect(parseProductAnalyticsFollowUp('Faida yake?', context))
      .toEqual({ rankBy: 'margin', direction: 'best', period: 'today', compareNames: ['nguvu ya sala'] });
    expect(parseProductAnalyticsFollowUp('Wiki hii je?', context)).toMatchObject({
      rankBy: 'quantity', period: 'week', compareNames: ['nguvu ya sala'],
      range: { sw: 'wiki hii' },
    });
  });

  it('limits a named-product question to that product', () => {
    expect(parseProductAnalyticsRequest('Nguvu ya sala inauza ngapi leo?')).toMatchObject({
      rankBy: 'quantity', period: 'today', compareNames: ['nguvu ya sala'],
    });
  });

  it('does not steal an ordinary sale message that mentions a product', () => {
    expect(parseProductAnalyticsRequest('nimeuza bidhaa 10 kwa 3000')).toBeNull();
    expect(parseProductAnalyticsRequest('nimenunua bidhaa 300000')).toBeNull();
  });

  it('aggregates itemised sales and uses the historical cost at sale time', () => {
    const items = aggregateProducts(lines, [
      { productKey: 'unga', unitCost: 900, effectiveFrom: '2026-08-01T00:00:00Z' },
      { productKey: 'soda', unitCost: 900, effectiveFrom: '2026-08-01T00:00:00Z' },
    ]);
    expect(rankProducts(items, 'quantity')[0].product).toBe('soda');
    expect(rankProducts(items, 'revenue')[0].product).toBe('soda');
    expect(rankProducts(items, 'margin')[0]).toMatchObject({ product: 'unga', margin: 48000, costed: true });
  });

  it('removes list punctuation from stored product descriptions', () => {
    expect(aggregateProducts([{ description: '- nguvu ya sala', quantity: 7, lineTotal: 63000, occurredAt: '2026-08-13T08:00:00Z' }], [])[0].product).toBe('nguvu ya sala');
  });

  it('does not rank an uncosted product as profitable', () => {
    const items = aggregateProducts(lines, []);
    expect(rankProducts(items, 'margin')).toEqual([]);
    const request = parseProductAnalyticsRequest('bidhaa gani ilinipa faida kubwa leo?')!;
    expect(productAnalyticsReply(request, items, 'sw')).toContain('bei ya kununua');
  });

  it('answers honestly when sales have no item lines', () => {
    const request = parseProductAnalyticsRequest('bidhaa gani inauza zaidi?')!;
    expect(productAnalyticsReply(request, [], 'sw')).toContain('Bado hujaandika');
    expect(productAnalyticsReply(request, [], 'sw')).toContain('majina ya bidhaa');
  });

  it('keeps comparison limited to the named products', () => {
    const request = parseProductAnalyticsRequest('unga au sukari ipi inauza zaidi?')!;
    expect(request.compareNames).toEqual(['unga', 'sukari']);
  });

  it('uses the Tanzania business day boundary', () => {
    const start = periodStart('today', new Date('2026-08-13T21:30:00.000Z'));
    expect(start.toISOString()).toBe('2026-08-13T21:00:00.000Z');
  });

  it('carries an exact juzi range into product analytics and labels the answer correctly', () => {
    const request = parseProductAnalyticsRequest(
      'Nini kiliuza zaidi juzi?',
      new Date('2026-08-19T05:39:00.000Z'),
    );
    expect(request).toMatchObject({
      rankBy: 'quantity',
      range: {
        from: '2026-08-16T21:00:00.000Z',
        to: '2026-08-17T21:00:00.000Z',
        sw: 'juzi',
      },
    });
    const items = aggregateProducts([
      { description: 'nguvu ya sala', quantity: 22, lineTotal: 209000, occurredAt: '2026-08-17T08:00:00Z' },
      { description: 'punch', quantity: 7, lineTotal: 77000, occurredAt: '2026-08-17T08:00:00Z' },
    ], []);
    const reply = productAnalyticsReply(request!, items, 'sw');
    expect(reply).toContain('Kwa juzi');
    expect(reply).toContain('nguvu ya sala — 22');
  });

  it('carries numbered historical weeks and months into the product query', () => {
    const now = new Date('2026-08-19T05:39:00.000Z');
    expect(parseProductAnalyticsRequest('Nini kiliuza zaidi wiki mbili zilizopita?', now)).toMatchObject({
      range: {
        from: '2026-08-02T21:00:00.000Z',
        to: '2026-08-09T21:00:00.000Z',
        sw: 'wiki 2 zilizopita',
      },
    });
    expect(parseProductAnalyticsRequest('Nini kiliuza zaidi miezi mitatu nyuma?', now)).toMatchObject({
      range: {
        from: '2026-04-30T21:00:00.000Z',
        to: '2026-05-31T21:00:00.000Z',
        sw: 'miezi 3 nyuma',
      },
    });
  });

  it('responds in English without mixing labels', () => {
    const request = parseProductAnalyticsRequest('best selling product today')!;
    const items = aggregateProducts(lines, []);
    expect(productAnalyticsReply(request, items, 'en')).toContain('For today');
    expect(productAnalyticsReply(request, items, 'en')).not.toContain('Mauzo');
  });

  it('returns a verified total across every product even though the ranking shows only five', () => {
    const request = {
      rankBy: 'quantity' as const,
      direction: 'best' as const,
      period: 'week' as const,
      compareNames: [],
      range: {
        from: '2026-08-23T21:00:00.000Z',
        to: '2026-08-30T21:00:00.000Z',
        sw: 'wiki iliyopita',
        en: 'last week',
      },
    };
    const items = aggregateProducts(Array.from({ length: 7 }, (_, index) => ({
      description: `bidhaa ${index + 1}`,
      quantity: index + 1,
      lineTotal: (index + 1) * 1_000,
      occurredAt: '2026-08-25T08:00:00Z',
      unit: 'kipande',
    })), []);
    const reply = productAnalyticsReply(request, items, 'sw');
    expect(reply).toContain('Jumla ya bidhaa zote zilizouzwa');
    expect(reply).toContain('*28 vipande*');
    expect(reply).toContain('Bidhaa tofauti: 7');
    expect(reply.match(/^\d+\./gm)).toHaveLength(5);
  });

  it('never adds unlike measures into one meaningless quantity', () => {
    const request = {
      rankBy: 'quantity' as const,
      direction: 'best' as const,
      period: 'week' as const,
      compareNames: [],
    };
    const items = aggregateProducts([
      { description: 'mafuta ya kula', quantity: 3, lineTotal: 12_000, occurredAt: '2026-08-25T08:00:00Z', unit: 'lita' },
      { description: 'sabuni', quantity: 4, lineTotal: 8_000, occurredAt: '2026-08-25T08:00:00Z', unit: 'vipande' },
    ], []);
    const reply = productAnalyticsReply(request, items, 'sw');
    expect(reply).toContain('3 lita');
    expect(reply).toContain('4 vipande');
    expect(reply).not.toContain('7 vipande');
  });
});

describe('ranking by margin when some products have no buying cost', () => {
  const costed = (product: string, margin: number) => ({
    product, quantity: 10, revenue: margin * 2, margin, costed: true,
  });
  const uncosted = (product: string) => ({
    product, quantity: 10, revenue: 5000, margin: null, costed: false,
  });

  it('answers with what it can, and names what it left out', () => {
    // MEASURED FAILURE: "bidhaa gani inafaida kubwa?" was answered with a list
    // of five things to go and do, because SOME products had no buying cost.
    // Products without one were also dropped from the ranking without a word.
    const reply = productAnalyticsReply(
      { rankBy: 'margin', period: 'month', compareNames: [] } as never,
      [costed('daftari', 9600), uncosted('rosali ya maria'), uncosted('padre pio')],
      'sw',
    );
    expect(reply).toContain('daftari');
    expect(reply).toMatch(/rosali ya maria/);
    expect(reply).toMatch(/hazina bei ya kununua/);
  });

  it('says how many more it left out rather than listing forty', () => {
    const many = Array.from({ length: 12 }, (_, index) => uncosted(`bidhaa ${index}`));
    const reply = productAnalyticsReply(
      { rankBy: 'margin', period: 'month', compareNames: [] } as never,
      [costed('daftari', 9600), ...many],
      'sw',
    );
    expect(reply).toMatch(/na nyingine 6/);
  });

  it('says nothing about buying costs when ranking by quantity', () => {
    const reply = productAnalyticsReply(
      { rankBy: 'quantity', period: 'month', compareNames: [] } as never,
      [costed('daftari', 9600), uncosted('padre pio')],
      'sw',
    );
    expect(reply).not.toMatch(/bei ya kununua/);
  });

  it('still refuses plainly when nothing at all is costed', () => {
    const reply = productAnalyticsReply(
      { rankBy: 'margin', period: 'month', compareNames: [] } as never,
      [uncosted('padre pio'), uncosted('bilia kubwa')],
      'sw',
    );
    expect(reply).toMatch(/Siwezi kukadiria faida/);
    expect(reply).toContain('padre pio');
  });
});
