import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { resolve } from "path";

const { version: packageVersion, buildChannel: packageBuildChannel } = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8")
) as { version: string; buildChannel?: string };

const buildChannel = (packageBuildChannel ?? 'mainline').trim().toLowerCase();

const nextConfig: NextConfig = {
  // Turbopack (Next.js 16 default) handles `new URL("*.wasm", import.meta.url)`
  // natively — no extra config required. The empty object here acknowledges we
  // are intentionally using Turbopack without a custom webpack config.
  turbopack: {},
  experimental: {
    // LinguiJS macro transform via SWC — handles @lingui/core/macro imports at
    // compile time so the runtime receives plain message descriptors.
    swcPlugins: [["@lingui/swc-plugin", {}]],
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: packageVersion,
    NEXT_PUBLIC_BUILD_CHANNEL: buildChannel,
  },
  reactCompiler: true,
  allowedDevOrigins: ['127.0.0.1', '::1'],
  devIndicators: {
    position: 'top-right',
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
        ],
      },
    ];
  },
};

export default nextConfig;
