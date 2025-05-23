// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { isServer, webpack }) => { // Added webpack to destructuring for DefinePlugin if needed
    // Fixes npm packages that depend on `fs` module for client-side bundles
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback, // Spread existing fallbacks
        fs: false, // Tells Webpack to return an empty module for 'fs'
        // You might need to add other Node.js core modules here if they cause issues
        // net: false,
        // tls: false,
        // child_process: false,
        // 'mongodb-client-encryption': false, // Example if another lib caused issues
        // 'aws4': false, // Example
      };
    }

    // Optional: If you ever face "process is not defined" issues for client-side code with some libs
    // config.plugins.push(
    //   new webpack.DefinePlugin({
    //     'process.env': JSON.stringify(process.env), // Provide process.env to client-side
    //   })
    // );

    return config;
  },
};

export default nextConfig;
