export const DOCS_ROOT: string;
export const BLOCKED_PREFIX: string;
export type PageLink = { href: string; label: string };
export function normalizeUrl(url: string, base?: string): string | null;
export function pageLinks(
  url: string,
  overlay?: Record<string, PageLink[]>
): Promise<{
  ok: boolean;
  status: number;
  finalUrl: string;
  html: string;
  links: PageLink[];
}>;
export function renderPage(
  url: string,
  overlay?: Record<string, PageLink[]>
): Promise<{ text: string }>;
