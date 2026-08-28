import { ModelOutputValidationError, type ModelProvider, type StructuredRequest, type StructuredResult } from './types.js';

/**
 * The default provider.
 *
 * Deterministic, offline and free. It composes its answer from the structured
 * input it is given rather than generating prose, which makes it useful for two
 * things at once: the project runs end-to-end with no AI key, and tests can
 * assert on exact output.
 *
 * It goes through the same schema validation as a real provider, so a prompt
 * whose schema is wrong fails here rather than in production.
 */
export class FakeModelProvider implements ModelProvider {
  readonly name = 'fake';
  readonly model: string;

  constructor(model = 'fake-deterministic-v1') {
    this.model = model;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const started = Date.now();
    const draft = this.#compose(request);

    const parsed = request.schema.safeParse(draft);
    if (!parsed.success) {
      throw new ModelOutputValidationError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      );
    }

    const rendered = request.prompt.render(request.input);
    const inputTokens = estimateTokens(request.prompt.system) + estimateTokens(rendered);
    const outputTokens = estimateTokens(JSON.stringify(draft));

    return {
      data: parsed.data,
      provider: this.name,
      model: this.model,
      promptId: request.prompt.id,
      promptVersion: request.prompt.version,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        estimatedCostUsd: 0,
      },
      latencyMs: Date.now() - started,
      attempts: 1,
      requestedToolCalls: [],
    };
  }

  #compose(request: StructuredRequest<unknown>): unknown {
    if (request.prompt.id === 'accountant_report') return composeAccountantReport(request.input);
    if (request.prompt.id === 'customer_request_draft') return composeCustomerRequest(request.input);
    return {};
  }
}

interface ReportInput {
  clientName?: string;
  period?: string;
  totalFindings?: number;
  blockingFindings?: number;
  reviewFindings?: number;
  manualFindings?: number;
  clearItems?: number;
  notImplementedSteps?: { labelSv: string }[];
  topFindings?: { description: string; severity: string; rationale: string }[];
  blockers?: string[];
}

function composeAccountantReport(raw: Readonly<Record<string, unknown>>): unknown {
  const input = raw as ReportInput;
  const period = input.period ?? 'perioden';
  const client = input.clientName ?? 'klienten';
  const total = input.totalFindings ?? 0;
  const blocking = input.blockingFindings ?? 0;
  const review = input.reviewFindings ?? 0;
  const manual = input.manualFindings ?? 0;
  const clear = input.clearItems ?? 0;

  const headline =
    blocking > 0
      ? `${client} ${period}: ${blocking} blockerande avvikelse(r) återstår`
      : `${client} ${period}: inga blockerande avvikelser`;

  const summary = [
    `Analysen av ${period} för ${client} gav ${total} avvikelse(r) efter deduplicering.`,
    `${clear} post(er) passerade samtliga kontroller utan anmärkning.`,
    `${review} avvikelse(r) är märkta för granskning och ${manual} kräver manuell bedömning.`,
    blocking > 0
      ? `${blocking} avvikelse(r) blockerar perioden och måste hanteras innan bokslutet kan stängas.`
      : 'Inga avvikelser blockerar perioden.',
    (input.notImplementedSteps?.length ?? 0) > 0
      ? `Följande processteg är ännu inte implementerade och har hanterats manuellt: ${input.notImplementedSteps?.map((s) => s.labelSv).join(', ')}.`
      : '',
    'Samtliga slutsatser kommer från den deterministiska regelmotorn. Ingenting har bokförts i Fortnox.',
  ]
    .filter(Boolean)
    .join(' ');

  const riskAreas = (input.topFindings ?? []).slice(0, 5).map((f) => ({
    title: f.description,
    detail: f.rationale,
  }));

  const recommendedActions = [
    blocking > 0 ? 'Hantera de blockerande avvikelserna först - perioden kan inte stängas utan dem.' : null,
    review > 0 ? 'Gå igenom review-kön och godkänn eller avvisa förslagen.' : null,
    'Begär in saknade underlag från kunden innan momsredovisningen lämnas.',
  ].filter((x): x is string => x !== null);

  return {
    headline,
    summary,
    riskAreas,
    recommendedActions,
    blockers: input.blockers ?? [],
  };
}

function composeCustomerRequest(raw: Readonly<Record<string, unknown>>): unknown {
  const input = raw as { clientName?: string; period?: string; items?: { description: string }[] };
  const items = input.items ?? [];
  return {
    headline: `Underlag saknas för ${input.period ?? 'perioden'}`,
    summary: [
      `Hej,`,
      ``,
      `Inför avstämningen av ${input.period ?? 'perioden'} saknar vi underlag för följande poster:`,
      ...items.map((i) => `- ${i.description}`),
      ``,
      `Hör gärna av dig om något är oklart.`,
    ].join('\n'),
    riskAreas: [],
    recommendedActions: [],
    blockers: [],
  };
}

/** Rough token estimate: ~4 characters per token for Swedish and JSON. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
