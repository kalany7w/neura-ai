/** @type {import('next').NextConfig} */
const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:7301';

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@neura/shared'],
  // Proxy reverso pra api em dev (evita problemas de cookie cross-origin localhost:7301 ↔ 7302)
  async rewrites() {
    return [
      {
        source: '/api/auth/:path*',
        destination: `${apiUrl}/api/auth/:path*`,
      },
      {
        source: '/api/:path*',
        destination: `${apiUrl}/api/:path*`,
      },
      {
        source: '/health',
        destination: `${apiUrl}/health`,
      },
    ];
  },
};

export default nextConfig;
