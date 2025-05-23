// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config, { isServer, webpack }) => {
    // Fixes npm packages that depend on Node.js core modules for client-side bundles
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback, 
        fs: false,
        stream: false, // Add stream
        path: false,   // Add path (often comes up with fs/stream)
        os: false,     // Add os (another common one)
        crypto: false, // Add crypto (can also be an issue)
        // You can add more core modules here as needed if other errors pop up
        // e.g., 'http': false, 'https': false, 'zlib': false, 'url': false, 'util': false, 'assert': false,
      };
    }

    // It's generally good practice to ensure experiments.topLevelAwait is enabled if you use it
    // (Next.js usually handles this, but explicitly stating it can sometimes help with newer features)
    config.experiments = {
      ...config.experiments,
      topLevelAwait: true,
    };
    
    return config;
  },
};

export default nextConfig;
