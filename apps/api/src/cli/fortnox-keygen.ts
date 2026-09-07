import { generateEncryptionKey } from '@trimeros/fortnox';

/**
 * Prints a token-encryption key.
 *
 * Setting this up by hand invites a 16-byte "key" pasted from a password
 * manager, which fails only once a real token needs storing. One command that
 * emits a correct one removes that failure mode.
 *
 * The key is printed to stdout and never written to disk: it belongs in the
 * deployment's secret store, not in the repository.
 */
const key = generateEncryptionKey();

process.stdout.write(`FORTNOX_TOKEN_ENCRYPTION_KEY=${key}\n`);
process.stderr.write(
  '\nStore this in your hosting platform’s secret manager (Render: Environment,\n' +
    'Railway: Variables). Do not commit it.\n' +
    '\nRotating it makes every stored Fortnox token unreadable: each client has to\n' +
    'reconnect. That is a safe operation, just a disruptive one.\n',
);
