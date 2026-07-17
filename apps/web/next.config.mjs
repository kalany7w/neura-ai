import { withSentryConfig } from '@sentry/nextjs';

/** @type {import('next').NextConfig} */
const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:7301';
const isDev = process.env.NODE_ENV !== 'production';

// CSP — restritivo mas permite o que Next/Tailwind precisam.
// Em dev, Next precisa 'unsafe-eval' pra HMR.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "media-src 'self' http: https: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss: http: https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
];

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@neura/shared'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
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
        source: '/ws',
        destination: `${apiUrl}/ws`,
      },
      {
        source: '/health',
        destination: `${apiUrl}/health`,
      },
    ];
  },
};

// withSentryConfig: instrumenta o build. Upload de source maps só ocorre com
// SENTRY_AUTH_TOKEN + SENTRY_ORG + SENTRY_PROJECT setados; senão é passthrough.
export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  disableLogger: true,
});

