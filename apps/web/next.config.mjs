/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${process.env.CONTENTOS_API_URL ?? 'http://127.0.0.1:3000'}/api/:path*` }];
  },
};
export default nextConfig;
