const encoder = new TextEncoder();

function base64UrlEncode(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function getKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJwt(
  payload: Record<string, unknown>,
  secret: string,
  expiresInSeconds = 86400,
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = { ...payload, iat: now, exp: now + expiresInSeconds };

  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getKey(secret);
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput)),
  );
  const sigB64 = base64UrlEncode(signature);

  return `${signingInput}.${sigB64}`;
}

export async function verifyJwt(
  token: string,
  secret: string,
): Promise<Record<string, unknown> | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await getKey(secret);
  const signature = base64UrlDecode(sigB64);
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    encoder.encode(signingInput),
  );
  if (!valid) return null;

  const payload = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(payloadB64)),
  );

  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}
