import { z } from 'zod';
import type { PromptTemplate, ToolDefinition } from './types.js';

/**
 * Prompt registry.
 *
 * Versions are explicit and immutable: changing wording means bumping the
 * version, because every audit event records which prompt version produced a
 * given output. A finding raised in March must still be explainable in October.
 */

export const accountantReportSchema = z.object({
  headline: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  riskAreas: z.array(z.object({ title: z.string(), detail: z.string() })).max(10),
  recommendedActions: z.array(z.string()).max(10),
  blockers: z.array(z.string()).max(20),
});
export type AccountantReport = z.infer<typeof accountantReportSchema>;

export const accountantReportJsonSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'summary', 'riskAreas', 'recommendedActions', 'blockers'],
  properties: {
    headline: { type: 'string' },
    summary: { type: 'string' },
    riskAreas: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'detail'],
        properties: { title: { type: 'string' }, detail: { type: 'string' } },
      },
    },
    recommendedActions: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } },
  },
};

const SYSTEM_GUARDRAILS = [
  'Du är ett assisterande verktyg för en svensk auktoriserad redovisningskonsult.',
  'Du sammanfattar och förklarar redan framtagna, deterministiska analysresultat.',
  'Du fattar aldrig bokföringsbeslut, ändrar aldrig belopp och hittar aldrig på transaktioner.',
  'Du får aldrig påstå att en period är klar - det avgörs av regelmotorn.',
  'Om underlaget är otillräckligt ska du säga det rakt ut.',
  'Svara alltid på svenska och alltid som giltig JSON enligt schemat.',
].join(' ');

export const ACCOUNTANT_REPORT_PROMPT: PromptTemplate = {
  id: 'accountant_report',
  version: 'accountant_report@1.0.0',
  system: SYSTEM_GUARDRAILS,
  render(input) {
    return [
      'Sammanfatta månadsavstämningen för konsulten utifrån följande strukturerade data.',
      'Data är redan validerad av regelmotorn. Lägg inte till nya slutsatser om bokföringen.',
      '',
      JSON.stringify(input, null, 2),
    ].join('\n');
  },
};

export const CUSTOMER_REQUEST_PROMPT: PromptTemplate = {
  id: 'customer_request_draft',
  version: 'customer_request_draft@1.0.0',
  system: `${SYSTEM_GUARDRAILS} Utkastet skickas aldrig automatiskt utan granskas alltid av konsulten.`,
  render(input) {
    return [
      'Skriv ett kort, artigt utkast till kunden som efterfrågar saknade underlag.',
      'Nämn endast de poster som listas nedan. Uppfinn inga belopp eller datum.',
      '',
      JSON.stringify(input, null, 2),
    ].join('\n');
  },
};

export const PROMPTS = {
  accountantReport: ACCOUNTANT_REPORT_PROMPT,
  customerRequest: CUSTOMER_REQUEST_PROMPT,
} as const;

/**
 * The complete tool allowlist.
 *
 * Both entries are read-only lookups over data the host has already fetched.
 * There is deliberately no tool that writes, that reaches Fortnox, or that runs
 * arbitrary queries.
 */
export const ALLOWED_TOOLS: readonly ToolDefinition[] = [
  {
    name: 'lookup_account_description',
    description: 'Slår upp kontobenämningen för ett kontonummer i klientens kontoplan.',
    readOnly: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['account'],
      properties: { account: { type: 'integer', minimum: 1000, maximum: 9999 } },
    },
  },
  {
    name: 'lookup_rule_explanation',
    description: 'Slår upp den svenska förklaringen till en regel som skapat en avvikelse.',
    readOnly: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['ruleId'],
      properties: { ruleId: { type: 'string' } },
    },
  },
];
