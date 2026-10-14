// MurmurHash3, x86 32-bit variant, as published by Austin Appleby in SMHasher
// (src/MurmurHash3.cpp, MurmurHash3_x86_32). Integer arithmetic only:
// Math.imul for 32-bit multiplication and >>> 0 for the unsigned result.

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

const encoder = new TextEncoder();

function rotl32(x: number, r: number): number {
  return (x << r) | (x >>> (32 - r));
}

function mixK(k: number): number {
  return Math.imul(rotl32(Math.imul(k, C1), 15), C2);
}

/** Hashes bytes with MurmurHash3_x86_32 and returns an unsigned 32-bit integer. */
export function murmur3X86_32(bytes: Uint8Array, seed = 0): number {
  const length = bytes.length;
  const blockEnd = length - (length & 3);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let h = seed | 0;

  for (let i = 0; i < blockEnd; i += 4) {
    h ^= mixK(view.getUint32(i, true));
    h = rotl32(h, 13);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  const tail = length & 3;
  if (tail > 0) {
    let k = 0;
    if (tail === 3) k ^= view.getUint8(blockEnd + 2) << 16;
    if (tail >= 2) k ^= view.getUint8(blockEnd + 1) << 8;
    k ^= view.getUint8(blockEnd);
    h ^= mixK(k);
  }

  h ^= length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The UTF-8 bytes of a string, as TextEncoder produces them (a lone surrogate becomes U+FFFD). */
export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/** MurmurHash3_x86_32 over the UTF-8 bytes of a string. */
export function murmur3X86_32Utf8(text: string, seed = 0): number {
  return murmur3X86_32(utf8(text), seed);
}
