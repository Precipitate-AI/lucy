/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Add the webpack config here:
  webpack: (config, { isServer }) => {
    // Fixes npm packages that depend on `fs` module
    // Based on https://webpack.js.org/configuration/resolve/#resolvefallback
    // and https://github.com/vercel/next.js/issues/7755#issuecomment-508633125
    if (!isServer) { // Apply this only for client-side bundles
      config.resolve.fallback = {
        ...config.resolve.fallback, // Spread existing fallbacks
        fs: false, // Tells Webpack to return an empty module for 'fs'
        // You might need to add other Node.js core modules here if they cause issues
        // net: false,
        // tls: false,
        // child_process: false,
      };
    }

    return config;
  },
};

export default nextConfig;