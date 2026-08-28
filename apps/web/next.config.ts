import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages are consumed as TypeScript source (see docs/architecture.md
  // "Build strategy"), so Next must transpile them rather than expect built JS.
  transpilePackages: ['@trimeros/domain'],
  reactStrictMode: true,
  typedRoutes: false,
};

export default nextConfig;
