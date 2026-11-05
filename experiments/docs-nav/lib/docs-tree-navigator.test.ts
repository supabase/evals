import { describe, expect, it } from 'vitest';
import { createTreeSession, treeUrl } from './docs-tree-navigator.mjs';

const URL = 'https://supabase.com/docs/nav-tree.json';

const TREE = {
  name: 'option-1',
  root: {
    label: 'Supabase Docs',
    children: [
      {
        label: 'Run and manage',
        description:
          'Projects, network, team access, security, billing, and logs',
        children: [
          {
            label: 'Network',
            route: '/guides/platform/network',
            children: [
              {
                label: 'SSL enforcement',
                route: '/guides/platform/ssl-enforcement',
              },
            ],
          },
          { label: 'Billing', route: '/guides/platform/billing' },
        ],
      },
      { label: 'Start', route: '/guides/getting-started' },
    ],
  },
};

describe('treeUrl', () => {
  it('points at the docs tree for the variant', () => {
    expect(treeUrl({})).toBe(URL);
    expect(
      treeUrl({
        DOCS_ORIGIN: 'https://docs-git-ia-nav-supabase.vercel.app/',
        DOCS_IA_VARIANT: 'option-1',
      })
    ).toBe(
      'https://docs-git-ia-nav-supabase.vercel.app/docs/nav-tree.json?docs-ia-mvp-v1=option-1'
    );
  });
});

describe('createTreeSession', () => {
  it('shows one level at a time, with subheads and no urls', () => {
    const session = createTreeSession(TREE, URL);
    const top = session.open('root').text;
    const manage = session.open('1').text;

    expect(top).toContain(`Tree: ${URL}`);
    expect(top).toContain('- [1] Run and manage (a section)');
    expect(top).toContain(
      '  Projects, network, team access, security, billing, and logs'
    );
    expect(top).not.toContain('Network');
    expect(manage).toContain('- [1.1] Network (a page, and a section)');
    expect(manage).not.toContain('SSL enforcement');
    expect(manage).not.toContain('/guides/');
  });

  it('refuses sections that no opened section lists', () => {
    const session = createTreeSession(TREE, URL);
    session.open('root');
    expect(session.open('1.1').isError).toBe(true);
    expect(session.choose('1.1.1').isError).toBe(true);
  });

  it('allows one choice of a page', () => {
    const session = createTreeSession(TREE, URL);
    session.open('root');
    session.open('1');
    expect(session.choose('1').isError).toBe(true);
    const chosen = session.choose('1.2');
    expect(chosen.text).toContain('Chosen: [1.2] Run and manage › Billing');
    expect(chosen.text).toContain(`Tree: ${URL}`);
    expect(session.choose('2').isError).toBe(true);
  });
});
