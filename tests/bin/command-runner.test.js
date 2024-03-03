const commandRunner = require("../../src/bin/command-runner");
const constants = require("../../src/constants");
const version = require("../../package.json").version;

const mockSpinner = {
  text: "",
  start: () => {},
  succeed: () => {},
  fail: () => {},
  info: () => {},
};

describe("ocop CLI command-runner", () => {
  test("prints version", () => {
    expect(commandRunner.version()).toBe(version);
  });

  test("prints help", () => {
    expect(commandRunner.help({})).toEqual(expect.stringContaining("Usage"));
  });

  test("prints help of commands", () => {
    expect(
      commandRunner.help({
        hello: {
          help: () => "Hello command",
        },
      }),
    ).toEqual(expect.stringContaining("Hello command"));
  });

  test("executes a given command", () => {
    expect(
      commandRunner.exec(
        {
          _: ["hello"],
        },
        {
          hello: {
            exec: jest.fn(() => Promise.resolve(true)),
          },
        },
        mockSpinner,
      ),
    ).resolves.toEqual(expect.anything());
  });

  test("executes the default command ", () => {
    const { DEFAULT_COMMAND } = constants();
    expect(
      commandRunner.exec(
        { _: [] },
        {
          [DEFAULT_COMMAND]: {
            exec: jest.fn(() => Promise.resolve(true)),
          },
        },
        mockSpinner,
      ),
    ).resolves.toEqual(expect.anything());
  });
});
