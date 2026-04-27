import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  validateCreateImageArgs,
  buildCreateImageParams,
  mapCreateImageResponse,
  mapEditImageResponse,
  resolveOutputTarget,
  resolveFilePaths,
  parseMimeFromExtension,
  parseBase64DataUrl,
  buildEditImageParams,
  MappedImage,
} from "./image-helpers";

// ─── validateCreateImageArgs ────────────────────────────────────────────────

describe("validateCreateImageArgs", () => {
  test("gpt-image-2 with transparent background throws", () => {
    assert.throws(
      () => validateCreateImageArgs({ model: "gpt-image-2", background: "transparent" }),
      { message: /gpt-image-2 does not support transparent backgrounds/ }
    );
  });

  test("gpt-image-1 with transparent background does not throw", () => {
    assert.doesNotThrow(() =>
      validateCreateImageArgs({ model: "gpt-image-1", background: "transparent" })
    );
  });

  test("transparent background with jpeg throws", () => {
    assert.throws(
      () => validateCreateImageArgs({ model: "gpt-image-1", background: "transparent", output_format: "jpeg" }),
      { message: /output_format must be 'png' or 'webp'/ }
    );
  });

  test("transparent background with png does not throw", () => {
    assert.doesNotThrow(() =>
      validateCreateImageArgs({ model: "gpt-image-1", background: "transparent", output_format: "png" })
    );
  });

  test("transparent background with webp does not throw", () => {
    assert.doesNotThrow(() =>
      validateCreateImageArgs({ model: "gpt-image-1", background: "transparent", output_format: "webp" })
    );
  });

  test("transparent background with no format does not throw", () => {
    assert.doesNotThrow(() =>
      validateCreateImageArgs({ model: "gpt-image-1", background: "transparent" })
    );
  });

  test("no background does not throw", () => {
    assert.doesNotThrow(() =>
      validateCreateImageArgs({ model: "gpt-image-2" })
    );
  });
});

// ─── buildCreateImageParams ─────────────────────────────────────────────────

describe("buildCreateImageParams", () => {
  test("includes required fields", () => {
    const result = buildCreateImageParams({ prompt: "a cat", model: "gpt-image-1" });
    assert.equal(result.prompt, "a cat");
    assert.equal(result.model, "gpt-image-1");
  });

  test("includes background only for gpt-image-1", () => {
    const result = buildCreateImageParams({ prompt: "a cat", model: "gpt-image-1", background: "transparent" });
    assert.equal(result.background, "transparent");
  });

  test("excludes background for gpt-image-2", () => {
    const result = buildCreateImageParams({ prompt: "a cat", model: "gpt-image-2", background: "opaque" });
    assert.equal(result.background, undefined);
  });

  test("includes optional fields when truthy", () => {
    const result = buildCreateImageParams({
      prompt: "a cat",
      model: "gpt-image-1",
      moderation: "low",
      n: 3,
      output_format: "webp",
      quality: "high",
      size: "1024x1024",
      user: "user-123",
    });
    assert.equal(result.moderation, "low");
    assert.equal(result.n, 3);
    assert.equal(result.output_format, "webp");
    assert.equal(result.quality, "high");
    assert.equal(result.size, "1024x1024");
    assert.equal(result.user, "user-123");
  });

  test("excludes optional fields when falsy", () => {
    const result = buildCreateImageParams({ prompt: "a cat", model: "gpt-image-1" });
    assert.equal(result.moderation, undefined);
    assert.equal(result.n, undefined);
    assert.equal(result.output_format, undefined);
    assert.equal(result.quality, undefined);
    assert.equal(result.size, undefined);
    assert.equal(result.user, undefined);
  });

  test("includes output_compression for webp", () => {
    const result = buildCreateImageParams({
      prompt: "a cat",
      model: "gpt-image-1",
      output_format: "webp",
      output_compression: 80,
    });
    assert.equal(result.output_compression, 80);
  });

  test("includes output_compression for jpeg", () => {
    const result = buildCreateImageParams({
      prompt: "a cat",
      model: "gpt-image-1",
      output_format: "jpeg",
      output_compression: 50,
    });
    assert.equal(result.output_compression, 50);
  });

  test("excludes output_compression for png", () => {
    const result = buildCreateImageParams({
      prompt: "a cat",
      model: "gpt-image-1",
      output_format: "png",
      output_compression: 80,
    });
    assert.equal(result.output_compression, undefined);
  });

  test("excludes output_compression when output_format is undefined", () => {
    const result = buildCreateImageParams({
      prompt: "a cat",
      model: "gpt-image-1",
      output_compression: 80,
    });
    assert.equal(result.output_compression, undefined);
  });

  test("includes output_compression=0 for webp (falsy but defined)", () => {
    const result = buildCreateImageParams({
      prompt: "a cat",
      model: "gpt-image-1",
      output_format: "webp",
      output_compression: 0,
    });
    assert.equal(result.output_compression, 0);
  });
});

