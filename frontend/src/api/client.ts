const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

export async function apiFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  // Do not set Content-Type when the body is FormData — the browser sets the
  // correct multipart/form-data boundary automatically. Only inject the JSON
  // content-type for string bodies (i.e. JSON.stringify output).
  const contentTypeHeader: Record<string, string> =
    options?.body instanceof FormData
      ? {}
      : { "Content-Type": "application/json" };

  const { headers: _headers, ...restOptions } = options ?? {};
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      ...contentTypeHeader,
      ...(_headers ?? {}),
    },
    credentials: "include",
    ...restOptions,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Like apiFetch but for endpoints that return no body (204 No Content).
 * Throws on non-2xx responses.
 */
export async function apiFetchVoid(
  path: string,
  options?: RequestInit
): Promise<void> {
  const contentTypeHeader: Record<string, string> =
    options?.body instanceof FormData
      ? {}
      : { "Content-Type": "application/json" };

  const { headers: _headers, ...restOptions } = options ?? {};
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "X-Requested-With": "XMLHttpRequest",
      ...contentTypeHeader,
      ...(_headers ?? {}),
    },
    credentials: "include",
    ...restOptions,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
}
