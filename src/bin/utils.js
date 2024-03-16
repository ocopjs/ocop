const terminalLink = require("terminal-link");
const express = require("express");
const endent = require("endent").default;
const ciInfo = require("ci-info");
const chalk = require("chalk");
const path = require("path");

const constants = require("../constants");

const ttyLink = (text, path, appUrl) => {
  if (ciInfo.isCI) {
    return;
  }
  const url = `${appUrl}${path}`;
  const link = terminalLink(url, url, { fallback: () => url });
  console.log(`🔗 ${chalk.green(text)}\t${link}`);
};

function getEntryFileFullPath(args, { exeName, _cwd }) {
  const { DEFAULT_ENTRY } = constants();

  const entryFile = args["--entry"] ? args["--entry"] : DEFAULT_ENTRY;
  try {
    return Promise.resolve(require.resolve(path.resolve(_cwd, entryFile)));
  } catch (error) {
    return Promise.reject(
      new Error(endent`
        --entry=${entryFile} was passed to ${exeName}, but '${entryFile}' couldn't be found in ${process.cwd()}.
        Ensure you're running ${exeName} from within the root directory of the project.
      `),
    );
  }
}

function extractAppMeta(apps, dev) {
  let adminPath;
  let graphiqlPath;
  let apiPath;

  apps.forEach((app) => {
    switch (app.constructor.name) {
      case "AdminUIApp": {
        adminPath = app.adminPath;
        break;
      }
      case "GraphQLApp": {
        apiPath = app._apiPath;
        graphiqlPath = dev ? app._graphiqlPath : undefined;
        break;
      }
    }
  });

  return {
    adminPath,
    graphiqlPath,
    apiPath,
  };
}

/**
 * MAIN
 * execute default server
 */
async function executeDefaultServer(args, entryFile, distDir, spinner) {
  const { DEFAULT_PORT, DEFAULT_APP_URL } = constants();
  const {
    ocop,
    apps = [],
    configureExpress = () => {},
    cors,
    pinoOptions,
  } = require(path.resolve(entryFile));

  const dev = process.env.NODE_ENV !== "production";
  const port = args["--port"] ? args["--port"] : DEFAULT_PORT;
  const appUrl = args["--app-url"] ? args["--app-url"] : DEFAULT_APP_URL;

  let status = "start-server";
  const app = express();

  app.use((_req, res, next) => {
    if (status === "started") {
      next();
    } else {
      res.format({
        default: () => res.sendFile(path.resolve(__dirname, "./loading.html")),
        "text/html": () =>
          res.sendFile(path.resolve(__dirname, "./loading.html")),
        "application/json": () => res.json({ loading: true, status }),
      });
    }
  });

  /**
   * start server
   */
  spinner.start("Đang khởi chạy máy chủ.");
  const { server } = await new Promise((resolve, reject) => {
    const server = app.listen(port, (error) => {
      if (error) {
        return reject(error);
      }
      return resolve({ server });
    });
  });
  spinner.succeed(`Đã khởi tạo máy chủ.`);

  status = "init-ocop";

  configureExpress(app);
  spinner.succeed(`Đã khởi tạo.`);
  status = "db-connect";

  /**
   * create express middlewares
   */
  spinner.start("Đang khởi tạo middlewares.");
  const { server: _server, middlewares } = await ocop.prepare({
    apps,
    distDir,
    dev,
    cors,
    pinoOptions,
    logger: (value) => {
      spinner.info(` ${value}`);
    },
  });
  app.use(middlewares);
  spinner.succeed("Đã khởi tạo middlewares.");

  /**
   * connect to database
   */
  spinner.start("Đang kết nối đến cơ sở dữ liệu.");
  await ocop.connect();
  spinner.succeed("Đã kết nối đến cơ sở dữ liệu.");

  status = "started";
  spinner.succeed(`Đã sẵn sàng tại ${port}`);
  const { adminPath, graphiqlPath, apiPath } = extractAppMeta(apps, dev);

  /* eslint-disable no-unused-expressions */
  adminPath && ttyLink("Admin UI:", adminPath, appUrl);
  graphiqlPath && ttyLink("GraphQL Playground:", graphiqlPath, appUrl);
  apiPath && ttyLink("GraphQL API:\t", apiPath, appUrl);
  /* eslint-enable no-unused-expressions */
  ocop.onInit(port);
  return { port, server };
}

module.exports = {
  getEntryFileFullPath,
  executeDefaultServer,
};
