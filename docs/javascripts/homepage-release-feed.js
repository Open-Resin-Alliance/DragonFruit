(function () {
      const OWNER = 'Open-Resin-Alliance';
      const REPO = 'DragonFruit';
      const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;
      const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;
      const RELEASES_API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=12`;
      const LATEST_API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

      const PLATFORM_DEFS = {
            windows: {
                  label: 'Windows',
                  patterns: [/\.exe$/i, /\.msi$/i],
            },
            macos: {
                  label: 'macOS',
                  patterns: [/\.dmg$/i, /\.pkg$/i],
            },
            linux: {
                  label: 'Linux',
                  patterns: [/\.flatpak$/i, /\.AppImage$/i, /\.deb$/i, /\.rpm$/i, /\.tar\.gz$/i],
            },
      };

      function detectPlatform() {
            const source = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
            if (source.includes('win')) return 'windows';
            if (source.includes('mac') || source.includes('darwin')) return 'macos';
            if (source.includes('linux') || source.includes('x11')) return 'linux';
            return null;
      }

      function fetchJson(url) {
            return fetch(url, {
                  headers: {
                        Accept: 'application/vnd.github+json',
                  },
            }).then((response) => {
                  if (!response.ok) {
                        throw new Error(`Request failed with ${response.status}`);
                  }
                  return response.json();
            });
      }

      function formatDate(dateString) {
            if (!dateString) return 'Date unavailable';
            try {
                  return new Intl.DateTimeFormat(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                  }).format(new Date(dateString));
            } catch {
                  return dateString;
            }
      }

      function cleanReleaseName(release) {
            return release?.name?.trim() || release?.tag_name || 'Latest release';
      }

      function summarizeReleaseBody(body) {
            if (!body) return 'Release notes available on GitHub.';

            const firstUsefulLine = body
                  .replace(/\r/g, '')
                  .split('\n')
                  .map((line) => line.trim())
                  .find((line) => line && !line.startsWith('#') && !line.startsWith('- ') && !line.startsWith('* '));

            if (!firstUsefulLine) return 'Release notes available on GitHub.';
            if (firstUsefulLine.length <= 160) return firstUsefulLine;
            return `${firstUsefulLine.slice(0, 157).trimEnd()}…`;
      }

      function pickBestAsset(assets, platformKey) {
            const platform = PLATFORM_DEFS[platformKey];
            if (!platform) return null;

            const ranked = assets
                  .map((asset) => {
                        const index = platform.patterns.findIndex((pattern) => pattern.test(asset.name || ''));
                        if (index === -1) return null;
                        return {
                              asset,
                              score: platform.patterns.length - index,
                        };
                  })
                  .filter(Boolean)
                  .sort((a, b) => {
                        if (b.score !== a.score) return b.score - a.score;
                        return (b.asset.download_count || 0) - (a.asset.download_count || 0);
                  });

            return ranked[0]?.asset || null;
      }

      function getReleaseAssets(release) {
            const assets = release?.assets || [];
            return Object.keys(PLATFORM_DEFS).map((platformKey) => {
                  const asset = pickBestAsset(assets, platformKey);
                  return asset
                        ? {
                              key: platformKey,
                              label: PLATFORM_DEFS[platformKey].label,
                              name: asset.name,
                              url: asset.browser_download_url,
                        }
                        : null;
            }).filter(Boolean);
      }

      function setText(node, value) {
            if (node) node.textContent = value;
      }

      function setHomepageHeaderTitle() {
            if (!document.body.classList.contains('df-homepage-page')) return;

            const titleNodes = document.querySelectorAll('.md-header__title .md-ellipsis, .md-header__topic .md-ellipsis');
            titleNodes.forEach((node) => {
                  if (node.textContent && node.textContent.trim() === 'DragonFruit') {
                        node.textContent = 'Home';
                  }
            });
      }

      function renderDownloads(container, release, variant) {
            if (!container) return;

            const assets = getReleaseAssets(release);
            const preferredPlatform = detectPlatform();

            if (!assets.length) {
                  container.innerHTML = `<a class="md-button ${variant === 'stable' ? 'md-button--primary' : ''}" href="${release.html_url || RELEASES_URL}">Open release page</a>`;
                  return;
            }

            const orderedAssets = assets.slice().sort((a, b) => {
                  if (a.key === preferredPlatform) return -1;
                  if (b.key === preferredPlatform) return 1;
                  return 0;
            });

            container.innerHTML = orderedAssets
                  .map((asset, index) => {
                        const classes = ['md-button'];
                        if ((index === 0 && variant === 'stable') || asset.key === preferredPlatform) {
                              classes.push('md-button--primary');
                        }
                        return `<a class="${classes.join(' ')}" href="${asset.url}">${asset.label}</a>`;
                  })
                  .join('');
      }

      function hydrateHeroDownload(stableRelease) {
            const heroButton = document.querySelector('#download-now');
            const versionLine = document.querySelector('#latest-release-version');
            if (!heroButton || !versionLine) return;

            if (!stableRelease) {
                  heroButton.href = LATEST_RELEASE_URL;
                  versionLine.textContent = 'Latest release unavailable right now.';
                  return;
            }

            const versionLabel = cleanReleaseName(stableRelease);
            const versionTag = stableRelease.tag_name || versionLabel;

            const preferredPlatform = detectPlatform();
            const preferredAsset = preferredPlatform ? pickBestAsset(stableRelease.assets || [], preferredPlatform) : null;

            if (preferredAsset) {
                  heroButton.href = preferredAsset.browser_download_url;
                  heroButton.textContent = `Download Beta for ${PLATFORM_DEFS[preferredPlatform].label}`;
            } else {
                  heroButton.href = stableRelease.html_url || LATEST_RELEASE_URL;
                  heroButton.textContent = 'Download Beta';
            }

            versionLine.textContent = `${versionTag} · Published ${formatDate(stableRelease.published_at)}`;
      }

      function initReleaseFeed() {
            if (document.querySelector('.df-homepage')) {
                  document.body.classList.add('df-homepage-page');
                  document.documentElement.setAttribute('data-md-color-scheme', 'slate');
            }

            setHomepageHeaderTitle();

            const heroButton = document.querySelector('#download-now');
            const versionLine = document.querySelector('#latest-release-version');

            if (!heroButton || !versionLine) return;

            fetchJson(LATEST_API_URL)
                  .then((stableRelease) => {
                        hydrateHeroDownload(stableRelease);
                  })
                  .catch(() => {
                        heroButton.href = LATEST_RELEASE_URL;
                        heroButton.textContent = 'Download Beta';
                        versionLine.textContent = 'Latest release unavailable right now.';
                  });
      }

      if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initReleaseFeed, { once: true });
      } else {
            initReleaseFeed();
      }
})();
