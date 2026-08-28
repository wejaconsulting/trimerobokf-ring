# The accounting decision model

## The problem this solves

An accounting agent has to answer one question about every posting: **how much human attention
does this need?** Get it wrong in one direction and the consultant reads everything, which is
the status quo. Get it wrong in the other and something material is booked without anyone
looking.

The naive answer is to ask a language model how confident it is. That is rejected here, for a
concrete reason: a model's self-reported confidence is not calibrated against Swedish
bookkeeping risk, it is not stable across prompt versions, and it cannot be explained to an
auditor. **Self-reported confidence is not an input to this model.**

Instead: **hard gates** that can veto automation outright, plus a **weighted score** over
signals that can each be traced to a counted fact.

---

## The three levels

### Automatic

May be used **only** when all of the following hold:

- a deterministic rule matched,
- the required documentation is present,
- every mandatory bookkeeping validation passed,
- the period is open,
- the amount is within the client's automation limit,
- no conflicting finding exists,

**and** the weighted score is ≥ 0.85.

In shadow mode the result is only ever simulated. `automatic` means "the system would have
done this without asking" — it is shown to the consultant precisely so they can judge whether
they agree, before any phase grants that permission.

### Review

Used when there is a probable proposal but some uncertainty remains. The UI shows the
proposal, the underlying document status, the historical comparison, the matched rules, the
reason for review, the expected effect on the books (debit/credit, VAT, dimensions), and the
proposed Fortnox payload.

### Manual assessment

Forced, regardless of score, whenever any of these is true:

| Gate | Rationale |
| --- | --- |
| Documentation missing | Input VAT and deductibility both depend on it. |
| VAT treatment uncertain | A wrong VAT code is a filing error, not a bookkeeping preference. |
| Professional judgement required | Tax or accounting judgement is not the system's to make. |
| The period is locked | Nothing may be posted; the question is procedural. |
| The amount is material | Materiality is the profession's own threshold for attention. |
| Rules or data conflict | Two answers means the model of the client is wrong. |
| A required Fortnox capability is missing | Guessing around a missing API is how silent corruption starts. |

---

## The score

Ten signals, each normalised to `[0, 1]` where 1 supports automation.

| Signal | Weight | What it measures |
| --- | ---: | --- |
| `deterministicRuleMatch` | 0.20 | Did a client rule or account mapping match exactly? |
| `documentCompleteness` | 0.18 | Is statutory documentation present and readable? |
| `vatConsistency` | 0.12 | Does the VAT code and amount agree with the account and document? |
| `historicalConsistency` | 0.12 | Does this look like what this client/supplier has done before? |
| `amountConsistency` | 0.10 | Is the amount in line with the same recurring posting? |
| `counterpartyIdentityMatch` | 0.08 | Was the counterparty identified with confidence? |
| `duplicateRisk` | 0.08 | Inverted: 1 = certainly not a duplicate. |
| `dimensionConsistency` | 0.05 | Are required cost center / project dimensions present? |
| `reconciliationImpact` | 0.04 | Inverted: 1 = breaks no open reconciliation. |
| `materiality` | 0.03 | Inverted: 1 = immaterial. Computed as `1 − amount/threshold`. |
| **Total** | **1.00** | Asserted by a unit test. |

### Why these weights

The two highest weights are the two facts that most reliably separate routine from
non-routine in Swedish bookkeeping: *did a rule match* and *is there a receipt*. Together they
are 0.38, which means a posting that fails both cannot reach the automatic threshold no matter
how ordinary everything else looks.

VAT and history sit at 0.12 each because they are the strongest *statistical* signals but are
still inference — a supplier legitimately changes what it invoices for.

Materiality carries only 0.03 in the score, which looks wrong until you notice it is also a
**hard gate**. A material amount forces manual assessment outright, so it does not need to win
on weight; the low weight simply lets it nudge borderline cases.

Thresholds: `automatic ≥ 0.85`, `review ≥ 0.45`, below that manual assessment. The gap between
0.45 and 0.85 is intentionally wide: review is the *default* for anything the system noticed
at all.

---

## Findings and proposals are scored separately

A finding says "something is off". A proposal says "here is the correction". They get
independent decision outcomes, because a high-severity finding can have a completely routine
fix.

Worked example from the demo dataset:

- **Finding**: a periodisation voucher posts 6 000 kr to account 5410 with no cost center.
  Severity `medium`, blocking (it fails a mandatory validation), decision level `review`.
- **Proposal**: reclassify to cost center `KONS`, per the client rule for account 5410. Every
  gate passes — deterministic rule matched, documentation unchanged, period open, 6 000 kr is
  below the 10 000 kr automation limit, no conflict — and the score is **0.99**. Level:
  `automatic`.

