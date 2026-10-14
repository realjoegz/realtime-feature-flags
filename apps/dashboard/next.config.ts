import { resolve } from 'node:path';
import type { NextConfig } from 'next';

// The repository root: npm installs every workspace's dependencies there, so the
// standalone output traces node_modules from it, and Turbopack resolves from it.
const root = resolve(import.meta.dirname, '../..');

const nextConfig: NextConfig = {
  // .next/standalone holds server.js and only the files it needs (apps/dashboard/Dockerfile).
  output: 'standalone',
  outputFileTracingRoot: root,
  turbopack: { root },
  poweredByHeader: false,
  reactStrictMode: true,
};

export default nextConfig;
