import type { APIRoute } from 'astro';
import { buildSearchIndex, loadDocsIndex } from '../../../../lib/docs';

export const prerender = true;

export function getStaticPaths() {
  const { versions, defaultVersion } = loadDocsIndex();
  return versions
    .filter((version) => version.id !== defaultVersion.id)
    .map((version) => ({ params: { version: version.id } }));
}

export const GET: APIRoute = async ({ params }) => {
  const version = params.version;
  if (!version) return new Response('Not found', { status: 404 });

  const index = await buildSearchIndex(version);
  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
