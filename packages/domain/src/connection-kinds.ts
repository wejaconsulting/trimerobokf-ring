/**
 * The two kinds of integration connection, which are not the same thing.
 *
 * A client can have both at once, and during phase 1 usually does:
 *
 *  - `fortnox` describes **where a close run reads its data from**. In this
 *    phase that is the mock adapter, so the row says `mode: 'mock'` and has no
 *    credential.
 *  - `fortnox_oauth` describes **a live OAuth grant** for that client. It holds
 *    the sealed tokens and the result of the last connection check.
 *
 * They are separate rows because they answer separate questions, and conflating
 * them would mean a client who connected their real Fortnox account silently
 * changed what a run reads. Every lookup names the kind it wants: a query that
 * omits it gets whichever row the database happens to return first.
 */
export const FORTNOX_DATA_SOURCE_KIND = 'fortnox';
export const FORTNOX_CONNECTION_KIND = 'fortnox_oauth';
