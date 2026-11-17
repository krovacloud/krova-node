const API_PATH = "/api/v1";

/**
 * The API base URL the CLI talks to, by the same rule as the SDK's client: surrounding
 * whitespace and trailing slashes are removed, a bare origin (`https://krova.cloud`) gets
 * `/api/v1` appended, and any other path is kept as given. Call it only with a value that
 * is set; an empty or whitespace-only one means "not set" and is the caller's to skip.
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  if (url.pathname === "/" && !url.search && !url.hash) return `${trimmed}${API_PATH}`;
  return trimmed;
}
