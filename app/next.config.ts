import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Vinext emits a minimal self-hosted server plus its exact runtime
  // dependencies. The generated directory is assembled into the Windows
  // portable package, while normal builds retain the Sites/Worker output.
  output: process.env.TECHMAP_STANDALONE_BUILD === '1' ? 'standalone' : undefined,
};

export default nextConfig;
