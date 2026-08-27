'use client';

import { useEffect, useState, useRef, useLayoutEffect } from 'react';
import { Heart } from 'lucide-react';
import fallbackSponsors from '@/components/settings/sponsors.json';

export type Sponsor = {
  name: string;
  slug?: string;
  image?: string | null;
  website?: string | null;
  profile?: string | null;
  role?: string;
  tier?: string | null;
  totalAmountDonated?: number;
};

// Open Collective collectives for Open Resin Alliance.
// Sponsors are aggregated from both:
// - https://opencollective.com/openresinalliance (Siraya Tech, Cunabula)
// - https://opencollective.com/openresinalliance/projects/dragonfruit-slicer (project page, slug `dragonfruit-slicer` → WickedGrey)
// The fallback JSON is only the initial paint; live fetches from both are merged and deduped.
const OPENCOLLECTIVE_URL = 'https://opencollective.com/openresinalliance';
const OPENCOLLECTIVE_MEMBERS_URLS = [
  'https://opencollective.com/openresinalliance/members/all.json',
  'https://opencollective.com/dragonfruit-slicer/members/all.json',
];
function mapOCMemberToSponsor(entry: Record<string, unknown>): Sponsor | null {
  const role = typeof entry.role === 'string' ? entry.role : undefined;
  if (role !== 'BACKER') return null;
  const name = typeof entry.name === 'string' ? entry.name.trim() : '';
  if (!name) return null;
  return {
    name,
    profile: typeof entry.profile === 'string' ? entry.profile : null,
    image: typeof entry.image === 'string' ? entry.image : null,
    website: typeof entry.website === 'string' ? entry.website : null,
    role,
    tier: typeof entry.tier === 'string' ? entry.tier : null,
    totalAmountDonated: typeof entry.totalAmountDonated === 'number' ? entry.totalAmountDonated : undefined,
  };
}

function dedupeSponsors(list: Sponsor[]): Sponsor[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const key = (s.profile ?? s.name).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
// Persistent cache for sponsor avatars — fixes the “scanline top-to-bottom every open” flash.
// The browser HTTP cache *should* help, but Tauri’s WebView + S3 often re-streams the PNG
// progressively. We fetch once as a blob, convert to a data URL, and keep it in memory
// (`avatarCache`) *and* `localStorage` so the next About open is instant (no network, no progressive decode).
// Avatars are tiny (CP_Icon_250.png ~ 50KB), well within localStorage limits for the 2-·-N sponsors we have.
const AVATAR_STORAGE_PREFIX = 'sponsor-avatar:';
const avatarCache = new Map<string, string>();

function blobToDataURL(blob: Blob): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onloadend = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
  return promise;
}

function readCachedAvatar(src: string): string | null {
  if (avatarCache.has(src)) return avatarCache.get(src)!;
  try {
    const stored = typeof window !== 'undefined' ? window.localStorage.getItem(AVATAR_STORAGE_PREFIX + src) : null;
    if (stored) {
      avatarCache.set(src, stored);
      return stored;
    }
  } catch {
    // ignore — private mode or quota
  }
  return null;
}

function writeCachedAvatar(src: string, dataUrl: string) {
  avatarCache.set(src, dataUrl);
  try {
    window.localStorage.setItem(AVATAR_STORAGE_PREFIX + src, dataUrl);
  } catch {
    // quota exceeded — keep in-memory only
  }
}