// ─── mapCreateImageResponse ─────────────────────────────────────────────────

describe("mapCreateImageResponse", () => {
  test("jpeg format maps correctly", () => {
    const result = mapCreateImageResponse([{ b64_json: "AAAA" }], "jpeg");
    assert.equal(result[0].mimeType, "image/jpeg");
    assert.equal(result[0].ext, "jpg");
    assert.equal(result[0].b64, "AAAA");
  });

  test("webp format maps correctly", () => {
    const result = mapCreateImageResponse([{ b64_json: "BBBB" }], "webp");
    assert.equal(result[0].mimeType, "image/webp");
    assert.equal(result[0].ext, "webp");
  });

  test("png format maps correctly", () => {
    const result = mapCreateImageResponse([{ b64_json: "CCCC" }], "png");
    assert.equal(result[0].mimeType, "image/png");
    assert.equal(result[0].ext, "png");
  });

  test("undefined format defaults to png", () => {
    const result = mapCreateImageResponse([{ b64_json: "DDDD" }]);
    assert.equal(result[0].mimeType, "image/png");
    assert.equal(result[0].ext, "png");
  });

  test("empty data returns empty array", () => {
    const result = mapCreateImageResponse([]);
    assert.deepEqual(result, []);
  });

  test("multiple images all get same format", () => {
    const result = mapCreateImageResponse(
      [{ b64_json: "AA" }, { b64_json: "BB" }],
      "jpeg"
    );
    assert.equal(result.length, 2);
    assert.equal(result[0].mimeType, "image/jpeg");
    assert.equal(result[1].mimeType, "image/jpeg");
  });

  test("null data returns empty array", () => {
    const result = mapCreateImageResponse(null as any);
    assert.deepEqual(result, []);
  });
});

// ─── mapEditImageResponse ───────────────────────────────────────────────────

describe("mapEditImageResponse", () => {
  test("always produces image/png", () => {
    const result = mapEditImageResponse([{ b64_json: "AAAA" }]);
    assert.equal(result[0].mimeType, "image/png");
    assert.equal(result[0].ext, "png");
    assert.equal(result[0].b64, "AAAA");
  });

  test("empty data returns empty array", () => {
    assert.deepEqual(mapEditImageResponse([]), []);
  });

  test("multiple images all get png", () => {
    const result = mapEditImageResponse([{ b64_json: "AA" }, { b64_json: "BB" }]);
    assert.equal(result.length, 2);
    assert.equal(result[0].mimeType, "image/png");
    assert.equal(result[1].mimeType, "image/png");
  });

  test("null data returns empty array", () => {
    const result = mapEditImageResponse(null as any);
    assert.deepEqual(result, []);
  });
});

// ─── resolveOutputTarget ────────────────────────────────────────────────────

