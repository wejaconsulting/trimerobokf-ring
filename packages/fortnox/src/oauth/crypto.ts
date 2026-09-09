import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for Fortnox tokens.
 *
 * Refresh tokens are long-lived bearer credentials for a client's accounting
 * system. They are sealed with AES-256-GCM before they reach the database, so
 * a database dump alone is not enough to act as the client.
 *
 * Two properties beyond "it is encrypted":
 *
 *  - **Fail closed.** There is no plaintext fallback. Without a valid key the
 *    system refuses to store or read a token rather than degrading quietly.
 *  - **Bound to its row.** The tenant/client/kind triple is passed as
 *    additional authenticated data, so a ciphertext lifted from one row cannot
 *    be pasted into another - it fails the auth tag check instead of
 *    decrypting into someone else's credential.
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const FORMAT_VERSION = 'v1';

export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionKeyError';
  }
}

export class SealedSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedSecretError';
  }
}

/**
 * Parses the configured key.
 *
 * Accepts base64 or base64url for 32 bytes. Anything else throws with a message
 * that says how to generate a correct one, because the alternative - a startup
 * that half-works until the first token write - is worse.
 */
export function loadEncryptionKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === '') {
    throw new EncryptionKeyError(
      'FORTNOX_TOKEN_ENCRYPTION_KEY is not set. Generate one with `pnpm fortnox:keygen`.',
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), 'base64');
  } catch {
    throw new EncryptionKeyError('FORTNOX_TOKEN_ENCRYPTION_KEY is not valid base64.');
  }
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `FORTNOX_TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        'Generate one with `pnpm fortnox:keygen`.',
    );
  }
  return key;
}

export function generateEncryptionKey(): string {
  return randomBytes(KEY_BYTES).toString('base64');
}

/** Identifies which row a ciphertext belongs to. Authenticated, not secret. */
export interface SecretContext {
  readonly tenantId: string;
  readonly clientId: string;
  readonly kind: string;
}

function aad(context: SecretContext): Buffer {
  return Buffer.from(`${context.tenantId}|${context.clientId}|${context.kind}`, 'utf8');
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function sealSecret(key: Buffer, plaintext: string, context: SecretContext): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function openSecret(key: Buffer, sealed: string, context: SecretContext): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new SealedSecretError('Sealed secret is malformed or has an unsupported version.');
  }
  const [, ivPart, tagPart, ctPart] = parts as [string, string, string, string];
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivPart, 'base64url'));
  decipher.setAAD(aad(context));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key, tampered ciphertext, or a ciphertext from another row.
    throw new SealedSecretError('Sealed secret failed authentication and was not decrypted.');
  }
}

/**
 * A short, stable, non-reversible label for a token.
 *
 * This is what may appear in an audit event or a log line: enough to tell "the
 * token rotated" from "the same token was reused", useless to an attacker.
 * Keyed so it cannot be precomputed.
 */
export function secretFingerprint(key: Buffer, plaintext: string): string {
  return createHmac('sha256', key).update(plaintext, 'utf8').digest('hex').slice(0, 12);
}
