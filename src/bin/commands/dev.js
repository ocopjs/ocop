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
    "--connect-to": String,
  },
  help: ({ exeName }) => {
    const { DEFAULT_PORT, DEFAULT_ENTRY } = constants();
    return `
    Usage
      $ ${exeName} dev --port=3000

    Options
      --port, -p    Port to start on [${DEFAULT_PORT}]
      --app-url     Custom application URL
      --entry       Entry file exporting ocop instance [${DEFAULT_ENTRY}]
  `;
  },
  exec: async (args, { exeName, _cwd = process.cwd() } = {}, spinner) => {
    const envDir = path.join(_cwd, ".env");
    dotenv.config({ path: envDir });
    spinner.text = "Đang kiểm tra tệp đầu vào.";
    const entryFile = await getEntryFileFullPath(args, { exeName, _cwd });
    spinner.succeed(`Tệp đầu vào hợp lệ ./${path.relative(_cwd, entryFile)}`);
    spinner.start(" ");
    return executeDefaultServer(args, entryFile, undefined, spinner);
  },
};
