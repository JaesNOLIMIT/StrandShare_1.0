module.exports = {
  devServer: (devServerConfig) => {
    // The CRA hot-reload socket also needs to close before Chrome stores a
    // page in BFCache. This transport is development-only and keeps normal
    // hot reload/overlay behavior intact.
    devServerConfig.client = {
      ...(devServerConfig.client || {}),
      webSocketTransport: require.resolve('./scripts/BfcacheSafeWebSocketClient.js'),
    };
    return devServerConfig;
  },
  webpack: {
    configure: (webpackConfig) => {
      const rules = webpackConfig.module?.rules || [];

      rules.forEach((rule) => {
        if (rule.loader && rule.loader.includes("source-map-loader")) {
          const existingExcludes = Array.isArray(rule.exclude)
            ? rule.exclude
            : rule.exclude
            ? [rule.exclude]
            : [];

          rule.exclude = [
            ...existingExcludes,
            /[\\/]node_modules[\\/]dompurify[\\/]/,
            /[\\/]node_modules[\\/]@mediapipe[\\/]tasks-vision[\\/]/,
          ];
        }
      });

      return webpackConfig;
    },
  },
};
