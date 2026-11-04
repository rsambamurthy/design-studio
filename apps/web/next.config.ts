import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@ds/core'],
  // Database drivers load native/wasm files at runtime; keep them out of the bundle.
  serverExternalPackages: ['pg', '@electric-sql/pglite'],
};

export default nextConfig;
