import { describe, expect, it } from 'vitest';
import { createNavigator } from './docs-navigator.mjs';

const SITE = 'https://supabase.com';
const VARIANT = '?docs-ia-mvp-v1=option-1';

interface FakePage {
  html?: string;
  markdown?: string;
  redirectTo?: string;
}

function fakeSite(pages: Record<string, FakePage>) {
  const requested: string[] = [];
  async function fetch(url: string) {
    requested.push(url);
    const parsed = new URL(url);
    const key = `${parsed.origin}${parsed.pathname}`;
    const markdownKey = key.endsWith('.md') ? key.slice(0, -3) : null;
    const page = pages[markdownKey ?? key];
    const body = markdownKey ? page?.markdown : page?.html;
    return {
      ok: body !== undefined,
      status: body === undefined ? 404 : 200,
      url: page?.redirectTo ?? url,
      text: async () => body ?? '',
    };
  }
  return { fetch, requested };
}

function textOf(reply: { content: { text: string }[] }) {
  return reply.content.map((part) => part.text).join('\n');
}

const ROOT_HTML = `
  <a href="/docs/guides/auth">Auth</a>
  <a href="https://supabase.com/docs/guides/platform">Platform</a>
  <a href="https://supabase.com/pricing">Pricing</a>
  <a href="https://github.com/supabase/supabase">GitHub</a>
`;

describe('createNavigator', () => {
  it('opens the docs root and only the links on opened pages', async () => {
    const site = fakeSite({
      [`${SITE}/docs`]: { html: ROOT_HTML, markdown: '# Supabase docs' },
      [`${SITE}/docs/guides/auth`]: { html: '<main>Auth guide</main>' },
    });
    const navigator = createNavigator({ env: {}, fetch: site.fetch });

    const refused = await navigator.openPage(`${SITE}/docs/guides/auth`);
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/^Not opened:/);

    const root = textOf(await navigator.openPage(`${SITE}/docs`));
    expect(root).toContain(`Opened: ${SITE}/docs`);
    expect(root).toContain('# Supabase docs');
    expect(root).toContain(`- Auth: ${SITE}/docs/guides/auth`);
    expect(root).toContain(`- Pricing: ${SITE}/pricing`);
    expect(root).not.toContain('github.com');

    const auth = await navigator.openPage(`${SITE}/docs/guides/auth/`);
    expect(auth.isError).toBeUndefined();
    expect(textOf(auth)).toContain('Auth guide');
  });

  it('adds the variant to every request and shows it only on the opened page', async () => {
    const site = fakeSite({
      [`${SITE}/docs`]: { html: ROOT_HTML, markdown: '# Supabase docs' },
      [`${SITE}/docs/guides/auth`]: { html: '<main>Auth guide</main>' },
    });
    const navigator = createNavigator({
      env: { DOCS_IA_VARIANT: 'option-1' },
      fetch: site.fetch,
    });

    const root = textOf(await navigator.openPage(`${SITE}/docs${VARIANT}`));
    await navigator.openPage(`${SITE}/docs/guides/auth${VARIANT}`);

    expect(root).toContain(`Opened: ${SITE}/docs${VARIANT}\n`);
    expect(root).toContain(`- Auth: ${SITE}/docs/guides/auth\n`);
    expect(site.requested).toEqual([
      `${SITE}/docs${VARIANT}`,
      `${SITE}/docs.md${VARIANT}`,
      `${SITE}/docs/guides/auth${VARIANT}`,
      `${SITE}/docs/guides/auth.md${VARIANT}`,
    ]);
  });

  it('lists only navigation links in nav-only mode', async () => {
    const html = `
      <nav data-docs-nav="sidebar">
        <a href="/docs/guides/auth">Auth</a>
        <nav><a href="/docs/guides/auth/sessions">Sessions</a></nav>
      </nav>
      <main><a href="/docs/guides/platform">Platform</a></main>
      <noscript>
        <nav data-docs-nav="top-nav-subheads">
          <a href="/docs/guides/storage">Storage</a>
        </nav>
      </noscript>
    `;
    const site = fakeSite({ [`${SITE}/docs`]: { html } });
    const navigator = createNavigator({
      env: { DOCS_NAV_ONLY: '1' },
      fetch: site.fetch,
    });

    const root = textOf(await navigator.openPage(`${SITE}/docs`));
    const platform = await navigator.openPage(`${SITE}/docs/guides/platform`);

    expect(root).toContain(`- Auth: ${SITE}/docs/guides/auth\n`);
    expect(root).toContain(`- Sessions: ${SITE}/docs/guides/auth/sessions\n`);
    expect(root).toContain(`- Storage: ${SITE}/docs/guides/storage`);
    expect(root).not.toContain('- Platform:');
    expect(platform.isError).toBe(true);
  });
});
