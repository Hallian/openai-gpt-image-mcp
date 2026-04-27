import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { loadEnvFile, validateSize, absolutePathCheck, base64Check } from "./utils";

// ─── validateSize ────────────────────────────────────────────────────────────

describe("validateSize", () => {
  describe("common", () => {
    test("undefined size passes for any model", () => {
      assert.doesNotThrow(() => validateSize(undefined, "gpt-image-1"));
      assert.doesNotThrow(() => validateSize(undefined, "gpt-image-2"));
    });

    test("'auto' passes for any model", () => {
      assert.doesNotThrow(() => validateSize("auto", "gpt-image-1"));
      assert.doesNotThrow(() => validateSize("auto", "gpt-image-2"));
    });
  });

  describe("gpt-image-1", () => {
    test("1024x1024 is valid", () => {
      assert.doesNotThrow(() => validateSize("1024x1024", "gpt-image-1"));
    });

    test("1536x1024 is valid", () => {
      assert.doesNotThrow(() => validateSize("1536x1024", "gpt-image-1"));
    });

    test("1024x1536 is valid", () => {
      assert.doesNotThrow(() => validateSize("1024x1536", "gpt-image-1"));
    });

    test("512x512 is invalid", () => {
      assert.throws(
        () => validateSize("512x512", "gpt-image-1"),
        { message: /Invalid size '512x512' for gpt-image-1/ }
      );
    });

    test("2048x2048 is invalid", () => {
      assert.throws(
        () => validateSize("2048x2048", "gpt-image-1"),
        { message: /Invalid size '2048x2048' for gpt-image-1/ }
      );
    });

    test("arbitrary string is invalid", () => {
      assert.throws(
        () => validateSize("large", "gpt-image-1"),
        { message: /Invalid size 'large' for gpt-image-1/ }
      );
    });
  });

  describe("gpt-image-2 format", () => {
    test("valid WxH format passes", () => {
      assert.doesNotThrow(() => validateSize("1024x1024", "gpt-image-2"));
    });

    test("missing x separator throws", () => {
      assert.throws(
        () => validateSize("1024", "gpt-image-2"),
        { message: /Invalid size format/ }
      );
    });

    test("text value throws", () => {
      assert.throws(
        () => validateSize("large", "gpt-image-2"),
        { message: /Invalid size format/ }
      );
    });

    test("triple dimensions throws", () => {
      assert.throws(
        () => validateSize("1024x1024x1024", "gpt-image-2"),
        { message: /Invalid size format/ }
      );
    });
  });

  describe("gpt-image-2 multiples of 16", () => {
    test("both dimensions multiples of 16 passes", () => {
      assert.doesNotThrow(() => validateSize("1024x1024", "gpt-image-2"));
    });

    test("width not multiple of 16 throws", () => {
      assert.throws(
        () => validateSize("1025x1024", "gpt-image-2"),
        { message: /multiples of 16/ }
      );
    });

    test("height not multiple of 16 throws", () => {
      assert.throws(
        () => validateSize("1024x1023", "gpt-image-2"),
        { message: /multiples of 16/ }
      );
    });

    test("both not multiples of 16 throws", () => {
      assert.throws(
        () => validateSize("1023x1023", "gpt-image-2"),
        { message: /multiples of 16/ }
      );
    });
  });

  describe("gpt-image-2 max edge size", () => {
    test("3840px edge is valid", () => {
      // 3840x2160 = 8,294,400 (at max pixel count too)
      assert.doesNotThrow(() => validateSize("3840x2160", "gpt-image-2"));
    });

    test("width exceeding 3840px throws", () => {
      assert.throws(
        () => validateSize("3856x2160", "gpt-image-2"),
        { message: /Maximum edge size is 3840px/ }
      );
    });

    test("height exceeding 3840px throws", () => {
      assert.throws(
        () => validateSize("2160x3856", "gpt-image-2"),
        { message: /Maximum edge size is 3840px/ }
      );
    });
  });

  describe("gpt-image-2 pixel range", () => {
    test("exact minimum pixels (655,360) passes", () => {
      // 1024x640 = 655,360
      assert.doesNotThrow(() => validateSize("1024x640", "gpt-image-2"));
    });

    test("below minimum pixels throws", () => {
      // 1024x624 = 638,976
      assert.throws(
        () => validateSize("1024x624", "gpt-image-2"),
        { message: /Total pixels must be between/ }
      );
    });

    test("exact maximum pixels (8,294,400) passes", () => {
      // 3840x2160 = 8,294,400
      assert.doesNotThrow(() => validateSize("3840x2160", "gpt-image-2"));
    });

    test("above maximum pixels throws", () => {
      // 3840x2176 = 8,355,840
      assert.throws(
        () => validateSize("3840x2176", "gpt-image-2"),
        { message: /Total pixels must be between/ }
      );
    });
  });

  describe("gpt-image-2 aspect ratio", () => {
    test("exactly 3:1 ratio passes", () => {
      // 3072x1024 = 3:1, pixels = 3,145,728
      assert.doesNotThrow(() => validateSize("3072x1024", "gpt-image-2"));
    });

    test("ratio exceeding 3:1 throws", () => {
      // 3200x1024 = 3.125:1, pixels = 3,276,800
      assert.throws(
        () => validateSize("3200x1024", "gpt-image-2"),
        { message: /Aspect ratio must be at most 3:1/ }
      );
    });

    test("portrait ratio exceeding 3:1 throws", () => {
      // 1024x3200 = 3.125:1
      assert.throws(
        () => validateSize("1024x3200", "gpt-image-2"),
        { message: /Aspect ratio must be at most 3:1/ }
      );
    });

    test("ratio just under 3:1 passes", () => {
      // 2880x1024 = 2.8125:1, pixels = 2,949,120
      assert.doesNotThrow(() => validateSize("2880x1024", "gpt-image-2"));
    });
  });
});

