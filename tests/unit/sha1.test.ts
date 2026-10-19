import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha1Hex } from '../../src/core/sha1';

const nodeSha1 = (text: string) => createHash('sha1').update(text, 'utf8').digest('hex');

describe('sha1Hex', () => {
  it('matches the published vectors', () => {
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1Hex('The quick brown fox jumps over the lazy dog')).toBe('2fd4e1c67a2d28fced849ee1bb76e7391b93eb12');
    expect(sha1Hex('The quick brown fox jumps over the lazy dog.')).toBe('408d94384216f890ff7a0c3528e8bed1e0b01621');
  });

  it('matches Digest::SHA1.hexdigest for the repo paths used in line_code', () => {
    // 这两个值是在 GitLab 容器里用 Digest::SHA1.hexdigest 跑出来的，不是本地 node 算的
    expect(sha1Hex('src/payment.ts')).toBe('605cb4731a7c5462bec11f720ce8319a24592593');
    expect(sha1Hex('中文/文件.ts')).toBe('50b8933d3fac34527fc54f109f167c66fa8366f2');
    expect(sha1Hex('a.ts')).toBe('02699cd6ca65aa6819d7e387678d8ea5359b5e59');
  });

  it('pads across every block boundary', () => {
    for (const length of [55, 56, 63, 64, 65, 119, 120, 127, 128, 448, 512, 1000]) {
      const text = 'a'.repeat(length);
      expect(sha1Hex(text), `${length} 字节`).toBe(nodeSha1(text));
    }
  });

  it('hashes non-ascii paths as utf-8 bytes', () => {
    for (const text of ['src/🚀.ts', 'src/my file.ts', '目录/子目录/文件-名前.ts', 'a\tb\nc']) {
      expect(sha1Hex(text), text).toBe(nodeSha1(text));
    }
  });

  it('agrees with node crypto on generated paths of every length', () => {
    let seed = 20261019;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const alphabet = 'abcdefghij/中文目录_-.ts 🚀';
    for (let round = 0; round < 200; round += 1) {
      const length = Math.floor(next() * 200);
      const text = Array.from({ length }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
      expect(sha1Hex(text), JSON.stringify(text)).toBe(nodeSha1(text));
    }
  });
});