The consultant sees a `review` finding whose fix is `automatic`. That is the correct and
useful reading: *the problem needs noting, the remedy does not need debating.*

Contrast with the missing rent:

- **Finding**: the 25 000 kr monthly rent from L001, present in 12 of 12 historical periods, is
  absent. Severity `high`, decision level `manual_assessment`.
- **Proposal**: accrue the median amount against 2990. `requiredDocumentationPresent` is false
  (no invoice exists) and 25 000 kr is at the materiality threshold, so both a gate and the
  score push it to `manual_assessment`.

---

## Mandatory deterministic validations

These are not heuristics. Each produces a **blocking** finding.

| # | Validation | Finding type |
| ---: | --- | --- |
| 1 | Debit equals credit | `validation.unbalanced_voucher` |
| 2 | Every account exists and is active | `validation.unknown_or_inactive_account` |
| 3 | The date falls inside a financial year | `validation.date_outside_financial_year` |
| 4 | The period is not locked | `validation.period_locked` |
| 5 | VAT amount matches an allowed rate (±1 kr) | `validation.implausible_vat` |
| 6 | Input VAT is not claimed without documentation | `validation.input_vat_without_documentation` |
| 7 | Required cost center / project is present | `validation.missing_required_dimension` |
| 8 | The same source record is not booked twice | `validation.duplicate_source_record` |
| 9 | The same workflow action is idempotent | `processed_source_records` + step `idempotencyKey` |
| 10 | An unimplemented step carrying work blocks the period | `validation.step_not_implemented` |
| 11 | No period reaches `complete` with blocking findings open | `assessCompletion` in the state machine |

---

## The ten anomaly rules

Each is deterministic and states the numbers behind its conclusion.

| Rule | Fires when | Example rationale it produces |
| --- | --- | --- |
| Unusual account for supplier | The supplier has never been booked to this account | "L004 has been booked to 6212 (12 times); this voucher uses 5910." |
| Deviating VAT code | The code differs from the account's dominant historical code | "Account 6110 is normally booked with MP1; this row uses MP2." |
| Unusual amount | Deviation from the supplier's median exceeds the policy threshold | "Median 3 500,00 kr over 12 postings; this voucher is 14 000,00 kr." |
| Possible duplicate | Same supplier, date and total within the period | "LF86 and LF87 share supplier, date and amount." |
| Missing documentation | No file connection and no documented invoice | "No file is connected in Fortnox." |
| Missing cost center / project | A required dimension is absent | "Account 5410 is normally booked with a cost center." |
| Transaction in wrong period | Invoice date and booking date fall in different months | "Invoice dated 2025-06-15, booked 2025-08-10." |
| Manual voucher unusual | A manual voucher uses a rare account or a material amount | "Account 6992 used fewer than 3 times; 45 000,00 kr exceeds materiality." |
| Balance instead of result account | The supplier's history is exclusively result accounts | "L007 always booked to 5460 in 13 postings; this row hits 1790." |
| Missing recurring cost | A supplier+account seen in ≥70 % of history periods is absent | "L001/5010 appeared in 12 of 12 periods; absent in 2025-08." |

---

## Deduplication

Multiple checks noticing the same problem must produce **one** queue item.

The deduplication key is `clientId | periodKey | issueClass | subject` — and it deliberately
**excludes the rule id**. Rules that see the same underlying problem pass the same
`issueClass`, so they collapse.

Merge policy, chosen to always err toward human attention:

| Field | Rule |
| --- | --- |
| Severity | Highest wins |
| Blocking | `true` if any is blocking |
| Requires consultant | `true` if any requires one |
| Decision level | Most restrictive wins |
| Decision score | **Lowest** wins |
| Evidence | Unioned |
| Rule ids | Recorded in `mergedFromRuleIds` so the UI can say "N checks reacted" |

Two real merges in the demo data:

1. `validation.input_vat_without_documentation` + `anomaly.missing_documentation` → one item
   for the undocumented purchase, blocking, at manual assessment.
2. `validation.duplicate_source_record` + `anomaly.possible_duplicate` → one item for the
   twice-booked SaaS invoice, blocking, critical.

Enforced at two levels: `consolidateFindings` in the domain, and a unique index on
`(tenant_id, close_run_id, deduplication_key)` in Postgres. The database is the backstop.

---

## Every finding carries

Type · severity · account/transaction/invoice · amount · description · evidence references ·
why the system reacted · suggested action · decision score · requires-consultant flag ·
deduplication key · status · rule id and rule version.
