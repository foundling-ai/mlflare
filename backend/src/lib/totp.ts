/**
 * RFC 6238 TOTP validation via Web Crypto HMAC-SHA1.
 * Supports +/- 1 time-step window (30s steps).
 */

const encoder = new TextEncoder();

function base32Decode(input: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const cleaned = input.replace(/[=\s]/g, '').toUpperCase();
  let bits = '';
  for (const char of cleaned) {
    const val = alphabet.indexOf(char);
    if (val === -1) throw new Error(`Invalid base32 character: ${char}`);
    bits += val.toString(2).padStart(5, '0');
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  }
  return bytes;
}

async function hmacSha1(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, data);
  return new Uint8Array(sig);
}

function intToBytes(num: number): Uint8Array {
  const bytes = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    bytes[i] = num & 0xff;
    num = Math.floor(num / 256);
  }
  return bytes;
}

async function generateTOTP(secret: Uint8Array, counter: number): Promise<string> {
  const counterBytes = intToBytes(counter);
  const hash = await hmacSha1(secret, counterBytes);
  const offset = hash[hash.length - 1] & 0x0f;
  const code =
    ((hash[offset] & 0x7f) << 24) |
    ((hash[offset + 1] & 0xff) << 16) |
    ((hash[offset + 2] & 0xff) << 8) |
    (hash[offset + 3] & 0xff);
  return (code % 1000000).toString().padStart(6, '0');
}

export async function validateTOTP(
  code: string,
  secretBase32: string,
  window = 1,
): Promise<boolean> {
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(Date.now() / 1000 / 30);

  for (let i = -window; i <= window; i++) {
    const expected = await generateTOTP(secret, counter + i);
    if (timingSafeEqual(code, expected)) {
      return true;
    }
  }
  return false;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
