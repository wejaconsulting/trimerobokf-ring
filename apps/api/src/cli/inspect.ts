import { DEMO_IDS } from '@trimeros/db';
import { createRuntime } from '../runtime.js';

/** Small diagnostic: prints the proposals and decision levels of the latest run. */
const runtime = await createRuntime();
try {
  const runs = await runtime.repos.listCloseRuns({ tenantId: DEMO_IDS.tenant }, DEMO_IDS.client);
  const latest = runs[0];
  if (!latest) throw new Error('No close run found. Run `pnpm demo:close-run` first.');

  const proposals = await runtime.repos.listProposals({ tenantId: DEMO_IDS.tenant }, latest.id);
  console.log(`Proposals for ${latest.id}:`);
  for (const p of proposals) {
    console.log(`  ${p.decisionLevel.padEnd(18)} score=${p.decisionScore.toFixed(2)} ${p.description}`);
    console.log(`     -> ${p.simulatedFortnoxEndpoint}  hash=${p.simulatedPayloadHash}`);
    console.log(`     ${JSON.stringify(p.simulatedFortnoxPayload)}`);
  }

  const audits = await runtime.repos.listAuditEvents({ tenantId: DEMO_IDS.tenant }, { closeRunId: latest.id });
  console.log(`\nAudit events: ${audits.length}`);
  const sim = audits.filter((a) => a.result === 'simulated');
  console.log(`Simulated Fortnox writes: ${sim.length}`);
  console.log(`Real Fortnox writes: ${audits.filter((a) => a.fortnoxId !== null).length}`);
} finally {
  await runtime.close();
}
