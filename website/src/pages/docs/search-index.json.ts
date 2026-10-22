import type { APIRoute } from 'astro';
import { buildSearchIndex } from '../../lib/docs';

/** The browser-side search dialog reads this once, on first use. */
export const prerender = true;

export const GET: APIRoute = async () => {
  const index = await buildSearchIndex();
  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