// ─── loadEnvFile ─────────────────────────────────────────────────────────────

describe("loadEnvFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "envtest-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeEnv(content: string): string {
    const filePath = path.join(tmpDir, ".env");
    fs.writeFileSync(filePath, content, "utf8");
    return filePath;
  }

  test("parses basic KEY=VALUE", () => {
    const envPath = writeEnv("TEST_LOAD_A=hello\nTEST_LOAD_B=world");
    loadEnvFile(envPath);
    assert.equal(process.env.TEST_LOAD_A, "hello");
    assert.equal(process.env.TEST_LOAD_B, "world");
    delete process.env.TEST_LOAD_A;
    delete process.env.TEST_LOAD_B;
  });

  test("skips comment lines", () => {
    const envPath = writeEnv("# this is a comment\nTEST_LOAD_C=value");
    loadEnvFile(envPath);
    assert.equal(process.env.TEST_LOAD_C, "value");
    delete process.env.TEST_LOAD_C;
  });

  test("skips empty lines", () => {
    const envPath = writeEnv("\n\nTEST_LOAD_D=value\n\n");
    loadEnvFile(envPath);
    assert.equal(process.env.TEST_LOAD_D, "value");
    delete process.env.TEST_LOAD_D;
  });

  test("strips single quotes from values", () => {
    const envPath = writeEnv("TEST_LOAD_E='quoted'");
    loadEnvFile(envPath);
    assert.equal(process.env.TEST_LOAD_E, "quoted");
    delete process.env.TEST_LOAD_E;
  });

  test("strips double quotes from values", () => {
    const envPath = writeEnv('TEST_LOAD_F="quoted"');
    loadEnvFile(envPath);
    assert.equal(process.env.TEST_LOAD_F, "quoted");
    delete process.env.TEST_LOAD_F;
  });

  test("handles values containing = signs", () => {
    const envPath = writeEnv("TEST_LOAD_G=abc=def=ghi");
    loadEnvFile(envPath);
    assert.equal(process.env.TEST_LOAD_G, "abc=def=ghi");
    delete process.env.TEST_LOAD_G;
  });

  test("trims key whitespace", () => {
    const envPath = writeEnv("  TEST_LOAD_H  =value");
    loadEnvFile(envPath);
    assert.equal(process.env.TEST_LOAD_H, "value");
    delete process.env.TEST_LOAD_H;
  });

  test("missing file does not throw", () => {
    assert.doesNotThrow(() => loadEnvFile("/nonexistent/path/.env"));
  });

  test("empty file does not throw", () => {
    const envPath = writeEnv("");
    assert.doesNotThrow(() => loadEnvFile(envPath));
  });

  test("key without value sets empty string", () => {
    const envPath = writeEnv("TEST_LOAD_I=");
    loadEnvFile(envPath);
    assert.equal(process.env.TEST_LOAD_I, "");
    delete process.env.TEST_LOAD_I;
  });
});

// ─── absolutePathCheck ───────────────────────────────────────────────────────

describe("absolutePathCheck", () => {
  test("unix absolute path returns true", () => {
    assert.equal(absolutePathCheck("/home/user/file.png"), true);
  });

  test("unix root path returns true", () => {
    assert.equal(absolutePathCheck("/"), true);
  });

  test("windows C:/ path returns true", () => {
    assert.equal(absolutePathCheck("C:/Users/file.png"), true);
  });

  test("windows C:\\ path returns true", () => {
    assert.equal(absolutePathCheck("C:\\Users\\file.png"), true);
  });

  test("windows lowercase drive returns true", () => {
    assert.equal(absolutePathCheck("d:\\folder"), true);
  });

  test("relative path returns false", () => {
    assert.equal(absolutePathCheck("./relative/path"), false);
  });

  test("bare filename returns false", () => {
    assert.equal(absolutePathCheck("file.png"), false);
  });

  test("undefined returns true (Zod guard design)", () => {
    assert.equal(absolutePathCheck(undefined), true);
  });

  test("empty string returns true (falsy, same as undefined)", () => {
    assert.equal(absolutePathCheck(""), true);
  });
});

// ─── base64Check ─────────────────────────────────────────────────────────────

describe("base64Check", () => {
  test("valid base64 string returns true", () => {
    assert.equal(base64Check("SGVsbG8gV29ybGQ="), true);
  });

  test("valid base64 without padding returns true", () => {
    assert.equal(base64Check("SGVsbG8"), true);
  });

  test("base64 with newlines returns true", () => {
    assert.equal(base64Check("SGVs\nbG8="), true);
  });

  test("data URL with png returns true", () => {
    assert.equal(base64Check("data:image/png;base64,iVBORw0KGgo="), true);
  });

  test("data URL with jpeg returns true", () => {
    assert.equal(base64Check("data:image/jpeg;base64,/9j/4AAQ"), true);
  });

  test("undefined returns false", () => {
    assert.equal(base64Check(undefined), false);
  });

  test("empty string returns false", () => {
    assert.equal(base64Check(""), false);
  });

  test("string with spaces returns false", () => {
    assert.equal(base64Check("hello world"), false);
  });
});
