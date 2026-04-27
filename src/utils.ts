import fs from "fs";

export const loadEnvFile = (filePath: string) => {
  try {
    const envConfig = fs.readFileSync(filePath, "utf8");
    envConfig.split("\n").forEach((line) => {
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith("#")) {
        const [key, ...valueParts] = trimmedLine.split("=");
        const value = valueParts.join("=").trim();
        if (key) {
          process.env[key.trim()] = value.startsWith("'") && value.endsWith("'") || value.startsWith("\"") && value.endsWith("\"")
            ? value.slice(1, -1)
            : value;
        }
      }
    });
    console.log(`Loaded environment variables from ${filePath}`);
  } catch (error) {
    console.warn(`Warning: Could not read environment file at ${filePath}:`, error);
  }
};

export function validateSize(size: string | undefined, model: string): void {
  if (!size || size === "auto") return;

  const GPT_IMAGE_1_SIZES = ["1024x1024", "1536x1024", "1024x1536"];
  if (model === "gpt-image-1") {
    if (!GPT_IMAGE_1_SIZES.includes(size)) {
      throw new Error(
        `Invalid size '${size}' for gpt-image-1. Must be one of: ${GPT_IMAGE_1_SIZES.join(", ")}, or 'auto'.`
      );
    }
    return;
  }

  const match = size.match(/^(\d+)x(\d+)$/);
  if (!match) {
    throw new Error(`Invalid size format '${size}'. Expected 'WxH' (e.g., '1024x1024') or 'auto'.`);
  }
  const width = parseInt(match[1], 10);
  const height = parseInt(match[2], 10);

  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new Error(`Both dimensions must be multiples of 16. Got ${width}x${height}.`);
  }
  if (width > 3840 || height > 3840) {
    throw new Error(`Maximum edge size is 3840px. Got ${width}x${height}.`);
  }
  const totalPixels = width * height;
  if (totalPixels < 655360 || totalPixels > 8294400) {
    throw new Error(
      `Total pixels must be between 655,360 and 8,294,400. Got ${totalPixels} (${width}x${height}).`
    );
  }
  const aspectRatio = Math.max(width, height) / Math.min(width, height);
  if (aspectRatio > 3) {
    throw new Error(`Aspect ratio must be at most 3:1. Got ${aspectRatio.toFixed(2)}:1 (${width}x${height}).`);
  }
}

export const absolutePathCheck = (val: string | undefined) => {
  if (!val) return true;
  if (val.startsWith("/")) return true;
  if (/^[a-zA-Z]:[/\\]/.test(val)) return true;
  return false;
};

export const base64Check = (val: string | undefined) => !!val && (/^([A-Za-z0-9+/=\r\n]+)$/.test(val) || val.startsWith("data:image/"));
