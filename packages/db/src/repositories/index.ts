import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import * as s from '../schema/index.js';

/**
 * Repositories.
 *
 * Every method takes a `TenantScope` as its first argument and every generated
 * WHERE clause starts with `tenant_id = ...`. That is the isolation contract:
 * there is no way to reach a row from this layer without naming a tenant.
 */
export interface TenantScope {
  readonly tenantId: string;
}

export interface ClientScope extends TenantScope {
  readonly clientId: string;
}

export type NewFinding = typeof s.findings.$inferInsert;
export type FindingRow = typeof s.findings.$inferSelect;
export type CloseRunRow = typeof s.closeRuns.$inferSelect;
export type CloseRunStepRow = typeof s.closeRunSteps.$inferSelect;
export type ProposalRow = typeof s.bookingProposals.$inferSelect;
export type ProposalRowRow = typeof s.bookingProposalRows.$inferSelect;
export type ReviewItemRow = typeof s.reviewItems.$inferSelect;
export type AuditEventRow = typeof s.auditEvents.$inferSelect;
export type ClientRow = typeof s.clients.$inferSelect;
export type PolicyRow = typeof s.clientAccountingPolicies.$inferSelect;
export type ClientRuleRow = typeof s.clientRules.$inferSelect;
export type IntegrationConnectionRow = typeof s.integrationConnections.$inferSelect;
export type IntegrationCredentialRow = typeof s.integrationCredentials.$inferSelect;
export type OAuthAuthorizationRequestRow = typeof s.oauthAuthorizationRequests.$inferSelect;

export interface FindingFilter {
  readonly closeRunId?: string;
  readonly status?: readonly string[];
  readonly decisionLevel?: readonly string[];
  readonly severity?: readonly string[];
  readonly blocking?: boolean;
  readonly account?: number;
  readonly supplierNumber?: string;
  readonly minAmount?: number;
  readonly maxAmount?: number;
  readonly minDecisionScore?: number;
  readonly maxDecisionScore?: number;
  readonly type?: readonly string[];
}

