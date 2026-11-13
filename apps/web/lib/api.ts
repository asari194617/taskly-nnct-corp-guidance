export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL || "http://127.0.0.1:3071"
).replace(/\/$/, "");
export class APIError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok)
    throw new APIError(
      response.status,
      response.status === 401
        ? "ログインの有効期限が切れました。もう一度ログインしてください。"
        : response.status === 422
          ? "名簿番号を確認してください。"
          : "情報を取得できませんでした。時間をおいて、もう一度お試しください。",
    );
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
export type SignedDocumentURL = { url: string; expires_at: string };
export async function documentURL(
  id: string,
  signal?: AbortSignal,
): Promise<SignedDocumentURL> {
  return api<SignedDocumentURL>(
    `/api/documents/${encodeURIComponent(id)}/url`,
    { signal },
  );
}
