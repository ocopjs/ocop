const path = require("path");
const dotenv = require("dotenv");

const { executeDefaultServer, getEntryFileFullPath } = require("../utils");
const constants = require("../../constants");

module.exports = {
  // prettier-ignore
  spec: {
    "--port": Number,
    "-p": "--port",
    "--entry": String,
    "--app-url": String,
    "--out": String,
    "-o": "--out",
  },
  help: ({ exeName }) => {
    const { DEFAULT_ENTRY } = constants();
    return `
    Usage
      $ ${exeName} start <dist> --port=3000

    Options
      --port, -p    Port to start on [3000]
      --app-url     Custom application URL
      --entry       Entry file exporting ocop instance [${DEFAULT_ENTRY}]
  `;
  },
  exec: async (args, { exeName, _cwd = process.cwd() } = {}, spinner) => {
    const envDir = path.join(_cwd, ".env");
    dotenv.config({ path: envDir });
    const { DEFAULT_DIST_DIR } = constants();
    process.env.NODE_ENV = "production";

    const distDir = args._[1] || DEFAULT_DIST_DIR;
    spinner.text = "Đang kiểm tra tệp đầu vào.";
    const entryFile = await getEntryFileFullPath(args, { exeName, _cwd });
    spinner.succeed(`Tệp đầu vào hợp lệ ./${path.relative(_cwd, entryFile)}`);
    spinner.start(" ");
    return executeDefaultServer(args, entryFile, distDir, spinner);
  },
};
