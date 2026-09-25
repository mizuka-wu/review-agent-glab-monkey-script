import { describe, expect, it } from 'vitest';

// Test the obfuscation logic (inline since it's private to settings.ts)
function xorEncode(text: string, key: string): string {
  // Encode to UTF-8 bytes first to handle Unicode
  const bytes = new TextEncoder().encode(text);
  const keyBytes = new TextEncoder().encode(key);
  const result = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    result[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
  }
  // Convert to base64
  return btoa(String.fromCharCode(...result));
}

function xorDecode(encoded: string, key: string): string {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    const keyBytes = new TextEncoder().encode(key);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return encoded;
  }
}

const KEY = 'RA-2024-GitLab-Review';

describe('secure key obfuscation', () => {
  it('round-trips API key', () => {
    const original = 'sk-proj-1234567890abcdef';
    const encoded = xorEncode(original, KEY);
    expect(encoded).not.toBe(original);
    expect(encoded).not.toContain(original);
    const decoded = xorDecode(encoded, KEY);
    expect(decoded).toBe(original);
  });

  it('round-trips GitLab PAT', () => {
    const original = 'glpat-abcdefghijklmnop123456';
    const encoded = xorEncode(original, KEY);
    const decoded = xorDecode(encoded, KEY);
    expect(decoded).toBe(original);
  });

  it('does not leak plaintext in encoded form', () => {
    const original = 'sk-super-secret-key';
    const encoded = xorEncode(original, KEY);
    expect(encoded).not.toContain('sk-super-secret-key');
    expect(encoded).not.toContain('secret');
  });

  it('handles empty string', () => {
    expect(xorEncode('', KEY)).toBe('');
    expect(xorDecode('', KEY)).toBe('');
  });

  it('handles legacy plain values gracefully', () => {
    // If value is not base64, decode returns as-is
    expect(xorDecode('not-base64!', KEY)).toBe('not-base64!');
  });

  it('handles unicode keys', () => {
    const original = 'sk-密钥-测试-123';
    const encoded = xorEncode(original, KEY);
    const decoded = xorDecode(encoded, KEY);
    expect(decoded).toBe(original);
  });
});
