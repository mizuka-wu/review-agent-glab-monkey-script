function rol(value: number, bits: number) {
  return (value << bits) | (value >>> (32 - bits));
}

/**
 * GitLab 的 line_code 是 `SHA1(file_path)_old_line_new_line`（lib/gitlab/git.rb#diff_line_code），
 * 算它必须和 Digest::SHA1.hexdigest 逐字节一致。crypto.subtle 只在安全上下文里有（内网 http GitLab
 * 拿不到），而且是异步的，会把 buildDiscussionPayload 整条链路拖成 async，所以自带一份同步实现。
 */
export function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = new Uint8Array((Math.floor((bytes.length + 8) / 64) + 1) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);

  const digest = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const words = new Uint32Array(80);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(block + i * 4);
    for (let i = 16; i < 80; i += 1) {
      words[i] = rol(words[i - 3] ^ words[i - 8] ^ words[i - 14] ^ words[i - 16], 1);
    }

    let [a, b, c, d, e] = digest;
    for (let i = 0; i < 80; i += 1) {
      const f = i < 20 ? (b & c) | (~b & d)
        : i < 40 || i >= 60 ? b ^ c ^ d
          : (b & c) | (b & d) | (c & d);
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (rol(a, 5) + f + e + k + words[i]) | 0;
      e = d;
      d = c;
      c = rol(b, 30);
      b = a;
      a = temp;
    }

    digest[0] = (digest[0] + a) | 0;
    digest[1] = (digest[1] + b) | 0;
    digest[2] = (digest[2] + c) | 0;
    digest[3] = (digest[3] + d) | 0;
    digest[4] = (digest[4] + e) | 0;
  }

  return Array.from(digest, (word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
}
