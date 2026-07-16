import type { NextConfig } from "next";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

const { version: packageVersion, buildChannel: packageBuildChannel } = JSON.parse(
  readFileSync(resolve(__dirname, "package.json"), "utf-8")
) as { version: string; buildChannel?: string };

const buildChannel = (packageBuildChannel ?? 'mainline').trim().toLowerCase();

// Git build fingerprint, baked in at build time so About can tell apart
// binaries that all report the same package version. Empty when git is
// unavailable (e.g. building from a source tarball).
const git = (command: string): string => {
  try {
    return execSync(command, { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
};
const gitCommit = git("git rev-parse --short=9 HEAD");
const gitDirty = gitCommit && git("git status --porcelain") !== "" ? "-dirty" : "";
// Exact tag wins over branch name; detached HEAD (CI checkouts) reports "HEAD",
// which is meaningless to users, so drop it.
const gitBranch = git("git rev-parse --abbrev-ref HEAD").replace(/^HEAD$/, "");
const gitRef = git("git describe --tags --exact-match") || gitBranch;

const nextConfig: NextConfig = {
  turbopack: {},
  experimental: {
    // LinguiJS macro transform via SWC — handles @lingui/core/macro imports at
    // compile time so the runtime receives plain message descriptors.
    swcPlugins: [["@lingui/swc-plugin", {}]],
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: packageVersion,
    NEXT_PUBLIC_BUILD_CHANNEL: buildChannel,
    NEXT_PUBLIC_GIT_COMMIT: gitCommit ? `${gitCommit}${gitDirty}` : "",
    NEXT_PUBLIC_GIT_REF: gitRef,
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
