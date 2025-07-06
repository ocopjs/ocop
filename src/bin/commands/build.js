const chalk = require("chalk");
const path = require("path");
const fs = require("fs-extra");
const dotenv = require("dotenv");

const { getEntryFileFullPath } = require("../utils");
const { envConf } = require("../../constants");

module.exports = {
  // prettier-ignore
  spec: {
    "--out": String,
    "-o": "--out",
    "--entry": String,
  },
  help: ({ exeName }) => {
    const { DEFAULT_ENTRY } = envConf();
    return `
    Usage
      $ ${exeName} build --out=dist

    Options
      --out, -o   Directory to save build [dist]
      --entry     Entry file exporting ocop instance [${DEFAULT_ENTRY}]
  `;
  },
  exec: async (args, { exeName, _cwd = process.cwd() } = {}, spinner) => {
    const envDir = path.join(_cwd, ".env");
    dotenv.config({ path: envDir });
    const { DEFAULT_DIST_DIR } = envConf();

    process.env.NODE_ENV = "production";

    spinner.text = "Đang kiểm tra tệp đầu vào.";
    let entryFile = await getEntryFileFullPath(args, { exeName, _cwd });
    spinner.succeed(`Tệp đầu vào hợp lệ ./${path.relative(_cwd, entryFile)}`);

    spinner.start("Initialising Ocop instance");
    let { ocop, apps, distDir = DEFAULT_DIST_DIR } = require(entryFile);
    spinner.succeed("Initialised Ocop instance");

    if (args["--out"]) {
      distDir = args["--out"];
    }
    let resolvedDistDir = path.resolve(_cwd, distDir);
    spinner.start(
      `Exporting Ocop build to ./${path.relative(_cwd, resolvedDistDir)}`,
    );

    await fs.remove(resolvedDistDir);

    if (apps) {
      await Promise.all(
        apps
          .filter((app) => app.build)
          .map((app) => app.build({ distDir: resolvedDistDir, ocop })),
      );

      spinner.succeed(
        chalk.green.bold(`Exported Ocop build to ${resolvedDistDir}`),
      );
    } else {
      spinner.info("Nothing to build.");
      spinner.info(
        `To create an Admin UI build, make sure you export 'admin' from ./${path.relative(
          _cwd,
          entryFile,
        )}`,
      );
    }

    // It's possible the developer's entry file has an accidentally long-lived
    // process (for example, using 'connect-mongodb-session').
    // To avoid that long-lived process from making the build command hang, we
    // signal that we wish the process to end here.
    return { endProcessWithSuccess: true };
  },
};