describe("resolveOutputTarget", () => {
  const smallImage: MappedImage = { b64: "AAAA", mimeType: "image/png", ext: "png" };
  const largeB64 = Buffer.alloc(1048577).toString("base64");
  const largeImage: MappedImage = { b64: largeB64, mimeType: "image/png", ext: "png" };

  test("file_output stays as file_output", () => {
    const result = resolveOutputTarget({
      output: "file_output",
      file_output: "/tmp/out.png",
      images: [smallImage],
      filenamePrefix: "openai_image",
    });
    assert.equal(result.effectiveOutput, "file_output");
    assert.equal(result.effectiveFileOutput, "/tmp/out.png");
  });

  test("base64 under threshold stays as base64", () => {
    const result = resolveOutputTarget({
      output: "base64",
      file_output: undefined,
      images: [smallImage],
      filenamePrefix: "openai_image",
    });
    assert.equal(result.effectiveOutput, "base64");
  });

  test("base64 over threshold switches to file_output", () => {
    const result = resolveOutputTarget({
      output: "base64",
      file_output: undefined,
      images: [largeImage],
      filenamePrefix: "openai_image",
      timestamp: 1234567890,
    });
    assert.equal(result.effectiveOutput, "file_output");
    assert.ok(result.effectiveFileOutput);
  });

  test("auto-switch generates path with prefix and timestamp", () => {
    const result = resolveOutputTarget({
      output: "base64",
      file_output: undefined,
      images: [largeImage],
      filenamePrefix: "openai_image",
      timestamp: 1234567890,
    });
    assert.equal(result.effectiveFileOutput, "/tmp/openai_image_1234567890.png");
  });

  test("auto-switch uses workDir when provided", () => {
    const result = resolveOutputTarget({
      output: "base64",
      file_output: undefined,
      images: [largeImage],
      filenamePrefix: "openai_image",
      workDir: "/custom/dir",
      timestamp: 999,
    });
    assert.equal(result.effectiveFileOutput, "/custom/dir/openai_image_999.png");
  });

  test("auto-switch preserves existing file_output", () => {
    const result = resolveOutputTarget({
      output: "base64",
      file_output: "/user/chosen.png",
      images: [largeImage],
      filenamePrefix: "openai_image",
    });
    assert.equal(result.effectiveOutput, "file_output");
    assert.equal(result.effectiveFileOutput, "/user/chosen.png");
  });

  test("empty images array stays as base64", () => {
    const result = resolveOutputTarget({
      output: "base64",
      file_output: undefined,
      images: [],
      filenamePrefix: "openai_image",
    });
    assert.equal(result.effectiveOutput, "base64");
  });

  test("auto-switch uses first image ext for generated path", () => {
    const largeJpeg: MappedImage = { b64: largeB64, mimeType: "image/jpeg", ext: "jpg" };
    const result = resolveOutputTarget({
      output: "base64",
      file_output: undefined,
      images: [largeJpeg],
      filenamePrefix: "openai_image",
      timestamp: 42,
    });
    assert.equal(result.effectiveFileOutput, "/tmp/openai_image_42.jpg");
  });

  test("auto-switch without timestamp uses Date.now()", () => {
    const result = resolveOutputTarget({
      output: "base64",
      file_output: undefined,
      images: [largeImage],
      filenamePrefix: "openai_image",
    });
    assert.equal(result.effectiveOutput, "file_output");
    assert.ok(result.effectiveFileOutput!.startsWith("/tmp/openai_image_"));
    assert.ok(result.effectiveFileOutput!.endsWith(".png"));
  });

  test("auto-switch with image missing ext defaults to png in path", () => {
    const noExtImage: MappedImage = { b64: largeB64, mimeType: "image/png", ext: undefined as any };
    const result = resolveOutputTarget({
      output: "base64",
      file_output: undefined,
      images: [noExtImage],
      filenamePrefix: "openai_image",
      timestamp: 1,
    });
    assert.equal(result.effectiveFileOutput, "/tmp/openai_image_1.png");
  });
});

// ─── resolveFilePaths ───────────────────────────────────────────────────────

describe("resolveFilePaths", () => {
  const pngImage: MappedImage = { b64: "AA", mimeType: "image/png", ext: "png" };
  const jpgImage: MappedImage = { b64: "BB", mimeType: "image/jpeg", ext: "jpg" };

  test("single image, preserveExtension=false uses img.ext", () => {
    const result = resolveFilePaths("/tmp/output.bmp", [jpgImage], false);
    assert.equal(result[0], "/tmp/output.jpg");
  });

  test("single image, preserveExtension=true preserves path ext", () => {
    const result = resolveFilePaths("/tmp/output.bmp", [jpgImage], true);
    assert.equal(result[0], "/tmp/output.bmp");
  });

  test("single image, preserveExtension=true falls back to img.ext when no path ext", () => {
    const result = resolveFilePaths("/tmp/output", [jpgImage], true);
    assert.equal(result[0], "/tmp/output.jpg");
  });

  test("multiple images, preserveExtension=false appends index", () => {
    const result = resolveFilePaths("/tmp/output.png", [pngImage, pngImage], false);
    assert.equal(result[0], "/tmp/output_1.png");
    assert.equal(result[1], "/tmp/output_2.png");
  });

  test("multiple images, preserveExtension=true appends index with preserved ext", () => {
    const result = resolveFilePaths("/tmp/output.bmp", [jpgImage, jpgImage], true);
    assert.equal(result[0], "/tmp/output_1.bmp");
    assert.equal(result[1], "/tmp/output_2.bmp");
  });

  test("path with nested directories preserved", () => {
    const result = resolveFilePaths("/home/user/images/photo.png", [pngImage], false);
    assert.equal(result[0], "/home/user/images/photo.png");
  });

  test("image with undefined ext defaults to png", () => {
    const noExtImage: MappedImage = { b64: "CC", mimeType: "image/png", ext: undefined as any };
    const result = resolveFilePaths("/tmp/out", [noExtImage], false);
    assert.equal(result[0], "/tmp/out.png");
  });

  test("three images get correct indices", () => {
    const result = resolveFilePaths("/tmp/out.png", [pngImage, pngImage, pngImage], false);
    assert.equal(result.length, 3);
    assert.equal(result[0], "/tmp/out_1.png");
    assert.equal(result[1], "/tmp/out_2.png");
    assert.equal(result[2], "/tmp/out_3.png");
  });
});

