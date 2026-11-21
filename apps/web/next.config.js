/** @type {import('next').NextConfig} */
const tier2Url = process.env.NEXT_PUBLIC_TIER2_URL || "http://localhost:8000";
const tier1Url = process.env.NEXT_PUBLIC_TIER1_URL || "http://localhost:8001";

const nextConfig = {
  reactStrictMode: true,
  cleanDistDir: false,
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  async rewrites() {
    return [
      {
        source: "/api/tier2/:path*",
        destination: `${tier2Url}/:path*`,
      },
      {
        source: "/api/tier1/:path*",
        destination: `${tier1Url}/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