export function createRepositories(db: Database) {
  return {
    // --- clients & configuration -----------------------------------------
    async listClients(scope: TenantScope): Promise<ClientRow[]> {
      return db.select().from(s.clients).where(eq(s.clients.tenantId, scope.tenantId)).orderBy(asc(s.clients.name));
    },

    async getClient(scope: ClientScope): Promise<ClientRow | undefined> {
      const [row] = await db
        .select()
        .from(s.clients)
        .where(and(eq(s.clients.tenantId, scope.tenantId), eq(s.clients.id, scope.clientId)))
        .limit(1);
      return row;
    },

    async getPolicy(scope: ClientScope): Promise<PolicyRow | undefined> {
      const [row] = await db
        .select()
        .from(s.clientAccountingPolicies)
        .where(
          and(
            eq(s.clientAccountingPolicies.tenantId, scope.tenantId),
            eq(s.clientAccountingPolicies.clientId, scope.clientId),
          ),
        )
        .limit(1);
      return row;
    },

    async listClientRules(scope: ClientScope): Promise<ClientRuleRow[]> {
      return db
        .select()
        .from(s.clientRules)
        .where(
          and(
            eq(s.clientRules.tenantId, scope.tenantId),
            eq(s.clientRules.clientId, scope.clientId),
            eq(s.clientRules.active, true),
          ),
        );
    },

    async getIntegrationConnection(
      scope: ClientScope,
      kind?: string,
    ): Promise<IntegrationConnectionRow | undefined> {
      const conditions = [
        eq(s.integrationConnections.tenantId, scope.tenantId),
        eq(s.integrationConnections.clientId, scope.clientId),
      ];
      if (kind) conditions.push(eq(s.integrationConnections.kind, kind));
      const [row] = await db
        .select()
        .from(s.integrationConnections)
        .where(and(...conditions))
        .limit(1);
      return row;
    },

    // --- periods & runs ---------------------------------------------------
    async upsertPeriod(scope: ClientScope, input: typeof s.accountingPeriods.$inferInsert) {
      const [row] = await db
        .insert(s.accountingPeriods)
        .values(input)
        .onConflictDoUpdate({
          target: [s.accountingPeriods.tenantId, s.accountingPeriods.clientId, s.accountingPeriods.periodKey],
          set: { status: input.status, fortnoxLockedThrough: input.fortnoxLockedThrough ?? null },
        })
        .returning();
      return row;
    },

    async getPeriod(scope: ClientScope, periodKey: string) {
      const [row] = await db
        .select()
        .from(s.accountingPeriods)
        .where(
          and(
            eq(s.accountingPeriods.tenantId, scope.tenantId),
            eq(s.accountingPeriods.clientId, scope.clientId),
            eq(s.accountingPeriods.periodKey, periodKey),
          ),
        )
        .limit(1);
      return row;
    },

    async createCloseRun(input: typeof s.closeRuns.$inferInsert): Promise<CloseRunRow> {
      const [row] = await db.insert(s.closeRuns).values(input).returning();
      if (!row) throw new Error('Failed to create close run');
      return row;
    },

    async getCloseRun(scope: TenantScope, closeRunId: string): Promise<CloseRunRow | undefined> {
      const [row] = await db
        .select()
        .from(s.closeRuns)
        .where(and(eq(s.closeRuns.tenantId, scope.tenantId), eq(s.closeRuns.id, closeRunId)))
        .limit(1);
      return row;
    },

    async listCloseRuns(scope: TenantScope, clientId?: string): Promise<CloseRunRow[]> {
      const where = clientId
        ? and(eq(s.closeRuns.tenantId, scope.tenantId), eq(s.closeRuns.clientId, clientId))
        : eq(s.closeRuns.tenantId, scope.tenantId);
      return db.select().from(s.closeRuns).where(where).orderBy(desc(s.closeRuns.createdAt));
    },

    async updateCloseRun(scope: TenantScope, closeRunId: string, patch: Partial<typeof s.closeRuns.$inferInsert>) {
      const [row] = await db
        .update(s.closeRuns)
        .set(patch)
        .where(and(eq(s.closeRuns.tenantId, scope.tenantId), eq(s.closeRuns.id, closeRunId)))
        .returning();
      return row;
    },

    // --- steps ------------------------------------------------------------
    async insertSteps(rows: (typeof s.closeRunSteps.$inferInsert)[]): Promise<void> {
      if (rows.length === 0) return;
      await db.insert(s.closeRunSteps).values(rows).onConflictDoNothing();
    },

    async listSteps(scope: TenantScope, closeRunId: string): Promise<CloseRunStepRow[]> {
      return db
        .select()
        .from(s.closeRunSteps)
        .where(and(eq(s.closeRunSteps.tenantId, scope.tenantId), eq(s.closeRunSteps.closeRunId, closeRunId)))
        .orderBy(asc(s.closeRunSteps.order));
    },

    async updateStep(
      scope: TenantScope,
      closeRunId: string,
      stepKey: string,
      patch: Partial<typeof s.closeRunSteps.$inferInsert>,
    ): Promise<CloseRunStepRow | undefined> {
      const [row] = await db
        .update(s.closeRunSteps)
        .set(patch)
        .where(
          and(
            eq(s.closeRunSteps.tenantId, scope.tenantId),
            eq(s.closeRunSteps.closeRunId, closeRunId),
            eq(s.closeRunSteps.stepKey, stepKey),
          ),
        )
        .returning();
      return row;
    },

    // --- imported data ----------------------------------------------------
    async upsertImportedRecords(rows: (typeof s.importedRecords.$inferInsert)[]): Promise<number> {
      if (rows.length === 0) return 0;
      let written = 0;
      // Chunked so a large import does not build one enormous statement.
      for (const chunk of chunks(rows, 500)) {
        const result = await db
          .insert(s.importedRecords)
          .values(chunk)
          .onConflictDoUpdate({
            target: [
              s.importedRecords.tenantId,
              s.importedRecords.clientId,
              s.importedRecords.kind,
              s.importedRecords.externalId,
            ],
            set: {
              payload: sql`excluded.payload`,
              contentHash: sql`excluded.content_hash`,
              periodKey: sql`excluded.period_key`,
              closeRunId: sql`excluded.close_run_id`,
              importedAt: new Date(),
            },
          })
          .returning();
        written += result.length;
      }
      return written;
    },

    async countImportedRecordsByKind(
      scope: ClientScope,
      periodKey: string,
      kind: string,
    ): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(s.importedRecords)
        .where(
          and(
            eq(s.importedRecords.tenantId, scope.tenantId),
            eq(s.importedRecords.clientId, scope.clientId),
            eq(s.importedRecords.periodKey, periodKey),
            eq(s.importedRecords.kind, kind),
          ),
        );
      return row?.count ?? 0;
    },

    async countImportedRecords(scope: ClientScope, periodKey: string): Promise<number> {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(s.importedRecords)
        .where(
          and(
            eq(s.importedRecords.tenantId, scope.tenantId),
            eq(s.importedRecords.clientId, scope.clientId),
            eq(s.importedRecords.periodKey, periodKey),
          ),
        );
      return row?.count ?? 0;
    },

    async replaceTransactions(scope: ClientScope, periodKey: string, rows: (typeof s.transactions.$inferInsert)[]) {
      await db
        .delete(s.transactions)
        .where(
          and(
            eq(s.transactions.tenantId, scope.tenantId),
            eq(s.transactions.clientId, scope.clientId),
            eq(s.transactions.periodKey, periodKey),
          ),
        );
      for (const chunk of chunks(rows, 500)) {
        if (chunk.length > 0) await db.insert(s.transactions).values(chunk);
      }
    },

    // --- source-record idempotency ---------------------------------------
    async listProcessedSourceKeys(scope: ClientScope): Promise<string[]> {
      const rows = await db
        .select({ key: s.processedSourceRecords.sourceKey })
        .from(s.processedSourceRecords)
        .where(
          and(
            eq(s.processedSourceRecords.tenantId, scope.tenantId),
            eq(s.processedSourceRecords.clientId, scope.clientId),
          ),
        );
      return rows.map((r) => r.key);
    },

    async recordProcessedSourceKeys(scope: ClientScope, closeRunId: string, keys: readonly string[]) {
      if (keys.length === 0) return;
      await db
        .insert(s.processedSourceRecords)
        .values(keys.map((sourceKey) => ({ ...scope, sourceKey, closeRunId })))
        .onConflictDoNothing();
    },

    // --- findings ---------------------------------------------------------
    /**
     * Upserts on (tenant, closeRun, deduplicationKey).
     *
     * Re-running a close run therefore refreshes findings in place instead of
     * multiplying them, which is the persistence half of the deduplication
     * guarantee. A finding a human has already decided on keeps its status.
     */
    async upsertFindings(rows: NewFinding[]): Promise<FindingRow[]> {
      if (rows.length === 0) return [];
      const out: FindingRow[] = [];
      for (const chunk of chunks(rows, 200)) {
        const result = await db
          .insert(s.findings)
          .values(chunk)
          .onConflictDoUpdate({
            target: [s.findings.tenantId, s.findings.closeRunId, s.findings.deduplicationKey],
            set: {
              type: sql`excluded.type`,
              severity: sql`excluded.severity`,
              subject: sql`excluded.subject`,
              amount: sql`excluded.amount`,
              description: sql`excluded.description`,
              rationale: sql`excluded.rationale`,
              suggestedAction: sql`excluded.suggested_action`,
              evidence: sql`excluded.evidence`,
              decisionLevel: sql`excluded.decision_level`,
              decisionScore: sql`excluded.decision_score`,
              decisionReasons: sql`excluded.decision_reasons`,
              requiresConsultant: sql`excluded.requires_consultant`,
              blocking: sql`excluded.blocking`,
              ruleId: sql`excluded.rule_id`,
              ruleVersion: sql`excluded.rule_version`,
              mergedFromRuleIds: sql`excluded.merged_from_rule_ids`,
              occurrences: sql`excluded.occurrences`,
              updatedAt: new Date(),
            },
          })
          .returning();
        out.push(...result);
      }
      return out;
    },

    async listFindings(scope: TenantScope, filter: FindingFilter = {}): Promise<FindingRow[]> {
      const conditions = [eq(s.findings.tenantId, scope.tenantId)];
      if (filter.closeRunId) conditions.push(eq(s.findings.closeRunId, filter.closeRunId));
      if (filter.status?.length) conditions.push(inArray(s.findings.status, [...filter.status]));
      if (filter.decisionLevel?.length)
        conditions.push(inArray(s.findings.decisionLevel, [...filter.decisionLevel]));
      if (filter.severity?.length) conditions.push(inArray(s.findings.severity, [...filter.severity]));
      if (filter.type?.length) conditions.push(inArray(s.findings.type, [...filter.type]));
      if (filter.blocking !== undefined) conditions.push(eq(s.findings.blocking, filter.blocking));
      if (filter.minAmount !== undefined) conditions.push(gte(s.findings.amount, filter.minAmount));
      if (filter.maxAmount !== undefined) conditions.push(lte(s.findings.amount, filter.maxAmount));
      if (filter.minDecisionScore !== undefined)
        conditions.push(gte(s.findings.decisionScore, filter.minDecisionScore));
      if (filter.maxDecisionScore !== undefined)
        conditions.push(lte(s.findings.decisionScore, filter.maxDecisionScore));
      if (filter.account !== undefined)
        conditions.push(sql`${s.findings.subject}->>'accountNumber' = ${String(filter.account)}`);
      if (filter.supplierNumber)
        conditions.push(sql`${s.findings.subject}->>'supplierNumber' = ${filter.supplierNumber}`);

      return db
        .select()
        .from(s.findings)
        .where(and(...conditions))
        .orderBy(desc(s.findings.blocking), desc(s.findings.amount));
    },

    async getFinding(scope: TenantScope, findingId: string): Promise<FindingRow | undefined> {
      const [row] = await db
        .select()
        .from(s.findings)
        .where(and(eq(s.findings.tenantId, scope.tenantId), eq(s.findings.id, findingId)))
        .limit(1);
      return row;
    },

    async updateFindingStatus(scope: TenantScope, findingId: string, status: string) {
      const [row] = await db
        .update(s.findings)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(s.findings.tenantId, scope.tenantId), eq(s.findings.id, findingId)))
        .returning();
      return row;
    },

    // --- proposals --------------------------------------------------------
    async insertProposal(
      proposal: typeof s.bookingProposals.$inferInsert,
      rows: Omit<typeof s.bookingProposalRows.$inferInsert, 'proposalId'>[],
    ): Promise<ProposalRow> {
      const [created] = await db.insert(s.bookingProposals).values(proposal).returning();
      if (!created) throw new Error('Failed to insert booking proposal');
      if (rows.length > 0) {
        await db.insert(s.bookingProposalRows).values(rows.map((r) => ({ ...r, proposalId: created.id })));
      }
      return created;
    },

    async deleteProposalsForRun(scope: TenantScope, closeRunId: string): Promise<void> {
      const existing = await db
        .select({ id: s.bookingProposals.id })
        .from(s.bookingProposals)
        .where(and(eq(s.bookingProposals.tenantId, scope.tenantId), eq(s.bookingProposals.closeRunId, closeRunId)));
      if (existing.length > 0) {
        await db.delete(s.bookingProposalRows).where(
          inArray(
            s.bookingProposalRows.proposalId,
            existing.map((e) => e.id),
          ),
        );
      }
      await db
        .delete(s.bookingProposals)
        .where(and(eq(s.bookingProposals.tenantId, scope.tenantId), eq(s.bookingProposals.closeRunId, closeRunId)));
    },

    async listProposals(scope: TenantScope, closeRunId: string): Promise<ProposalRow[]> {
      return db
        .select()
        .from(s.bookingProposals)
        .where(and(eq(s.bookingProposals.tenantId, scope.tenantId), eq(s.bookingProposals.closeRunId, closeRunId)));
    },

    async listProposalsForFinding(scope: TenantScope, findingId: string): Promise<ProposalRow[]> {
      return db
        .select()
        .from(s.bookingProposals)
        .where(and(eq(s.bookingProposals.tenantId, scope.tenantId), eq(s.bookingProposals.findingId, findingId)));
    },

    async listProposalRows(proposalIds: readonly string[]): Promise<ProposalRowRow[]> {
      if (proposalIds.length === 0) return [];
      return db
        .select()
        .from(s.bookingProposalRows)
        .where(inArray(s.bookingProposalRows.proposalId, [...proposalIds]));
    },

    // --- review -----------------------------------------------------------
    async upsertReviewItems(rows: (typeof s.reviewItems.$inferInsert)[]): Promise<void> {
      if (rows.length === 0) return;
      await db
        .insert(s.reviewItems)
        .values(rows)
        .onConflictDoNothing({ target: [s.reviewItems.tenantId, s.reviewItems.findingId] });
    },

    async listReviewItems(scope: TenantScope, closeRunId: string): Promise<ReviewItemRow[]> {
      return db
        .select()
        .from(s.reviewItems)
        .where(and(eq(s.reviewItems.tenantId, scope.tenantId), eq(s.reviewItems.closeRunId, closeRunId)));
    },

    async getReviewItemForFinding(scope: TenantScope, findingId: string): Promise<ReviewItemRow | undefined> {
      const [row] = await db
        .select()
        .from(s.reviewItems)
        .where(and(eq(s.reviewItems.tenantId, scope.tenantId), eq(s.reviewItems.findingId, findingId)))
        .limit(1);
      return row;
    },

    async updateReviewItem(scope: TenantScope, reviewItemId: string, patch: Partial<typeof s.reviewItems.$inferInsert>) {
      const [row] = await db
        .update(s.reviewItems)
        .set(patch)
        .where(and(eq(s.reviewItems.tenantId, scope.tenantId), eq(s.reviewItems.id, reviewItemId)))
        .returning();
      return row;
    },

    async insertApprovalDecision(input: typeof s.approvalDecisions.$inferInsert) {
      const [row] = await db.insert(s.approvalDecisions).values(input).returning();
      if (!row) throw new Error('Failed to record approval decision');
      return row;
    },

    async listApprovalDecisions(scope: TenantScope, findingId: string) {
      return db
        .select()
        .from(s.approvalDecisions)
        .where(and(eq(s.approvalDecisions.tenantId, scope.tenantId), eq(s.approvalDecisions.findingId, findingId)))
        .orderBy(asc(s.approvalDecisions.createdAt));
    },

    async insertCustomerRequest(input: typeof s.customerRequests.$inferInsert) {
      const [row] = await db.insert(s.customerRequests).values(input).returning();
      return row;
    },

    async listCustomerRequests(scope: TenantScope, closeRunId: string) {
      return db
        .select()
        .from(s.customerRequests)
        .where(and(eq(s.customerRequests.tenantId, scope.tenantId), eq(s.customerRequests.closeRunId, closeRunId)));
    },

    // --- audit ------------------------------------------------------------
    async appendAuditEvent(input: Omit<typeof s.auditEvents.$inferInsert, 'id'> & { id?: string }) {
      const [row] = await db
        .insert(s.auditEvents)
        .values({ id: input.id ?? randomUUID(), ...input })
        .returning();
      if (!row) throw new Error('Failed to append audit event');
      return row;
    },

    async listAuditEvents(scope: TenantScope, filter: { closeRunId?: string; correlationId?: string }) {
      const conditions = [eq(s.auditEvents.tenantId, scope.tenantId)];
      if (filter.closeRunId) conditions.push(eq(s.auditEvents.closeRunId, filter.closeRunId));
      if (filter.correlationId) conditions.push(eq(s.auditEvents.correlationId, filter.correlationId));
      return db
        .select()
        .from(s.auditEvents)
        .where(and(...conditions))
        .orderBy(asc(s.auditEvents.occurredAt));
    },

    // --- integrations -----------------------------------------------------

    async listIntegrationConnections(
      scope: TenantScope,
      kind?: string,
    ): Promise<IntegrationConnectionRow[]> {
      const conditions = [eq(s.integrationConnections.tenantId, scope.tenantId)];
      if (kind) conditions.push(eq(s.integrationConnections.kind, kind));
      return db
        .select()
        .from(s.integrationConnections)
        .where(and(...conditions))
        .orderBy(asc(s.integrationConnections.clientId));
    },

    async upsertIntegrationConnection(
      input: typeof s.integrationConnections.$inferInsert,
    ): Promise<IntegrationConnectionRow> {
      const [row] = await db
        .insert(s.integrationConnections)
        .values({ ...input, id: input.id ?? randomUUID() })
        .onConflictDoUpdate({
          target: [
            s.integrationConnections.tenantId,
            s.integrationConnections.clientId,
            s.integrationConnections.kind,
          ],
          set: {
            mode: input.mode,
            scopes: input.scopes,
            credentialRef: input.credentialRef ?? null,
            writesEnabled: input.writesEnabled ?? false,
            healthy: input.healthy ?? true,
            status: input.status ?? 'disconnected',
            statusCode: input.statusCode ?? null,
            statusChangedAt: input.statusChangedAt ?? null,
            connectedAt: input.connectedAt ?? null,
            connectedByUserId: input.connectedByUserId ?? null,
            remoteCompanyName: input.remoteCompanyName ?? null,
            remoteOrganisationNumber: input.remoteOrganisationNumber ?? null,
            lastCheckedAt: input.lastCheckedAt ?? null,
          },
        })
        .returning();
      if (!row) throw new Error('Failed to upsert integration connection');
      return row;
    },

    async updateIntegrationConnection(
      scope: ClientScope,
      kind: string,
      patch: Partial<typeof s.integrationConnections.$inferInsert>,
    ): Promise<void> {
      await db
        .update(s.integrationConnections)
        .set(patch)
        .where(
          and(
            eq(s.integrationConnections.tenantId, scope.tenantId),
            eq(s.integrationConnections.clientId, scope.clientId),
            eq(s.integrationConnections.kind, kind),
          ),
        );
    },

    async createAuthorizationRequest(
      input: Omit<typeof s.oauthAuthorizationRequests.$inferInsert, 'id'> & { id?: string },
    ): Promise<OAuthAuthorizationRequestRow> {
      const [row] = await db
        .insert(s.oauthAuthorizationRequests)
        .values({ ...input, id: input.id ?? randomUUID() })
        .returning();
      if (!row) throw new Error('Failed to create authorization request');
      return row;
    },

    /**
     * Claims a pending authorization request, by state hash alone.
     *
     * This is the one repository method that does not take a tenant scope, and
     * the exception is deliberate: at the callback we have nothing but the
     * `state` parameter, and resolving it to a tenant is precisely its job. It
     * is safe because the lookup is on a hash of 256 CSPRNG bits, and the
     * claim is atomic - the same UPDATE that returns the row is the one that
     * marks it consumed, so a replayed callback finds nothing.
     */
    async consumeAuthorizationRequest(
      stateHash: string,
      now: Date = new Date(),
    ): Promise<OAuthAuthorizationRequestRow | undefined> {
      const [row] = await db
        .update(s.oauthAuthorizationRequests)
        .set({ consumedAt: now })
        .where(
          and(
            eq(s.oauthAuthorizationRequests.stateHash, stateHash),
            isNull(s.oauthAuthorizationRequests.consumedAt),
            gt(s.oauthAuthorizationRequests.expiresAt, now),
          ),
        )
        .returning();
      return row;
    },

    async deleteExpiredAuthorizationRequests(now: Date = new Date()): Promise<void> {
      await db
        .delete(s.oauthAuthorizationRequests)
        .where(lte(s.oauthAuthorizationRequests.expiresAt, now));
    },

    async getIntegrationCredential(
      scope: ClientScope,
      kind: string,
    ): Promise<IntegrationCredentialRow | undefined> {
      const [row] = await db
        .select()
        .from(s.integrationCredentials)
        .where(
          and(
            eq(s.integrationCredentials.tenantId, scope.tenantId),
            eq(s.integrationCredentials.clientId, scope.clientId),
            eq(s.integrationCredentials.kind, kind),
          ),
        )
        .limit(1);
      return row;
    },

    async upsertIntegrationCredential(
      input: typeof s.integrationCredentials.$inferInsert,
    ): Promise<IntegrationCredentialRow> {
      const [row] = await db
        .insert(s.integrationCredentials)
        .values({ ...input, id: input.id ?? randomUUID() })
        .onConflictDoUpdate({
          target: [
            s.integrationCredentials.tenantId,
            s.integrationCredentials.clientId,
            s.integrationCredentials.kind,
          ],
          set: {
            sealedAccessToken: input.sealedAccessToken ?? null,
            sealedRefreshToken: input.sealedRefreshToken,
            accessTokenExpiresAt: input.accessTokenExpiresAt ?? null,
            refreshTokenExpiresAt: input.refreshTokenExpiresAt ?? null,
            grantedScopes: input.grantedScopes,
            refreshTokenFingerprint: input.refreshTokenFingerprint,
            rotationCount: input.rotationCount ?? 0,
            rotatedAt: input.rotatedAt ?? null,
          },
        })
        .returning();
      if (!row) throw new Error('Failed to upsert integration credential');
      return row;
    },

    /**
     * Stores a rotated token, but only if nothing else rotated first.
     *
     * Fortnox invalidates the previous refresh token on every refresh, so two
     * processes that both refresh produce one usable token and one dead one.
     * The compare-and-set on `rotationCount` means the loser finds out - it
     * gets `false` and re-reads - instead of overwriting the live credential
     * with the dead one.
     */
    async rotateIntegrationCredential(
      scope: ClientScope,
      kind: string,
      expectedRotationCount: number,
      patch: {
        sealedAccessToken: string;
        sealedRefreshToken: string;
        accessTokenExpiresAt: Date;
        refreshTokenExpiresAt: Date;
        grantedScopes: string[];
        refreshTokenFingerprint: string;
        rotatedAt: Date;
      },
    ): Promise<boolean> {
      const rows = await db
        .update(s.integrationCredentials)
        .set({ ...patch, rotationCount: expectedRotationCount + 1 })
        .where(
          and(
            eq(s.integrationCredentials.tenantId, scope.tenantId),
            eq(s.integrationCredentials.clientId, scope.clientId),
            eq(s.integrationCredentials.kind, kind),
            eq(s.integrationCredentials.rotationCount, expectedRotationCount),
          ),
        )
        .returning();
      return rows.length > 0;
    },

    async deleteIntegrationCredential(scope: ClientScope, kind: string): Promise<void> {
      await db
        .delete(s.integrationCredentials)
        .where(
          and(
            eq(s.integrationCredentials.tenantId, scope.tenantId),
            eq(s.integrationCredentials.clientId, scope.clientId),
            eq(s.integrationCredentials.kind, kind),
          ),
        );
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;

function* chunks<T>(items: readonly T[], size: number): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size);
}
