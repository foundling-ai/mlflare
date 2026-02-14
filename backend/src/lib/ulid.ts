const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(now: number, len: number): string {
  let str = '';
  for (let i = len; i > 0; i--) {
    str = ENCODING[now % 32] + str;
    now = Math.floor(now / 32);
  }
  return str;
}

function encodeRandom(len: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let str = '';
  for (const byte of bytes) {
    str += ENCODING[byte % 32];
  }
  return str;
}

export function ulid(): string {
  const time = encodeTime(Date.now(), 10);
  const random = encodeRandom(16);
  return time + random;
}
