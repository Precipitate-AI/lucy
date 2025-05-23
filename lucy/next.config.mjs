// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { isServer, webpack }) => {
    // Log to see if this webpack function is even being called on Vercel
    console.log(">>> Applying custom webpack config. isServer:", isServer);

    if (!isServer) {
      console.log(">>> Applying client-side fallbacks.");
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        stream: false,
        'node:stream': false, // Explicitly try to false out the 'node:stream' import
        path: false,
        'node:path': false,   // And other 'node:' prefixed modules
        os: false,
        'node:os': false,
        crypto: false,
        'node:crypto': false,
        // Add more if other "node:" prefixed errors appear
      };

      // Alternative way to ignore modules, sometimes more effective
      // This uses webpack.IgnorePlugin
      // config.plugins.push(
      //   new webpack.IgnorePlugin({ resourceRegExp: /^node:/ }) // Ignores all 'node:' prefixed modules
      // );
      // OR more specifically:
      // config.plugins.push(
      //   new webpack.IgnorePlugin({ resourceRegExp: /^fs$|^stream$|^path$|^os$|^crypto$/ })
      // );


      console.log(">>> Client fallbacks applied:", JSON.stringify(config.resolve.fallback));
    }

    config.experiments = {
      ...config.experiments,
      topLevelAwait: true,
    };

    return config;
  },
};

export default nextConfig;
