(function () {
      const OWNER = 'Open-Resin-Alliance';
      const REPO = 'DragonFruit';
      const REPO_URL = `https://github.com/${OWNER}/${REPO}`;
      const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;
      const LATEST_RELEASE_URL = `${RELEASES_URL}/latest`;
      const RELEASES_API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=30`;
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

      function detectArchitecture(assetName) {
            const source = `${assetName || ''} ${navigator.userAgentData?.architecture || ''}`.toLowerCase();

            if (source.includes('aarch64')) return 'aarch64';
            if (source.includes('arm64')) return 'arm64';
            if (source.includes('x86_64') || source.includes('amd64') || source.includes('x64')) return 'x64';

            if (source.includes('arm')) return 'aarch64';
            if (source.includes('64')) return 'x64';

            return null;
      }

      function isMobileDevice() {
            if (navigator.userAgentData?.mobile) return true;

            const source = `${navigator.userAgentData?.platform || ''} ${navigator.platform || ''} ${navigator.userAgent || ''}`.toLowerCase();
            if (source.includes('android') || source.includes('iphone') || source.includes('ipad') || source.includes('ipod')) {
                  return true;
            }

            if (source.includes('mobile')) return true;

            if (source.includes('mac') && navigator.maxTouchPoints > 1) {
                  return true;
            }

            return false;
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
                  node.textContent = 'Home';
            });
      }

      function syncHomepageHeaderHeight() {
            if (!document.body.classList.contains('df-homepage-page')) return;

            const header = document.querySelector('.md-header');
            if (!header) return;

            const height = Math.round(header.getBoundingClientRect().height);
            document.documentElement.style.setProperty('--df-home-header-height', `${height}px`);
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

      function isRecentNightly(release) {
            if (!release?.prerelease || !release?.tag_name) return false;
            if (!release.tag_name.startsWith('nightly_') && !release.tag_name.startsWith('dev_')) return false;
            if (!release.published_at) return false;
            const ageMs = Date.now() - new Date(release.published_at).getTime();
            const cutoff = 14 * 24 * 60 * 60 * 1000;
            return ageMs < cutoff;
      }

      function collectRecentNightlies(releases) {
            return (releases || []).filter(isRecentNightly).slice(0, 20);
      }

      function buildNightlyRow(release) {
            const name = release.name || release.tag_name || 'Nightly';
            const tag = release.tag_name;
            const date = formatDate(release.published_at);
            const assets = release.assets || [];

            const assetLinks = Object.keys(PLATFORM_DEFS).map((key) => {
                  const asset = pickBestAsset(assets, key);
                  if (!asset) return null;
                  const platform = PLATFORM_DEFS[key];
                  return `<a class="df-modal-asset-link" href="${asset.browser_download_url}" title="Download for ${platform.label}">${platform.label}</a>`;
            }).filter(Boolean).join('');

            const releaseUrl = release.html_url || `${RELEASES_URL}/tag/${tag}`;

            return `<div class="df-modal-nightly-row" data-tag="${tag}">
                  <div class="df-modal-nightly-info">
                        <a class="df-modal-nightly-name" href="${releaseUrl}" target="_blank" rel="noopener">${name}</a>
                        <span class="df-modal-nightly-meta">${tag} · ${date}</span>
                  </div>
                  <div class="df-modal-nightly-assets">${assetLinks || '<span class="df-modal-no-assets">No assets</span>'}</div>
            </div>`;
      }

      function openNightlyModal(nightlies) {
            const overlay = document.querySelector('#nightly-modal-overlay');
            const body = document.querySelector('#nightly-modal-body');
            if (!overlay || !body) return;

            body.innerHTML = nightlies.length
                  ? nightlies.map(buildNightlyRow).join('')
                  : '<p class="df-modal-empty">No recent nightly builds available.</p>';

            overlay.hidden = false;
            document.body.classList.add('df-modal-open');
      }

      function closeNightlyModal() {
            const overlay = document.querySelector('#nightly-modal-overlay');
            if (!overlay) return;
            overlay.hidden = true;
            document.body.classList.remove('df-modal-open');
      }

      function initNightlyModal() {
            const showAllBtn = document.querySelector('#show-all-nightlies');
            const overlay = document.querySelector('#nightly-modal-overlay');
            const closeBtn = document.querySelector('#nightly-modal-close');
            if (!showAllBtn || !overlay || !closeBtn) return;

            showAllBtn.addEventListener('click', () => {
                  // Fetch the full list again so the modal is always fresh
                  fetchJson(RELEASES_API_URL)
                        .then((releases) => {
                              const nightlies = collectRecentNightlies(releases);
                              openNightlyModal(nightlies);
                        })
                        .catch(() => {
                              const body = document.querySelector('#nightly-modal-body');
                              if (body) body.innerHTML = '<p class="df-modal-empty">Failed to load nightlies.</p>';
                              overlay.hidden = false;
                              document.body.classList.add('df-modal-open');
                        });
            });

            closeBtn.addEventListener('click', closeNightlyModal);

            overlay.addEventListener('click', (e) => {
                  if (e.target === overlay) closeNightlyModal();
            });

            document.addEventListener('keydown', (e) => {
                  if (e.key === 'Escape' && !overlay.hidden) closeNightlyModal();
            });
      }

      function hydrateNightlyDownload(nightlyRelease) {
            const nightlyLink = document.querySelector('#download-nightly');
            const nightlyVersion = document.querySelector('#download-nightly-version');
            if (!nightlyLink) return;

            if (!nightlyRelease) {
                  if (nightlyVersion) nightlyVersion.textContent = 'No nightly available.';
                  return;
            }

            const versionTag = nightlyRelease.name || nightlyRelease.tag_name || 'Nightly';
            const preferredPlatform = detectPlatform();
            const preferredAsset = preferredPlatform ? pickBestAsset(nightlyRelease.assets || [], preferredPlatform) : null;

            nightlyLink.href = preferredAsset
                  ? preferredAsset.browser_download_url
                  : nightlyRelease.html_url || RELEASES_URL;

            if (nightlyVersion) {
                  const platformLabel = preferredPlatform ? PLATFORM_DEFS[preferredPlatform].label : null;
                  const architecture = detectArchitecture(preferredAsset?.name);
                  const platformContext = [platformLabel, architecture].filter(Boolean).join(' ');
                  const prefix = platformContext ? `${platformContext} · ` : '';
                  nightlyVersion.textContent = `${prefix}${versionTag} · ${formatDate(nightlyRelease.published_at)}`;
            }
      }

      function initDropdownToggle() {
            const toggle = document.querySelector('#download-dropdown-toggle');
            const dropdown = document.querySelector('#download-dropdown');
            if (!toggle || !dropdown) return;

            toggle.addEventListener('click', (e) => {
                  e.stopPropagation();
                  const isOpen = toggle.getAttribute('aria-expanded') === 'true';
                  toggle.setAttribute('aria-expanded', String(!isOpen));
                  dropdown.hidden = isOpen;
            });

            document.addEventListener('click', () => {
                  toggle.setAttribute('aria-expanded', 'false');
                  dropdown.hidden = true;
            });

            document.addEventListener('keydown', (e) => {
                  if (e.key === 'Escape') {
                        toggle.setAttribute('aria-expanded', 'false');
                        dropdown.hidden = true;
                  }
            });
      }

      function hydrateHeroDownload(stableRelease) {
            const heroButton = document.querySelector('#download-now');
            const versionLine = document.querySelector('#latest-release-version');
            if (!heroButton || !versionLine) return;

            if (isMobileDevice()) {
                  heroButton.href = REPO_URL;
                  heroButton.textContent = 'Open GitHub';
                  heroButton.classList.remove('md-button--primary');
                  heroButton.classList.add('df-home-download--mobile');
                  versionLine.textContent = 'Available on desktop.';
                  const toggle = document.querySelector('#download-dropdown-toggle');
                  if (toggle) toggle.hidden = true;
                  return;
            }

            heroButton.classList.remove('df-home-download--mobile');

            if (!stableRelease) {
                  heroButton.href = LATEST_RELEASE_URL;
                  versionLine.textContent = 'Latest release unavailable right now.';
                  return;
            }

            const versionLabel = cleanReleaseName(stableRelease);
            const versionTag = stableRelease.tag_name || versionLabel;

            const preferredPlatform = detectPlatform();
            const preferredAsset = preferredPlatform ? pickBestAsset(stableRelease.assets || [], preferredPlatform) : null;
            const architecture = detectArchitecture(preferredAsset?.name);

            if (preferredAsset) {
                  heroButton.href = preferredAsset.browser_download_url;
                  heroButton.textContent = 'Download Beta';
            } else {
                  heroButton.href = stableRelease.html_url || LATEST_RELEASE_URL;
                  heroButton.textContent = 'Download Beta';
            }

            const platformLabel = preferredPlatform ? PLATFORM_DEFS[preferredPlatform].label : null;
            const platformContext = [platformLabel, architecture].filter(Boolean).join(' ');
            const prefix = platformContext ? `${platformContext} ` : '';

            versionLine.textContent = `${prefix}${versionTag} · Published ${formatDate(stableRelease.published_at)}`;
      }

      function initReleaseFeed() {
            const isHomepage = Boolean(document.querySelector('.df-homepage'));

            document.body.classList.toggle('df-homepage-page', isHomepage);

            if (isHomepage) {
                  document.documentElement.setAttribute('data-md-color-scheme', 'slate');
                  document.documentElement.style.colorScheme = 'dark';
            } else {
                  document.documentElement.style.removeProperty('--df-home-header-height');
                  document.documentElement.style.colorScheme = '';
                  return;
            }

            setHomepageHeaderTitle();
            syncHomepageHeaderHeight();

            const header = document.querySelector('.md-header');
            if (header && 'ResizeObserver' in window) {
                  const observer = new ResizeObserver(() => {
                        syncHomepageHeaderHeight();
                  });
                  observer.observe(header);
                  window.addEventListener('resize', syncHomepageHeaderHeight, { passive: true });
            }

            const heroButton = document.querySelector('#download-now');
            const versionLine = document.querySelector('#latest-release-version');

            if (!heroButton || !versionLine) return;

            initDropdownToggle();
            initNightlyModal();

            fetchJson(LATEST_API_URL)
                  .then((stableRelease) => {
                        hydrateHeroDownload(stableRelease);
                  })
                  .catch(() => {
                        heroButton.href = LATEST_RELEASE_URL;
                        heroButton.textContent = 'Download Beta';
                        versionLine.textContent = 'Latest release unavailable right now.';
                  });

            fetchJson(RELEASES_API_URL)
                  .then((releases) => {
                        const nightlies = collectRecentNightlies(releases);
                        const latestNightly = nightlies[0] || null;
                        hydrateNightlyDownload(latestNightly);
                  })
                  .catch(() => {
                        const nightlyVersion = document.querySelector('#download-nightly-version');
                        if (nightlyVersion) nightlyVersion.textContent = 'Unavailable right now.';
                  });
      }

      if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initReleaseFeed, { once: true });
      } else {
            initReleaseFeed();
      }
})();
