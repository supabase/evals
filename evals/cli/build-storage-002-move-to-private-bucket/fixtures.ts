export const MEDIA_BUCKET = 'media';

export const SEED_CONFIG_PATH = 'supabase/config.toml';

/** A seeded file: its key relative to the `media` bucket's objects_path and the sha256 of its bytes. */
export type SeedFile = { key: string; sha256: string };

export const AVATARS: readonly SeedFile[] = [
  {
    key: 'avatars/ava.svg',
    sha256: 'c718e59543eca74dcade526bd2a6192869533ea07e71aba25c5b12b3e8bd42f6',
  },
  {
    key: 'avatars/ben.svg',
    sha256: '3d98bddc4d11febdffb545a0f8de24812999c53f1e0f0d4e133cc5131ca3a930',
  },
  {
    key: 'avatars/cleo.svg',
    sha256: '24585533f48f9a3da49e185c32db44865acc2ab3377195ff36024fdd80da292f',
  },
];

export const INVOICES: readonly SeedFile[] = [
  {
    key: 'invoices/INV-2026-0141.pdf',
    sha256: '2a160722ca02a5d352d86027bd093a9db581d38198f330ca6d488ae5be83d7c6',
  },
  {
    key: 'invoices/INV-2026-0142.pdf',
    sha256: '8b95ffd6dca0f986e9082f3cdc47993a223dbc1f5c0eafb19cd1110c3e10dab1',
  },
  {
    key: 'invoices/INV-2026-0143.pdf',
    sha256: 'c4990e65fb877cda66ce06f2445c8b6a56ec4e9bdc5a026f387f829d76753535',
  },
];

/** The seeded invoice whose bytes hash to `sha256`, if any. */
export function invoiceFor(
  sha256: string | null | undefined
): SeedFile | undefined {
  if (!sha256) {
    return undefined;
  }
  return INVOICES.find((invoice) => invoice.sha256 === sha256);
}
