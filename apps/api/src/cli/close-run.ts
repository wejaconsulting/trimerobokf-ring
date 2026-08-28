import { DEMO_IDS, seedDemoData } from '@trimeros/db';
import { DEMO_PERIOD } from '@trimeros/testing';
import { createRuntime } from '../runtime.js';

/**
 * Runs one synthetic close run and prints the result.
 *
 * This is the fastest way to see the whole vertical slice work:
 *   pnpm demo:close-run
 */
const periodKey = process.argv[2] ?? DEMO_PERIOD;
const runtime = await createRuntime();

try {
  await seedDemoData(runtime.db.db);

  const { closeRunId } = await runtime.engine.startCloseRun({
    tenantId: DEMO_IDS.tenant,
    clientId: DEMO_IDS.client,
    periodKey,
  });
  const summary = await runtime.engine.executeCloseRun(DEMO_IDS.tenant, closeRunId);

  console.log(`\nClose run ${closeRunId} - ${periodKey}`);
  console.log(`Status: ${summary.status} (kan stängas: ${summary.canComplete ? 'ja' : 'nej'})`);
  console.log(
    `Avvikelser: ${summary.findingCount} (${summary.blockingFindingCount} blockerande, ` +
      `${summary.reviewCount} review, ${summary.manualCount} manuell bedömning)`,
  );
  console.log(`Poster utan anmärkning: ${summary.clearItemCount}\n`);

  console.log('Steg:');
  for (const step of summary.steps) {
    console.log(`  ${step.stepKey.padEnd(38)} ${step.status.padEnd(16)} ${step.message ?? ''}`);
  }

  if (summary.reasons.length > 0) {
    console.log('\nHinder för att stänga perioden:');
    for (const reason of summary.reasons) console.log(`  - ${reason}`);
  }
} finally {
  await runtime.close();
}
