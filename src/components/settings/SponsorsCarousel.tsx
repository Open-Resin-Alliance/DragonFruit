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

// Donation-rank ring colors — Siraya Tech ($200) → gold, next tiers silver/bronze.
// Thresholds are totalAmountDonated from Open Collective (lifetime total, not monthly).
// Adjust thresholds if sponsor amounts shift; gold >=100 (Siraya 200, WickedGrey 100), silver >=30, bronze >=10.
export function getSponsorRank(total?: number | null): { tier: string; borderColor: string; gradient?: string; glow: string } {
  if (total == null) return { tier: 'supporter', borderColor: 'var(--border-subtle)', glow: 'none' };
  if (total >= 100) return {
    tier: 'gold',
    borderColor: '#D4AF37',
    gradient: 'conic-gradient(from 0deg at 50% 50%, #BF953F 0deg, #FCF6BA 45deg, #B38728 90deg, #FBF5B7 135deg, #AA771C 180deg, #BF953F 225deg, #FCF6BA 270deg, #B38728 315deg, #BF953F 360deg)',
    glow: '0 0 6px rgba(212, 175, 55, 0.35), 0 0 12px rgba(212, 175, 55, 0.18), inset 0 1px 1px rgba(255,255,255,0.5)',
  };
  if (total >= 30) return {
    tier: 'silver',
    borderColor: '#C0C0C0',
    gradient: 'conic-gradient(from 0deg at 50% 50%, #71706E 0deg, #E8E8E8 45deg, #A8A8A8 90deg, #F5F5F5 135deg, #9B9B9B 180deg, #71706E 225deg, #E8E8E8 270deg, #A8A8A8 315deg, #71706E 360deg)',
    glow: '0 0 6px rgba(192, 192, 192, 0.3), inset 0 1px 1px rgba(255,255,255,0.4)',
  };
  if (total >= 10) return {
    tier: 'bronze',
    borderColor: '#CD7F32',
    gradient: 'conic-gradient(from 0deg at 50% 50%, #6B3A1F 0deg, #CD7F32 45deg, #E9BB83 90deg, #8C4A2A 135deg, #5C3317 180deg, #6B3A1F 225deg, #CD7F32 270deg, #E9BB83 315deg, #6B3A1F 360deg)',
    glow: '0 0 6px rgba(205, 127, 50, 0.25), inset 0 1px 1px rgba(255,255,255,0.3)',
  };
  return { tier: 'supporter', borderColor: 'var(--border-subtle)', glow: 'none' };
}

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
// Sponsors list cache — so we don't flash baked-in fallback on every cold open.
// Avatars are already cached per-image; this caches the *list* (names, amounts, tiers).
const SPONSORS_CACHE_KEY = 'dragonfruit:sponsors-cache-v1';
const SPONSORS_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6h — stale cache still better than baked-in

function readCachedSponsors(): Sponsor[] | null {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(SPONSORS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sponsors?: unknown; fetchedAt?: unknown };
    if (!parsed || !Array.isArray(parsed.sponsors)) return null;
    // Keep stale cache usable; just avoid showing baked-in until fetch proves otherwise.
    return parsed.sponsors as Sponsor[];
  } catch {
    return null;
  }
}
function writeCachedSponsors(sponsors: Sponsor[]) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SPONSORS_CACHE_KEY, JSON.stringify({ sponsors, fetchedAt: Date.now() }));
  } catch {
    // ignore quota
  }
}
function blobToDataURL(blob: Blob): Promise<string> {

  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const reader = new FileReader();
  reader.onloadend = () => resolve(reader.result as string);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
  return promise;
}