// ─── parseMimeFromExtension ─────────────────────────────────────────────────

describe("parseMimeFromExtension", () => {
  test("jpg returns image/jpeg", () => {
    assert.equal(parseMimeFromExtension("/tmp/photo.jpg"), "image/jpeg");
  });

  test("jpeg returns image/jpeg", () => {
    assert.equal(parseMimeFromExtension("/tmp/photo.jpeg"), "image/jpeg");
  });

  test("webp returns image/webp", () => {
    assert.equal(parseMimeFromExtension("/tmp/photo.webp"), "image/webp");
  });

  test("png returns image/png", () => {
    assert.equal(parseMimeFromExtension("/tmp/photo.png"), "image/png");
  });

  test("unknown extension defaults to image/png", () => {
    assert.equal(parseMimeFromExtension("/tmp/photo.tiff"), "image/png");
  });
});

// ─── parseBase64DataUrl ─────────────────────────────────────────────────────

describe("parseBase64DataUrl", () => {
  test("plain base64 returns unchanged with default mime", () => {
    const result = parseBase64DataUrl("SGVsbG8=");
    assert.equal(result.base64, "SGVsbG8=");
    assert.equal(result.mime, "image/png");
  });

  test("data:image/png URL is parsed", () => {
    const result = parseBase64DataUrl("data:image/png;base64,iVBORw0KGgo=");
    assert.equal(result.base64, "iVBORw0KGgo=");
    assert.equal(result.mime, "image/png");
  });

  test("data:image/jpeg URL is parsed", () => {
    const result = parseBase64DataUrl("data:image/jpeg;base64,/9j/4AAQ");
    assert.equal(result.base64, "/9j/4AAQ");
    assert.equal(result.mime, "image/jpeg");
  });

  test("data:image/webp URL is parsed", () => {
    const result = parseBase64DataUrl("data:image/webp;base64,UklGR");
    assert.equal(result.base64, "UklGR");
    assert.equal(result.mime, "image/webp");
  });

  test("malformed data URL returns input as-is with default mime", () => {
    const result = parseBase64DataUrl("data:image/pngbase64broken");
    assert.equal(result.base64, "data:image/pngbase64broken");
    assert.equal(result.mime, "image/png");
  });
});

// ─── buildEditImageParams ───────────────────────────────────────────────────

describe("buildEditImageParams", () => {
  test("includes required fields", () => {
    const result = buildEditImageParams({
      prompt: "add hat",
      model: "gpt-image-1",
      imageFile: "img-file",
    });
    assert.equal(result.image, "img-file");
    assert.equal(result.prompt, "add hat");
    assert.equal(result.model, "gpt-image-1");
  });

  test("includes mask when provided", () => {
    const result = buildEditImageParams({
      prompt: "add hat",
      model: "gpt-image-1",
      imageFile: "img-file",
      maskFile: "mask-file",
    });
    assert.equal(result.mask, "mask-file");
  });

  test("excludes mask when not provided", () => {
    const result = buildEditImageParams({
      prompt: "add hat",
      model: "gpt-image-1",
      imageFile: "img-file",
    });
    assert.equal(result.mask, undefined);
  });

  test("includes all optional fields when truthy", () => {
    const result = buildEditImageParams({
      prompt: "add hat",
      model: "gpt-image-1",
      imageFile: "img-file",
      maskFile: "mask-file",
      n: 3,
      quality: "high",
      size: "1024x1024",
      user: "user-123",
    });
    assert.equal(result.n, 3);
    assert.equal(result.quality, "high");
    assert.equal(result.size, "1024x1024");
    assert.equal(result.user, "user-123");
  });

  test("excludes optional fields when falsy", () => {
    const result = buildEditImageParams({
      prompt: "add hat",
      model: "gpt-image-1",
      imageFile: "img-file",
    });
    assert.equal(result.n, undefined);
    assert.equal(result.quality, undefined);
    assert.equal(result.size, undefined);
    assert.equal(result.user, undefined);
  });

  test("no optional fields produces minimal object", () => {
    const result = buildEditImageParams({
      prompt: "edit",
      model: "gpt-image-2",
      imageFile: "f",
    });
    assert.deepEqual(Object.keys(result).sort(), ["image", "model", "prompt"]);
  });
});
