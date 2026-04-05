import type { NextConfig } from "next";
import { readFileSync } from "fs";
import { resolve } from "path";

const { version: packageVersion, buildChannel: packageBuildChannel } = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8")
) as { version: string; buildChannel?: string };

const buildChannel = (packageBuildChannel ?? 'mainline').trim().toLowerCase();

const nextConfig: NextConfig = {
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
