import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  allowedDevOrigins: ['127.0.0.1', '::1'],
  devIndicators: {
    position: 'top-right',
  },
};

export default nextConfig;