function toHighResUrl(src: string, profile?: string | null): string {
  if (!src) return src;
  // For S3 direct URLs (e.g. GGGAvatar3.png 250px), the S3 host ignores ?height, so keep S3 but try to get high-res via OC proxy only as fallback
  // We prefer S3 with height param (no-op but still returns image) over proxy which may 404 for some slugs; proxy is used only for images.opencollective.com hosts
  try {
    const u = new URL(src);
    if (u.host.includes('images.opencollective.com')) {
      if (!u.searchParams.has('height') && !u.searchParams.has('width')) {
        u.searchParams.set('height', '512');
        u.searchParams.set('width', '512');
      }
      return u.toString();
    }
    if (u.host.includes('githubusercontent')) {
      if (!u.searchParams.has('s')) u.searchParams.set('s', '512');
      return u.toString();
    }
    if (u.host.includes('s3')) {
      // S3 direct - add height (ignored but harmless) and keep original; don't use proxy which 404s for some
      if (!u.searchParams.has('height')) {
        u.searchParams.set('height', '512');
        u.searchParams.set('width', '512');
      }
      return u.toString();
    }
  } catch {}
  return src;
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

function CachedAvatar({ src, profile, alt, className, totalAmountDonated }: { src: string; profile?: string | null; alt: string; className: string; totalAmountDonated?: number | null }) {
  const highResSrc = toHighResUrl(src, profile);
  const [url, setUrl] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const rank = getSponsorRank(totalAmountDonated);
  const isGold = rank.tier === 'gold';
  // Hydrate from persistent cache before paint — avoids flash of spinner when already cached.
  // useLayoutEffect runs before browser paint, so a cached data URL appears instantly with no spinner.
  useLayoutEffect(() => {
    if (!highResSrc) return;
    const cached = readCachedAvatar(highResSrc);
    if (cached) {
      setUrl(cached);
      setLoaded(true);
    }
  }, [src]);

  useEffect(() => {
    if (!highResSrc) return;
    if (readCachedAvatar(highResSrc)) return; // already cached, no fetch needed

    let cancelled = false;
    const load = async () => {
      try {
        // Tauri production: Next.js proxy not available, S3 CORS blocks fetch().
        // Use Rust (reqwest) to bypass WebView CORS and return a data URL.
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const dataUrl = await invoke<string>('fetch_sponsor_avatar', { url: highResSrc });
          if (!cancelled && dataUrl && typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
            writeCachedAvatar(highResSrc, dataUrl);
            setUrl(dataUrl);
            return;
          }
        } catch {
          // Not in Tauri (web) or host not allowed — fall through to HTTP proxy.
        }
        // Use same-origin proxy to bypass S3 CORS (No 'Access-Control-Allow-Origin').
        // In Tauri production the proxy won't exist, so we fallback to direct fetch.
        const proxyUrl = `/api/sponsor-avatar?url=${encodeURIComponent(highResSrc)}`;
        let res: Response | null = null;
        try {
          res = await fetch(proxyUrl, { cache: 'force-cache' });
          if (!res.ok) throw new Error(`proxy ${res.status}`);
        } catch {
          // Fallback: direct S3 fetch may be blocked by CORS, but try anyway (works for <img>, not for fetch).
          try {
            res = await fetch(highResSrc, { cache: 'force-cache', mode: 'cors' });
            if (!res || !res.ok) throw new Error(`highRes ${res?.status}`);
          } catch {
            // High-res proxy/S3 height param failed (e.g. 404 for gggames proxy), fallback to original src without height param
            try {
              res = await fetch(src, { cache: 'force-cache', mode: 'cors' });
            } catch {
              res = null;
            }
          }
        }
        if (!res || !res.ok) {
          if (!cancelled) setUrl(highResSrc);
          return;
        }
        const blob = await res.blob();
        const dataUrl = await blobToDataURL(blob);
        if (cancelled) return;
        writeCachedAvatar(highResSrc, dataUrl);
        setUrl(dataUrl);
      } catch {
        if (!cancelled) setUrl(highResSrc);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [src]);

  // Still fetching blob → show small circular progress in place of the avatar.
  if (!url) {
    const hasRing = !!rank.gradient;
    const ringPad = '3px';
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full"
        style={{
          width: '3rem',
          boxSizing: 'content-box',
          height: '3rem',
          padding: hasRing ? ringPad : undefined,
          background: hasRing ? rank.gradient : undefined,
          boxShadow: hasRing && rank.glow !== 'none' ? rank.glow : undefined,
          borderRadius: '9999px',
        }}
        aria-label="Loading avatar"
      >
        <span
          className="inline-flex h-full w-full items-center justify-center rounded-full border"
          style={{
            background: 'color-mix(in srgb, var(--surface-1), transparent 20%)',
            borderColor: hasRing ? 'transparent' : 'var(--border-subtle)',
            color: 'var(--text-muted)',
          }}
        >
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
        </span>
      </span>
    );
  }

  return (
    <span
      className="relative inline-flex shrink-0"
      style={{
        width: '3rem',
          boxSizing: 'content-box',
        height: '3rem',
        borderRadius: '9999px',
        padding: rank.gradient ? '3px' : undefined,
        background: rank.gradient ?? undefined,
        boxShadow: rank.glow !== 'none' ? rank.glow : undefined,
      }}
    >
      <span className="relative inline-flex h-full w-full overflow-hidden rounded-full" style={{ background: 'var(--surface-1)', transform: 'translateZ(0)', isolation: 'isolate' } as React.CSSProperties}>
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
        <div
          className={`${className} ${!loaded ? 'opacity-0' : 'opacity-100'} transition-opacity`}
          style={{
            width: '512px',
            height: '512px',
            backgroundImage: `url("${url}")`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
            display: 'block',
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%) scale(0.09375)',
            transformOrigin: 'center',
            willChange: 'transform',
          }}
          aria-hidden={alt === '' ? true : undefined}
        />
        <img
          src={url}
          alt={alt}
          aria-hidden
          style={{ display: 'none' }}
          onLoad={() => setLoaded(true)}
          onError={() => setLoaded(true)}
        />
      </span>
    </span>
  );
}

export function SponsorsCarousel() {
  const [sponsors, setSponsors] = useState<Sponsor[] | null>(() => {
    const cached = readCachedSponsors();
    if (cached && cached.length >= 0) return cached;
    return null;
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [shouldMarquee, setShouldMarquee] = useState(false);

  // Live sponsors — cached, not just baked-in fallback. Initial paint is cached
  // sponsors if available (instant, no flash), otherwise null → loading spinner
  // until fetch completes. Only after fetch fails with no cache do we fall back
  // to the baked-in `sponsors.json`.
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function fetchSponsors() {
      try {
        const settled = await Promise.all(
          OPENCOLLECTIVE_MEMBERS_URLS.map(async (url) => {
            try {
              // Tauri production: WebView fetch to opencollective.com is blocked by CORS (no ACAO for tauri://localhost).
              // Try Rust (reqwest) first when in Tauri; falls through to fetch on web or on error.
              try {
                const { invoke } = await import('@tauri-apps/api/core');
                const text = await invoke<string>('fetch_external_text', { url });
                const data = JSON.parse(text) as unknown;
                if (!Array.isArray(data)) return null;
                return data.map(mapOCMemberToSponsor).filter((x): x is Sponsor => x !== null);
              } catch {
                // Not in Tauri (web) or host not allowed — fall through to HTTP fetch
              }
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
        if (successful.length === 0) {
          if (!cancelled) {
            setSponsors((prev) => {
              if (prev !== null) return prev;
              const fallback = Array.isArray(fallbackSponsors) ? (fallbackSponsors as Sponsor[]) : [];
              return fallback;
            });
          }
          return;
        }
        const merged = successful.flat();
        const deduped = dedupeSponsors(merged);
        deduped.sort((a, b) => {
          const da = a.totalAmountDonated ?? 0;
          const db = b.totalAmountDonated ?? 0;
          if (db !== da) return db - da;
          return a.name.localeCompare(b.name);
        });
        if (!cancelled) {
          setSponsors(deduped);
          writeCachedSponsors(deduped);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        if (!cancelled) {
          setSponsors((prev) => {
            if (prev !== null) return prev;
            const fallback = Array.isArray(fallbackSponsors) ? (fallbackSponsors as Sponsor[]) : [];
            return fallback;
          });
        }
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

  const hasSponsors = Array.isArray(sponsors) && sponsors.length > 0;
  const isLoadingSponsors = sponsors === null;

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

      {isLoadingSponsors ? (
        <div className="mt-2 flex items-center justify-center gap-2 rounded-md border px-3 py-6" style={{ borderColor: 'var(--border-subtle)', background: 'color-mix(in srgb, var(--surface-1), transparent 20%)', color: 'var(--text-muted)' }}>
          <span className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
          <span className="text-[11px]">Loading sponsors…</span>
        </div>
      ) : !hasSponsors ? (
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
                      profile={s.profile}
                      alt=""
                      className="h-12 w-12 rounded-full object-cover shrink-0"
                      totalAmountDonated={s.totalAmountDonated}
                    />
                  ) : (
                    <span
                      className="inline-flex shrink-0 items-center justify-center rounded-full"
                      style={{
                        width: '3rem',
          boxSizing: 'content-box',
                        height: '3rem',
                        padding: getSponsorRank(s.totalAmountDonated).gradient ? '3px' : undefined,
                        background: getSponsorRank(s.totalAmountDonated).gradient ?? undefined,
                        boxShadow: getSponsorRank(s.totalAmountDonated).glow !== 'none' ? getSponsorRank(s.totalAmountDonated).glow : undefined,
                        borderRadius: '9999px',
                      }}
                      aria-hidden="true"
                    >
                      <span
                        className="inline-flex h-full w-full items-center justify-center rounded-full border"
                        style={{
                          background: 'var(--surface-1)',
                          color: getSponsorRank(s.totalAmountDonated).gradient ? getSponsorRank(s.totalAmountDonated).borderColor : 'var(--accent)',
                          borderColor: 'transparent',
                        }}
                      >
                        <Heart className="h-6 w-6" />
                      </span>
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
                      profile={s.profile}
                      alt=""
                      className="h-12 w-12 rounded-full object-cover shrink-0"
                      totalAmountDonated={s.totalAmountDonated}
                    />
                  ) : (
                    <span
                      className="inline-flex shrink-0 items-center justify-center rounded-full"
                      style={{
                        width: '3rem',
          boxSizing: 'content-box',
                        height: '3rem',
                        padding: getSponsorRank(s.totalAmountDonated).gradient ? '3px' : undefined,
                        background: getSponsorRank(s.totalAmountDonated).gradient ?? undefined,
                        boxShadow: getSponsorRank(s.totalAmountDonated).glow !== 'none' ? getSponsorRank(s.totalAmountDonated).glow : undefined,
                        borderRadius: '9999px',
                      }}
                      aria-hidden="true"
                    >
                      <span
                        className="inline-flex h-full w-full items-center justify-center rounded-full border"
                        style={{
                          background: 'var(--surface-1)',
                          color: getSponsorRank(s.totalAmountDonated).gradient ? getSponsorRank(s.totalAmountDonated).borderColor : 'var(--accent)',
                          borderColor: 'transparent',
                        }}
                      >
                        <Heart className="h-6 w-6" />
                      </span>
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
