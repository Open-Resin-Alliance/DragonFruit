---
description: Open-Source & High Performance Slicer for Resin 3D Printers
social:
  cards_layout: default/only/image
  cards_layout_options:
    background_image: docs/assets/branding/social-card-home.png
hide:
  - title
  - navigation
  - toc
  - search
---

<script>
  document.documentElement.setAttribute('data-md-color-scheme', 'slate');
  document.documentElement.style.colorScheme = 'dark';
  document.body?.classList.add('df-homepage-page');
</script>

<div class="df-homepage" markdown>

<div class="df-home-backdrop" aria-hidden="true">
  <img src="assets/branding/screenshot_app.png" alt="" />
</div>

<a class="df-home-meta-chip df-home-project-chip" href="https://github.com/Open-Resin-Alliance" aria-label="An Open Resin Alliance Project">
  An Open Resin Alliance Project
</a>

<a class="df-home-meta-chip df-home-license-badge" href="https://github.com/Open-Resin-Alliance/DragonFruit/blob/main/LICENSE" aria-label="Licensed under AGPL-3.0-or-later">
  AGPL-3.0-or-later
</a>

<img class="df-home-wordmark" src="assets/branding/text_logo.svg" alt="DragonFruit" />

<p class="df-home-tagline">Open-Source & High Performance Slicer for Resin 3D Printers</p>

<div class="df-home-actions">
  <div class="df-download-split">
    <a class="md-button md-button--primary" id="download-now" href="https://github.com/Open-Resin-Alliance/DragonFruit/releases/latest">Download Beta</a><button class="df-download-split-toggle" id="download-dropdown-toggle" aria-label="More download options" aria-expanded="false" aria-haspopup="true"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z"/></svg></button>
    <div class="df-download-dropdown" id="download-dropdown" hidden>
      <a class="df-download-dropdown-item" id="download-nightly" href="https://github.com/Open-Resin-Alliance/DragonFruit/releases">
        <span class="df-download-dropdown-label">Download Nightly</span>
        <span class="df-download-dropdown-sub" id="download-nightly-version">Fetching…</span>
      </a>
      <button class="df-download-dropdown-item df-show-all-nightlies" id="show-all-nightlies">
        <span class="df-download-dropdown-label">Show other versions…</span>
      </button>
    </div>
  </div>
  <a class="md-button" href="./getting-started/installation/">View Docs</a>
</div>

<p class="df-home-release-version" id="latest-release-version">Fetching the latest release from GitHub…</p>

<p><a href="https://discord.com/invite/beFeTaPH6v">Join our Discord</a></p>

</div>

<div class="df-modal-overlay" id="nightly-modal-overlay" hidden>
  <div class="df-modal" role="dialog" aria-modal="true" aria-labelledby="nightly-modal-title">
    <div class="df-modal-header">
      <h2 id="nightly-modal-title">Nightly Builds</h2>
      <button class="df-modal-close" id="nightly-modal-close" aria-label="Close">&times;</button>
    </div>
    <div class="df-modal-body" id="nightly-modal-body">
      <p class="df-modal-loading">Loading…</p>
    </div>
  </div>
</div>
