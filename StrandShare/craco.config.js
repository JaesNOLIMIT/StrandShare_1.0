module.exports = {
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
