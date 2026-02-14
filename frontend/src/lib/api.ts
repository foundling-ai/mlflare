let token: string | null = null;

export function setToken(t: string) {
  token = t;
}

export function getToken(): string | null {
  return token;
}

export function clearToken() {
  token = null;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const resp = await fetch(path, { ...options, headers });

  if (resp.status === 401) {
    clearToken();
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API error ${resp.status}: ${body}`);
  }

  return resp.json();
}
