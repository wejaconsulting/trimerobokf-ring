/**
 * Rule registry.
 *
 * Every finding records the id and version of the rule that produced it, so a
 * finding raised months ago can still be explained by the exact logic that was
 * running at the time. `RULE_SET_VERSION` is stamped on the close run.
 */
export const RULE_SET_VERSION = 'ruleset@1.0.0';

export interface RuleMeta {
  readonly id: string;
  readonly version: string;
  readonly titleSv: string;
  readonly kind: 'validation' | 'anomaly';
  /** Short statement of what the rule checks, shown in the review UI. */
  readonly explanation: string;
}

function meta(
  id: string,
  kind: RuleMeta['kind'],
  titleSv: string,
  explanation: string,
  version = '1.0.0',
): RuleMeta {
  return { id, version: `${id}@${version}`, titleSv, kind, explanation };
}

export const RULES = {
  // --- mandatory validations ---------------------------------------------
  balancedVoucher: meta(
    'validation.balanced_voucher',
    'validation',
    'Debet lika med kredit',
    'Summan av debet måste vara exakt lika med summan av kredit i varje verifikation.',
  ),
  accountsExist: meta(
    'validation.accounts_exist',
    'validation',
    'Konton finns och är aktiva',
    'Varje konto som används måste finnas i kontoplanen och vara aktivt.',
  ),
  dateInFinancialYear: meta(
    'validation.date_in_financial_year',
    'validation',
    'Datum inom räkenskapsår',
    'Transaktionsdatumet måste ligga inom ett upplagt räkenskapsår.',
  ),
  periodNotLocked: meta(
    'validation.period_not_locked',
    'validation',
    'Perioden är inte låst',
    'Ingenting får bokföras på ett datum som ligger inom en låst period.',
  ),
  vatPlausible: meta(
    'validation.vat_plausible',
    'validation',
    'Momsbelopp och momskod rimliga',
    'Momsbeloppet måste motsvara en tillåten momssats i förhållande till nettobeloppet.',
  ),
  inputVatDocumentation: meta(
    'validation.input_vat_documentation',
    'validation',
    'Ingående moms kräver underlag',
    'Ingående moms får inte föreslås när godtagbart underlag saknas.',
  ),
  requiredDimension: meta(
    'validation.required_dimension',
    'validation',
    'Obligatoriskt kostnadsställe eller projekt',
    'Konton som enligt klientens policy kräver kostnadsställe eller projekt måste ha det ifyllt.',
  ),
  duplicateSourceRecord: meta(
    'validation.duplicate_source_record',
    'validation',
    'Samma underlag bokfört två gånger',
    'Ett och samma källunderlag får aldrig bokföras mer än en gång.',
  ),
  idempotentAction: meta(
    'validation.idempotent_action',
    'validation',
    'Idempotent workflow-åtgärd',
    'Samma workflow-åtgärd på samma underlag måste ge samma resultat utan att skapa dubbletter.',
  ),
  stepNotImplemented: meta(
    'validation.step_not_implemented',
    'validation',
    'Ej implementerat processteg',
    'Ett processteg som bär verkligt bokföringsarbete men inte är implementerat blockerar perioden.',
  ),

  // --- anomaly rules ------------------------------------------------------
  unusualAccountForSupplier: meta(
    'anomaly.unusual_account_for_supplier',
    'anomaly',
    'Konto som leverantören normalt inte använder',
    'Kostnaden är bokförd på ett konto som denna leverantör inte har använts mot tidigare.',
  ),
  deviatingVatCode: meta(
    'anomaly.deviating_vat_code',
    'anomaly',
    'Avvikande momskod',
    'Momskoden på raden avviker från den momskod kontot normalt bokförs med.',
  ),
  unusualAmount: meta(
    'anomaly.unusual_amount',
    'anomaly',
    'Ovanligt belopp jämfört med samma leverantör',
    'Beloppet avviker väsentligt från medianbeloppet för samma leverantör i historikfönstret.',
  ),
  possibleDuplicate: meta(
    'anomaly.possible_duplicate',
    'anomaly',
    'Möjlig dubblett',
    'Två verifikationer med samma leverantör, belopp och datum finns i perioden.',
  ),
  missingDocumentation: meta(
    'anomaly.missing_documentation',
    'anomaly',
    'Saknat underlag',
    'Verifikationen saknar kopplad fil eller faktura i Fortnox.',
  ),
  missingDimension: meta(
    'anomaly.missing_dimension',
    'anomaly',
    'Saknat kostnadsställe eller projekt',
    'Raden saknar kostnadsställe eller projekt trots att kontot normalt har det.',
  ),
  wrongPeriod: meta(
    'anomaly.wrong_period',
    'anomaly',
    'Transaktion i fel period',
    'Fakturadatumet ligger i en annan period än bokföringsdatumet.',
  ),
  manualVoucherUnusual: meta(
    'anomaly.manual_voucher_unusual',
    'anomaly',
    'Manuell A-verifikation med ovanligt konto eller belopp',
    'En manuell verifikation använder ett sällan använt konto eller ett väsentligt belopp.',
  ),
  balanceInsteadOfResult: meta(
    'anomaly.balance_instead_of_result',
    'anomaly',
    'Balanskonto där historiken använder resultatkonto',
    'Kostnaden är bokförd på ett balanskonto trots att leverantören historiskt alltid bokförts mot resultatkonto.',
  ),
  missingRecurringCost: meta(
    'anomaly.missing_recurring_cost',
    'anomaly',
    'Återkommande månadskostnad saknas',
    'En kostnad som återkommit i nästan varje historisk period saknas helt i denna period.',
  ),
} as const;

export type RuleKey = keyof typeof RULES;