function CachedAvatar({ src, alt, className }: { src: string; alt: string; className: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Hydrate from persistent cache before paint — avoids flash of spinner when already cached.
  // useLayoutEffect runs before browser paint, so a cached data URL appears instantly with no spinner.
  useLayoutEffect(() => {
    if (!src) return;
    const cached = readCachedAvatar(src);
    if (cached) {
      setUrl(cached);
      setLoaded(true);
    }
  }, [src]);

  useEffect(() => {
    if (!src) return;
    if (readCachedAvatar(src)) return; // already cached, no fetch needed

    let cancelled = false;
    const load = async () => {
      try {
        // Use same-origin proxy to bypass S3 CORS (No 'Access-Control-Allow-Origin').
        // In Tauri production the proxy won't exist, so we fallback to direct fetch.
        const proxyUrl = `/api/sponsor-avatar?url=${encodeURIComponent(src)}`;
        let res: Response | null = null;
        try {
          res = await fetch(proxyUrl, { cache: 'force-cache' });
          if (!res.ok) throw new Error(`proxy ${res.status}`);
        } catch {
          // Fallback: direct S3 fetch may be blocked by CORS, but try anyway (works for <img>, not for fetch).
          res = await fetch(src, { cache: 'force-cache', mode: 'cors' });
        }
        if (!res || !res.ok) {
          if (!cancelled) setUrl(src);
          return;
        }
        const blob = await res.blob();
        const dataUrl = await blobToDataURL(blob);
        if (cancelled) return;
        writeCachedAvatar(src, dataUrl);
        setUrl(dataUrl);
      } catch {
        if (!cancelled) setUrl(src);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Still fetching blob → show small circular progress in place of the avatar.
  if (!url) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full border"
        style={{
          width: '3rem',
          height: '3rem',
          background: 'color-mix(in srgb, var(--surface-1), transparent 20%)',
          borderColor: 'var(--border-subtle)',
          color: 'var(--text-muted)',
        }}
        aria-label="Loading avatar"
      >
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
      </span>
    );
  }

  return (
    <span className="relative inline-flex shrink-0" style={{ width: '3rem', height: '3rem' }}>
      {!loaded && (
        <span
          className="absolute inset-0 inline-flex items-center justify-center rounded-full border"
          style={{
            background: 'color-mix(in srgb, var(--surface-1), transparent 20%)',
            borderColor: 'var(--border-subtle)',
            color: 'var(--text-muted)',
          }}
          aria-hidden="true"
        >
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        </span>
      )}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={alt}
        aria-hidden={alt === '' ? true : undefined}
        className={`${className} ${!loaded ? 'opacity-0' : 'opacity-100'} transition-opacity`}
        decoding="async"
        fetchPriority="low"
        referrerPolicy="no-referrer"
        onLoad={() => setLoaded(true)}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none';
        }}
      />
    </span>
  );
}

export function SponsorsCarousel() {
  const [sponsors, setSponsors] = useState<Sponsor[]>(() => {
    const initial = Array.isArray(fallbackSponsors) ? (fallbackSponsors as Sponsor[]) : [];
    return initial;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [shouldMarquee, setShouldMarquee] = useState(false);

  // Live sponsors — not just per-build `sponsors.json`. The fallback JSON is only the initial paint
  // (offline-first); we immediately revalidate from Open Collective and keep it fresh while the
  // About tab is open. We aggregate both collectives:
  // - https://opencollective.com/openresinalliance
  // - https://opencollective.com/openresinalliance/projects/dragonfruit-slicer (slug `dragonfruit-slicer`)
  // No HTTP cache: `no-store` + focus/visibility + 5min poll. Sponsors are merged & deduped.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function fetchSponsors() {
      try {
        const settled = await Promise.all(
          OPENCOLLECTIVE_MEMBERS_URLS.map(async (url) => {
            try {
              const res = await fetch(url, {
                signal: controller.signal,
                cache: 'no-store',
                headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
              });
              if (!res.ok) return null;
              const data = (await res.json()) as unknown;
              if (!Array.isArray(data)) return null;
              return data.map(mapOCMemberToSponsor).filter((x): x is Sponsor => x !== null);
            } catch (err) {
              if (err instanceof DOMException && err.name === 'AbortError') throw err;
              return null;
            }
          }),
        );
        if (cancelled) return;
        const successful = settled.filter((x): x is Sponsor[] => x !== null);
        if (successful.length === 0) return; // all fetches failed → keep fallback
        const merged = successful.flat();
        // Always reflect live state (even if 0 → shows “No sponsors yet” CTA).
        // Sort like `scripts/sync-sponsors.mjs` so the live revalidate doesn't reshuffle Cunabula
        // (fallback is Siraya 200 > WickedGrey 100 > Cunabula 5; live merge without sort was Siraya, Cunabula, WickedGrey).
        const deduped = dedupeSponsors(merged);
        deduped.sort((a, b) => {
          const da = a.totalAmountDonated ?? 0;
          const db = b.totalAmountDonated ?? 0;
          if (db !== da) return db - da;
          return a.name.localeCompare(b.name);
        });
        setSponsors(deduped);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        // keep fallback silently on error
      }
    }

    fetchSponsors();
    const interval = window.setInterval(fetchSponsors, 5 * 60 * 1000);
    const onFocus = () => fetchSponsors();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchSponsors();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  const hasSponsors = sponsors.length > 0;

  // Only spin when the single sponsor row overflows the container.
  // With 2 sponsors (Siraya Tech, Cunabula) the pills fit easily, so we
  // show a static centered row; once sponsors grow beyond the line we
  // switch to the infinite marquee.
  useEffect(() => {
    if (!hasSponsors) {
      setShouldMarquee(false);
      return;
    }
    const container = containerRef.current;
    const track = trackRef.current;
    if (!container || !track) return;

    const update = () => {
      // When marquee is active the track is duplicated (2× width). Use half
      // as the single-row width; otherwise use the track's full width.
      const singleWidth = shouldMarquee ? track.scrollWidth / 2 : track.scrollWidth;
      setShouldMarquee(singleWidth > container.clientWidth);
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(container);
    ro.observe(track);
    window.addEventListener('resize', update);
    // Re-measure after fonts load (affects pill width)
    void document.fonts?.ready.then(update);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [sponsors, hasSponsors, shouldMarquee]);

  const openExternal = async (url: string) => {
    try {
      // Platform-specific module that does not exist in browser builds — must be dynamically imported.
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('open_external_url', { url });
    } catch {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div
      className="shrink-0 rounded-lg border px-3 py-2"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-1)' }}
      aria-label="Sponsors"
    >
      <div className="flex items-center justify-between gap-2">
        <h5 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          <Heart className="h-3 w-3" style={{ color: 'var(--accent-secondary)' }} aria-hidden="true" />
          Sponsors
          <span className="normal-case tracking-normal font-normal" style={{ color: 'var(--text-muted)', opacity: 0.85 }}>
            via Open Collective
          </span>
        </h5>
        <button
          type="button"
          onClick={() => openExternal(OPENCOLLECTIVE_URL)}
          className="inline-flex items-center gap-1 text-[10px] font-medium hover:underline"
          style={{ color: 'var(--accent)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
        >
          Sponsor Us
          <Heart className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      {!hasSponsors ? (
        <div className="mt-2 flex items-center gap-2 rounded-md border border-dashed px-3 py-2" style={{ borderColor: 'color-mix(in srgb, var(--accent-secondary), var(--border-subtle) 40%)', background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-0) 94%)' }}>
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ background: 'color-mix(in srgb, var(--accent-secondary), var(--surface-1) 85%)', color: 'var(--accent-secondary)' }}>
            <Heart className="h-3 w-3" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium leading-none" style={{ color: 'var(--text-strong)' }}>
              No sponsors yet — be the first!
            </p>
            <p className="text-[10px] leading-tight" style={{ color: 'var(--text-muted)' }}>
              Your name spins here when you back us.
            </p>
          </div>
          <button
            type="button"
            onClick={() => openExternal(OPENCOLLECTIVE_URL)}
            className="ui-button !h-7 shrink-0 !px-2.5 text-[11px] inline-flex items-center gap-1"
            style={{
              background: 'color-mix(in srgb, var(--accent), var(--surface-0) 12%)',
              borderColor: 'color-mix(in srgb, var(--accent), white 10%)',
              color: 'white',
            }}
          >
            <Heart className="h-3 w-3" aria-hidden="true" />
            Sponsor
          </button>
        </div>
      ) : shouldMarquee ? (
        <div ref={containerRef} className="relative mt-2 overflow-hidden rounded-md" style={{ background: 'color-mix(in srgb, var(--surface-0), transparent 20%)' }}>
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6"
            style={{ background: 'linear-gradient(90deg, var(--surface-1) 0%, transparent 100%)' }}
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6"
            style={{ background: 'linear-gradient(270deg, var(--surface-1) 0%, transparent 100%)' }}
          />
          <div
            ref={trackRef}
            className="sponsors-marquee-track sponsors-marquee-track--animated flex items-center gap-2 py-2 will-change-transform"
            aria-live="polite"
          >
            {[...sponsors, ...sponsors].map((s, idx) => {
              const isDuplicate = idx >= sponsors.length;
              const label = s.name;
              const href = s.profile ?? s.website ?? OPENCOLLECTIVE_URL;
              return (
                <button
                  key={`${s.name}-${idx}`}
                  type="button"
                  onClick={() => openExternal(href)}
                  className="inline-flex shrink-0 flex-col items-center gap-1 min-w-[56px] max-w-[80px] p-1 transition-opacity hover:opacity-80"
                  style={{ color: 'var(--text-strong)', background: 'none', border: 'none', cursor: 'pointer' }}
                  aria-label={`${label} — open sponsor profile`}
                  aria-hidden={isDuplicate ? true : undefined}
                  tabIndex={isDuplicate ? -1 : 0}
                >
                  {s.image ? (
                    <CachedAvatar
                      src={s.image}
                      alt=""
                      className="h-12 w-12 rounded-full object-cover shrink-0"
                    />
                  ) : (
                    <span
                      className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border"
                      style={{ background: 'color-mix(in srgb, var(--accent), var(--surface-1) 80%)', color: 'var(--accent)', borderColor: 'var(--border-subtle)' }}
                      aria-hidden="true"
                    >
                      <Heart className="h-6 w-6" />
                    </span>
                  )}
                  <span className="w-full truncate text-center text-[11px] font-medium leading-tight">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div ref={containerRef} className="mt-2 overflow-hidden rounded-md" style={{ background: 'color-mix(in srgb, var(--surface-0), transparent 20%)' }}>
          <div
            ref={trackRef}
            className="flex flex-wrap items-center justify-center gap-2 py-2"
            aria-live="polite"
          >
            {sponsors.map((s) => {
              const href = s.profile ?? s.website ?? OPENCOLLECTIVE_URL;
              return (
                <button
                  key={s.name}
                  type="button"
                  onClick={() => openExternal(href)}
                  className="inline-flex shrink-0 flex-col items-center gap-1 min-w-[56px] max-w-[80px] p-1 transition-opacity hover:opacity-80"
                  style={{ color: 'var(--text-strong)', background: 'none', border: 'none', cursor: 'pointer' }}
                  aria-label={`${s.name} — open sponsor profile`}
                >
                  {s.image ? (
                    <CachedAvatar
                      src={s.image}
                      alt=""
                      className="h-12 w-12 rounded-full object-cover shrink-0"
                    />
                  ) : (
                    <span
                      className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full border"
                      style={{ background: 'color-mix(in srgb, var(--accent), var(--surface-1) 80%)', color: 'var(--accent)', borderColor: 'var(--border-subtle)' }}
                      aria-hidden="true"
                    >
                      <Heart className="h-6 w-6" />
                    </span>
                  )}
                  <span className="w-full truncate text-center text-[11px] font-medium leading-tight">{s.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <style>{`
        .sponsors-marquee-track--animated {
          width: max-content;
          animation: sponsors-marquee 28s linear infinite;
        }
        .sponsors-marquee-track--animated:hover,
        .sponsors-marquee-track--animated:focus-within {
          animation-play-state: paused;
        }
        @keyframes sponsors-marquee {
          0% { transform: translateX(0); }
          100% { transform: translateX(-50%); }
        }
        @media (prefers-reduced-motion: reduce) {
          .sponsors-marquee-track--animated {
            animation: none;
            width: auto;
          }
        }
      `}</style>
    </div>
  );
}
