/**
 * Authenticated blob access. Blob-backed attachment Links (`blobId`) can't be plain <a href>
 * targets — the download URL needs the bearer — so we fetch with auth and hand out object URLs.
 */
import { authedFetch, getSession } from "./client.ts";

/** Expand a URI Template level 1 (RFC 6570) — `{var}` with percent-encoding of the value. */
export function expandUriTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = vars[name];
    return value === undefined ? "" : encodeURIComponent(value);
  });
}

/**
 * Fetch a blob into an object URL. Callers own the URL and must revoke it
 * (URL.revokeObjectURL) when done.
 */
export async function fetchBlobObjectUrl(
  accountId: string,
  blobId: string,
  name = "attachment",
  type = "application/octet-stream",
): Promise<string> {
  const session = await getSession();
  if (!session.downloadUrl) throw new Error("Server exposes no blob download URL");
  const url = expandUriTemplate(session.downloadUrl, { accountId, blobId, name, type });
  const res = await authedFetch(url);
  if (!res.ok) throw new Error(`Attachment download failed: HTTP ${res.status}`);
  return URL.createObjectURL(await res.blob());
}

/** Trigger a browser download of a blob attachment. */
export async function downloadBlob(
  accountId: string,
  blobId: string,
  name: string,
  type?: string,
): Promise<void> {
  const objectUrl = await fetchBlobObjectUrl(accountId, blobId, name, type);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser a beat to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
}

export function fmtBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
