const path = require("path");
const chalk = require("chalk");

const constants = require("../../constants");
const { getEntryFileFullPath } = require("../utils");

const createTables = async (args, entryFile, spinner) => {
  // Allow the spinner time to flush its output to the console.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const { ocop } = require(path.resolve(entryFile));
  await ocop.connect(); // Need to do _createTables post connect so awaiting connect
  let errors = false;
  if (!ocop.adapter._createTables) {
    spinner.info(
      chalk.yellow.bold(`create-tables is only required for KnexAdapter`),
    );
    return;
  }
  try {
    console.log("Creating tables...");
    await ocop.adapter._createTables();
  } catch (e) {
    if (e.message.includes("already exists")) {
      spinner.fail(chalk.red.bold(`Table already exists`));
      console.warn("Create tables should be used on an empty database");
      console.warn(e.message);
    } else {
      console.error(e);
    }
    errors = true;
  }
  if (!errors) {
    spinner.succeed(chalk.green.bold(`Tables created`));
    process.exit(0);
  }
  process.exit(1);
};

module.exports = {
  // prettier-ignore
  spec: {
    "--entry": String,
  },
  help: ({ exeName }) => {
    const { DEFAULT_ENTRY } = envConf();
    return `
    Usage
      $ ${exeName} create-tables

    Options
      --entry       Entry file exporting ocop instance [${DEFAULT_ENTRY}]
  `;
  },
  exec: async (args, { exeName, _cwd = process.cwd() } = {}, spinner) => {
    spinner.text = "Validating project entry file";
    const entryFile = await getEntryFileFullPath(args, { exeName, _cwd });
    spinner.start(" ");
    return createTables(args, entryFile, spinner);
  },
};
