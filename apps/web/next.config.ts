import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages ship TypeScript-built ESM; let Next process them.
  transpilePackages: ['@driftmark/db'],
  serverExternalPackages: ['@prisma/client', '@prisma/adapter-pg'],
};

export default config;
