import type { NextConfig } from 'next';
import { networkInterfaces } from 'node:os';

const localAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((entry) => entry?.family === 'IPv4')
  .map((entry) => entry!.address);

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  allowedDevOrigins: localAddresses,
  distDir: process.env.NEXT_DIST_DIR || '.next',
  outputFileTracingRoot: process.cwd(),
  serverExternalPackages: ['bun:sqlite'],
  webpack(config) {
    config.externals.push({ 'bun:sqlite': 'commonjs bun:sqlite' });
    return config;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};
export default config;
