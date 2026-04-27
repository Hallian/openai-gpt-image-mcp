import path from "path";

export interface MappedImage {
  b64: string;
  mimeType: string;
  ext: string;
}

export interface OutputTarget {
  effectiveOutput: string;
  effectiveFileOutput: string | undefined;
}

export function validateCreateImageArgs(args: {
  model: string;
  background?: string;
  output_format?: string;
}): void {
  if (args.model === "gpt-image-2" && args.background === "transparent") {
    throw new Error("gpt-image-2 does not support transparent backgrounds.");
  }
  if (args.background === "transparent" && args.output_format && !["png", "webp"].includes(args.output_format)) {
    throw new Error("If background is 'transparent', output_format must be 'png' or 'webp'");
  }
}

export function buildCreateImageParams(args: {
  prompt: string;
  model: string;
  background?: string;
  moderation?: string;
  n?: number;
  output_compression?: number;
  output_format?: string;
  quality?: string;
  size?: string;
  user?: string;
}): Record<string, any> {
  const params: Record<string, any> = {
    prompt: args.prompt,
    model: args.model,
    ...(args.background && args.model === "gpt-image-1" ? { background: args.background } : {}),
    ...(args.moderation ? { moderation: args.moderation } : {}),
    ...(args.n ? { n: args.n } : {}),
    ...(args.output_format ? { output_format: args.output_format } : {}),
    ...(args.quality ? { quality: args.quality } : {}),
    ...(args.size ? { size: args.size } : {}),
    ...(args.user ? { user: args.user } : {}),
  };
  if (
    typeof args.output_compression !== "undefined" &&
    args.output_format &&
    ["webp", "jpeg"].includes(args.output_format)
  ) {
    params.output_compression = args.output_compression;
  }
  return params;
}

export function mapCreateImageResponse(
  data: Array<{ b64_json: string }>,
  output_format?: string
): MappedImage[] {
  return (data ?? []).map((img) => ({
    b64: img.b64_json,
    mimeType: output_format === "jpeg" ? "image/jpeg" : output_format === "webp" ? "image/webp" : "image/png",
    ext: output_format === "jpeg" ? "jpg" : output_format === "webp" ? "webp" : "png",
  }));
}

export function mapEditImageResponse(
  data: Array<{ b64_json: string }>
): MappedImage[] {
  return (data ?? []).map((img) => ({
    b64: img.b64_json,
    mimeType: "image/png",
    ext: "png",
  }));
}

const MAX_RESPONSE_SIZE = 1048576;

export function resolveOutputTarget(args: {
  output: string;
  file_output: string | undefined;
  images: MappedImage[];
  filenamePrefix: string;
  workDir?: string;
  timestamp?: number;
}): OutputTarget {
  const totalBase64Size = args.images.reduce(
    (sum, img) => sum + Buffer.byteLength(img.b64, "base64"),
    0
  );
  let effectiveOutput = args.output;
  let effectiveFileOutput = args.file_output;

  if (args.output === "base64" && totalBase64Size > MAX_RESPONSE_SIZE) {
    effectiveOutput = "file_output";
    if (!args.file_output) {
      const tmpDir = args.workDir || "/tmp";
      const unique = args.timestamp ?? Date.now();
      effectiveFileOutput = path.join(
        tmpDir,
        `${args.filenamePrefix}_${unique}.${args.images[0]?.ext ?? "png"}`
      );
    }
  }

  return { effectiveOutput, effectiveFileOutput };
}

export function resolveFilePaths(
  basePath: string,
  images: MappedImage[],
  preserveExtension: boolean
): string[] {
  const parsed = path.parse(basePath);
  return images.map((img, i) => {
    const ext = preserveExtension
      ? (parsed.ext || `.${img.ext}`)
      : `.${img.ext ?? "png"}`;
    const name = images.length > 1
      ? `${parsed.name}_${i + 1}`
      : parsed.name;
    return path.join(parsed.dir, `${name}${ext}`);
  });
}

export function parseMimeFromExtension(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "png") return "image/png";
  return "image/png";
}

export function parseBase64DataUrl(input: string): { base64: string; mime: string } {
  let base64 = input;
  let mime = "image/png";
  if (input.startsWith("data:image/")) {
    const match = input.match(/^data:(image\/\w+);base64,(.*)$/);
    if (match) {
      mime = match[1];
      base64 = match[2];
    }
  }
  return { base64, mime };
}

export function buildEditImageParams(args: {
  prompt: string;
  model: string;
  n?: number;
  quality?: string;
  size?: string;
  user?: string;
  imageFile: any;
  maskFile?: any;
}): Record<string, any> {
  return {
    image: args.imageFile,
    prompt: args.prompt,
    model: args.model,
    ...(args.maskFile ? { mask: args.maskFile } : {}),
    ...(args.n ? { n: args.n } : {}),
    ...(args.quality ? { quality: args.quality } : {}),
    ...(args.size ? { size: args.size } : {}),
    ...(args.user ? { user: args.user } : {}),
  };
}
