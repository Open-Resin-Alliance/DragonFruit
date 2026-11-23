import { unzlibSync } from 'fflate';

/**
 * Inflate one zlib stream, off the main thread where the webview allows it.
 *
 * The platform's `DecompressionStream` is the fast path: genuinely off-thread,
 * and its output is a fresh `ArrayBuffer` a geometry can view without copying.
 * `fflate`'s async pool is not an alternative — in a `crossOriginIsolated`
 * webview it waits on its workers through `SharedArrayBuffer` and blocks the
 * thread it should free.
 *
 * `DecompressionStream` needs Safari 16.4, and a webview is the WebKit its macOS
 * shipped with, not the user's Safari: macOS 12 stays on WebKit 15.6 and macOS
 * 13.0–13.2 on 16.x. There the bytes are inflated synchronously with `fflate`,
 * which holds the main thread while it runs but opens the file.
 */
export async function inflateZlib(packed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') return unzlibSync(packed);

  const source = new ReadableStream<BufferSource>({
    start(controller) {
      // `BufferSource` insists on an `ArrayBuffer`-backed view, which TS's
      // typed-array generics cannot see through a `subarray`; the bytes are the
      // same either way.
      controller.enqueue(packed as BufferSource);
      controller.close();
    },
  });
  const stream = source.pipeThrough<Uint8Array>(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
