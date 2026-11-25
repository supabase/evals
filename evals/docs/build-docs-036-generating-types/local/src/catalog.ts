import type { Client } from './lib/supabase';

export type BookFormat = 'paperback' | 'hardcover' | 'ebook';

export type BookCard = {
  id: number;
  title: string;
  author: string;
  price_cents: number;
  format: BookFormat;
};

export async function listBooks(db: Client): Promise<BookCard[]> {
  const { data, error } = await db
    .schema('catalog')
    .from('books')
    .select('id, title, author, price_cents, format')
    .order('title');
  if (error) throw error;
  return data;
}

export async function searchBooks(db: Client, term: string) {
  const { data, error } = await db
    .schema('catalog')
    .rpc('search_books', { term });
  if (error) throw error;
  return data.map((book) => ({
    id: book.id,
    title: book.title,
    blurb: book.blurb ?? '',
  }));
}

export function priceLabel(book: BookCard): string {
  return `$${(book.price_cents / 100).toFixed(2)}`;
}
