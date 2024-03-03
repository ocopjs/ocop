const constants = require("../constants");

describe("constants()", () => {
  test("exports", () => {
    const value = constants();
    expect(typeof value.DEFAULT_PORT).toBe("number");
    expect(typeof value.DEFAULT_ENTRY).toBe("string");
    expect(typeof value.DEFAULT_SERVER).toBe("string");
    expect(typeof value.DEFAULT_DIST_DIR).toBe("string");
    expect(typeof value.DEFAULT_COMMAND).toBe("string");
  });
});
