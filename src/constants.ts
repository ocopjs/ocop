export function envConf() {
  const PORT = process.env.GRAPHQL_PORT || 3000;
  return {
    DEFAULT_PORT: PORT,
    DEFAULT_APP_URL: process.env.APP_URL || `http://localhost:${PORT}`,
    DEFAULT_ENTRY: "index.js",
    DEFAULT_SERVER: "server.js",
    DEFAULT_DIST_DIR: "dist",
    DEFAULT_COMMAND: "dev",
  };
}
