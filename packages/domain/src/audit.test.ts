import { describe, expect, it } from 'vitest';
import { FORBIDDEN_AUDIT_KEYS, containsForbiddenKey, redactAuditPayload } from './audit.js';

describe('audit redaction', () => {
  it('redacts every forbidden key', () => {
    const payload = Object.fromEntries(FORBIDDEN_AUDIT_KEYS.map((k) => [k, 'secret-value']));
    const redacted = redactAuditPayload(payload) as Record<string, unknown>;
    for (const key of FORBIDDEN_AUDIT_KEYS) {
      expect(redacted[key]).toBe('[redacted]');
    }
    expect(JSON.stringify(redacted)).not.toContain('secret-value');
  });

  it('redacts nested credentials', () => {
    const redacted = redactAuditPayload({
      request: { headers: { authorization: 'Bearer abc123' } },
      voucher: { account: 1930 },
    });
    expect(JSON.stringify(redacted)).not.toContain('abc123');
    expect(JSON.stringify(redacted)).toContain('1930');
  });

  it('is case insensitive about key names', () => {
    const redacted = redactAuditPayload({ AccessToken: 'abc', Client_Secret: 'def' }) as Record<string, unknown>;
    expect(redacted.AccessToken).toBe('[redacted]');
    expect(redacted.Client_Secret).toBe('[redacted]');
  });

  it('truncates long free text so a document body cannot slip in', () => {
    const long = 'x'.repeat(5000);
    const redacted = redactAuditPayload({ note: long }) as { note: string };
    expect(redacted.note.length).toBeLessThan(600);
    expect(redacted.note).toContain('[truncated:5000]');
  });

  it('bounds array length and nesting depth', () => {
    const big = redactAuditPayload({ rows: Array.from({ length: 500 }, (_u, i) => i) }) as {
      rows: unknown[];
    };
    expect(big.rows.length).toBe(201);
    expect(big.rows.at(-1)).toBe('[truncated:300 more]');

    let deep: unknown = 'leaf';
    for (let i = 0; i < 12; i++) deep = { nested: deep };
    expect(JSON.stringify(redactAuditPayload(deep))).toContain('[truncated:depth]');
  });

  it('detects forbidden keys before a write is attempted', () => {
    expect(containsForbiddenKey({ a: { refresh_token: 'x' } })).toBe(true);
    expect(containsForbiddenKey({ a: { account: 1930 } })).toBe(false);
  });

  it('preserves ordinary structured accounting data', () => {
    const payload = { Voucher: { VoucherRows: [{ Account: 5010, Debit: 25000, Credit: 0 }] } };
    expect(redactAuditPayload(payload)).toEqual(payload);
  });
});
