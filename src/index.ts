// Suppress all Node.js warnings (including deprecation)
(process as any).emitWarning = () => { };

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenAI, AzureOpenAI, toFile } from "openai";
import fs from "fs";
import path from "path";

// Function to load environment variables from a file
const loadEnvFile = (filePath: string) => {
  try {
    const envConfig = fs.readFileSync(filePath, "utf8");
    envConfig.split("\n").forEach((line) => {
      const trimmedLine = line.trim();
      if (trimmedLine && !trimmedLine.startsWith("#")) {
        const [key, ...valueParts] = trimmedLine.split("=");
        const value = valueParts.join("=").trim();
        if (key) {
          // Remove surrounding quotes if present
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

// Parse command line arguments for --env-file
const cmdArgs = process.argv.slice(2);
const envFileArgIndex = cmdArgs.findIndex(arg => arg === "--env-file");
if (envFileArgIndex !== -1 && cmdArgs[envFileArgIndex + 1]) {
  console.log("Loading environment variables from file:", cmdArgs[envFileArgIndex + 1]);
  const envFilePath = cmdArgs[envFileArgIndex + 1];
  loadEnvFile(envFilePath);
} else {
  console.log("No environment file provided");
}

(async () => {
  const server = new McpServer({
    name: "openai-gpt-image-mcp",
    version: "1.0.0"
  }, {
    capabilities: {
      tools: { listChanged: false }
    }
  });

  function validateSize(size: string | undefined, model: string): void {
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

  // Zod schema for create-image tool input
  const createImageSchema = z.object({
    prompt: z.string().max(32000),
    background: z.enum(["transparent", "opaque", "auto"]).optional(),
    model: z.enum(["gpt-image-1", "gpt-image-2"]).default("gpt-image-1"),
    moderation: z.enum(["auto", "low"]).optional(),
    n: z.number().int().min(1).max(10).optional(),
    output_compression: z.number().int().min(0).max(100).optional(),
    output_format: z.enum(["png", "jpeg", "webp"]).optional(),
    quality: z.enum(["auto", "high", "medium", "low"]).optional(),
    size: z.string().optional().describe(
      "Image size. For gpt-image-1: '1024x1024', '1536x1024', '1024x1536', or 'auto'. " +
      "For gpt-image-2: any 'WxH' where both dimensions are multiples of 16, max edge 3840px, " +
      "aspect ratio up to 3:1, total pixels between 655360 and 8294400. Common presets: " +
      "'1024x1024', '1536x1024', '1024x1536', '1792x1024', '2048x2048'."
    ),
    user: z.string().optional(),
    output: z.enum(["base64", "file_output"]).default("base64"),
    file_output: z.string().optional().refine(
      (val) => {
        if (!val) return true;
        // Check for Unix/Linux/macOS absolute paths
        if (val.startsWith("/")) return true;
        // Check for Windows absolute paths (C:/, D:\, etc.)
        if (/^[a-zA-Z]:[/\\]/.test(val)) return true;
        return false;
      },
      { message: "file_output must be an absolute path" }
    ).describe("Absolute path to save the image file, including the desired file extension (e.g., /path/to/image.png). If multiple images are generated (n > 1), an index will be appended (e.g., /path/to/image_1.png)."),
  }).refine(
    (data) => {
      if (data.output !== "file_output") return true;
      if (typeof data.file_output !== "string") return false;
      // Check for Unix/Linux/macOS absolute paths
      if (data.file_output.startsWith("/")) return true;
      // Check for Windows absolute paths (C:/, D:\, etc.)
      if (/^[a-zA-Z]:[/\\]/.test(data.file_output)) return true;
      return false;
    },
    { message: "file_output must be an absolute path when output is 'file_output'", path: ["file_output"] }
  );

  // Use ._def.schema.shape to get the raw shape for server.tool due to Zod refinements
  server.tool(
    "create-image",
    (createImageSchema as any)._def.schema.shape,
    async (args, _extra) => {
      // If AZURE_OPENAI_API_KEY is defined, use the AzureOpenAI class
      const openai = process.env.AZURE_OPENAI_API_KEY ? new AzureOpenAI() : new OpenAI();

      const {
        prompt,
        background,
        model = "gpt-image-1",
        moderation,
        n,
        output_compression,
        output_format,
        quality,
        size,
        user,
        output = "base64",
        file_output: file_outputRaw,
      } = args;
      const file_output: string | undefined = file_outputRaw;

      if (model === "gpt-image-2" && background === "transparent") {
        throw new Error("gpt-image-2 does not support transparent backgrounds.");
      }

      if (background === "transparent" && output_format && !["png", "webp"].includes(output_format)) {
        throw new Error("If background is 'transparent', output_format must be 'png' or 'webp'");
      }

      validateSize(size, model);

      const imageParams: any = {
        prompt,
        model,
        ...(background && model === "gpt-image-1" ? { background } : {}),
        ...(moderation ? { moderation } : {}),
        ...(n ? { n } : {}),
        ...(output_format ? { output_format } : {}),
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(user ? { user } : {}),
      };
      if (
        typeof output_compression !== "undefined" &&
        output_format &&
        ["webp", "jpeg"].includes(output_format)
      ) {
        imageParams.output_compression = output_compression;
      }

      const result = await openai.images.generate(imageParams);

      const images = (result.data ?? []).map((img: any) => ({
        b64: img.b64_json,
        mimeType: output_format === "jpeg" ? "image/jpeg" : output_format === "webp" ? "image/webp" : "image/png",
        ext: output_format === "jpeg" ? "jpg" : output_format === "webp" ? "webp" : "png",
      }));

      // Auto-switch to file_output if total base64 size exceeds 1MB
      const MAX_RESPONSE_SIZE = 1048576; // 1MB
      const totalBase64Size = images.reduce((sum, img) => sum + Buffer.byteLength(img.b64, "base64"), 0);
      let effectiveOutput = output;
      let effectiveFileOutput = file_output;
      if (output === "base64" && totalBase64Size > MAX_RESPONSE_SIZE) {
        effectiveOutput = "file_output";
        if (!file_output) {
          // Use /tmp or MCP_HF_WORK_DIR if set
          const tmpDir = process.env.MCP_HF_WORK_DIR || "/tmp";
          const unique = Date.now();
          effectiveFileOutput = path.join(tmpDir, `openai_image_${unique}.${images[0]?.ext ?? "png"}`);
        }
      }

      if (effectiveOutput === "file_output") {
        const fs = await import("fs/promises");
        const path = await import("path");
        // If multiple images, append index to filename
        const basePath = effectiveFileOutput!;
        const responses = [];
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          let filePath = basePath;
          if (images.length > 1) {
            const parsed = path.parse(basePath);
            filePath = path.join(parsed.dir, `${parsed.name}_${i + 1}.${img.ext ?? "png"}`);
          } else {
            // Ensure correct extension
            const parsed = path.parse(basePath);
            filePath = path.join(parsed.dir, `${parsed.name}.${img.ext ?? "png"}`);
          }
          await fs.writeFile(filePath, Buffer.from(img.b64, "base64"));
          responses.push({ type: "text", text: `Image saved to: file://${filePath}` });
        }
        return { content: responses };
      } else {
        // Default: base64
        return {
          content: images.map((img) => ({
            type: "image",
            data: img.b64,
            mimeType: img.mimeType,
          })),
        };
      }
    }
  );

  // Zod schema for edit-image tool input
  const absolutePathCheck = (val: string | undefined) => {
    if (!val) return true;
    // Check for Unix/Linux/macOS absolute paths
    if (val.startsWith("/")) return true;
    // Check for Windows absolute paths (C:/, D:\, etc.)
    if (/^[a-zA-Z]:[/\\]/.test(val)) return true;
    return false;
  };
  const base64Check = (val: string | undefined) => !!val && (/^([A-Za-z0-9+/=\r\n]+)$/.test(val) || val.startsWith("data:image/"));
  const imageInputSchema = z.string().refine(
    (val) => absolutePathCheck(val) || base64Check(val),
    { message: "Must be an absolute path or a base64-encoded string (optionally as a data URL)" }
  ).describe("Absolute path to an image file (png, jpg, webp < 25MB) or a base64-encoded image string.");

  // Base schema without refinement for server.tool signature
  const editImageBaseSchema = z.object({
    image: z.string().describe("Absolute image path or base64 string to edit."),
    prompt: z.string().max(32000).describe("A text description of the desired edit. Max 32000 chars."),
    mask: z.string().optional().describe("Optional absolute path or base64 string for a mask image (png < 4MB, same dimensions as the first image). Fully transparent areas indicate where to edit."),
    model: z.enum(["gpt-image-1", "gpt-image-2"]).default("gpt-image-1"),
    n: z.number().int().min(1).max(10).optional().describe("Number of images to generate (1-10)."),
    quality: z.enum(["auto", "high", "medium", "low"]).optional().describe("Quality level: auto, high, medium, or low."),
    size: z.string().optional().describe(
      "Image size. For gpt-image-1: '1024x1024', '1536x1024', '1024x1536', or 'auto'. " +
      "For gpt-image-2: any 'WxH' where both dimensions are multiples of 16, max edge 3840px, " +
      "aspect ratio up to 3:1, total pixels between 655360 and 8294400."
    ),
    user: z.string().optional().describe("Optional user identifier for OpenAI monitoring."),
    output: z.enum(["base64", "file_output"]).default("base64").describe("Output format: base64 or file path."),
    file_output: z.string().refine(absolutePathCheck, { message: "Path must be absolute" }).optional()
      .describe("Absolute path to save the output image file, including the desired file extension (e.g., /path/to/image.png). If n > 1, an index is appended."),
  });

  // Full schema with refinement for validation inside the handler
  const editImageSchema = editImageBaseSchema.refine(
    (data) => {
      if (data.output !== "file_output") return true;
      if (typeof data.file_output !== "string") return false;
      return absolutePathCheck(data.file_output);
    },
    { message: "file_output must be an absolute path when output is 'file_output'", path: ["file_output"] }
  );

  // Edit Image Tool
  server.tool(
    "edit-image",
    editImageBaseSchema.shape, // <-- Use the base schema shape here
    async (args, _extra) => {
      // Validate arguments using the full schema with refinements
      const validatedArgs = editImageSchema.parse(args);

      // Explicitly validate image and mask inputs here
      if (!absolutePathCheck(validatedArgs.image) && !base64Check(validatedArgs.image)) {
        throw new Error("Invalid 'image' input: Must be an absolute path or a base64-encoded string.");
      }
      if (validatedArgs.mask && !absolutePathCheck(validatedArgs.mask) && !base64Check(validatedArgs.mask)) {
        throw new Error("Invalid 'mask' input: Must be an absolute path or a base64-encoded string.");
      }

      const openai = process.env.AZURE_OPENAI_API_KEY ? new AzureOpenAI() : new OpenAI();
      const {
        image: imageInput,
        prompt,
        mask: maskInput,
        model = "gpt-image-1",
        n,
        quality,
        size,
        user,
        output = "base64",
        file_output: file_outputRaw,
      } = validatedArgs;
      const file_output: string | undefined = file_outputRaw;

      validateSize(size, model);

      // Helper to convert input (path or base64) to toFile
      async function inputToFile(input: string, idx = 0) {
        if (absolutePathCheck(input)) {
          // File path: infer mime type from extension
          const ext = input.split('.').pop()?.toLowerCase();
          let mime = "image/png";
          if (ext === "jpg" || ext === "jpeg") mime = "image/jpeg";
          else if (ext === "webp") mime = "image/webp";
          else if (ext === "png") mime = "image/png";
          // else default to png
          return await toFile(fs.createReadStream(input), undefined, { type: mime });
        } else {
          // Base64 or data URL
          let base64 = input;
          let mime = "image/png";
          if (input.startsWith("data:image/")) {
            // data URL
            const match = input.match(/^data:(image\/\w+);base64,(.*)$/);
            if (match) {
              mime = match[1];
              base64 = match[2];
            }
          }
          const buffer = Buffer.from(base64, "base64");
          return await toFile(buffer, `input_${idx}.${mime.split("/")[1] || "png"}`, { type: mime });
        }
      }

      // Prepare image input
      const imageFile = await inputToFile(imageInput, 0);

      // Prepare mask input
      const maskFile = maskInput ? await inputToFile(maskInput, 1) : undefined;

      // Construct parameters for OpenAI API
      const editParams: any = {
        image: imageFile,
        prompt,
        model,
        ...(maskFile ? { mask: maskFile } : {}),
        ...(n ? { n } : {}),
        ...(quality ? { quality } : {}),
        ...(size ? { size } : {}),
        ...(user ? { user } : {}),
        // response_format is not applicable (always b64_json)
      };

      const result = await openai.images.edit(editParams);

      // We need to determine the output mime type and extension based on input/defaults
      // Since OpenAI doesn't return this for edits, we'll default to png
      const images = (result.data ?? []).map((img: any) => ({
        b64: img.b64_json,
        mimeType: "image/png",
        ext: "png",
      }));

      // Auto-switch to file_output if total base64 size exceeds 1MB
      const MAX_RESPONSE_SIZE = 1048576; // 1MB
      const totalBase64Size = images.reduce((sum, img) => sum + Buffer.byteLength(img.b64, "base64"), 0);
      let effectiveOutput = output;
      let effectiveFileOutput = file_output;
      if (output === "base64" && totalBase64Size > MAX_RESPONSE_SIZE) {
        effectiveOutput = "file_output";
        if (!file_output) {
          // Use /tmp or MCP_HF_WORK_DIR if set
          const tmpDir = process.env.MCP_HF_WORK_DIR || "/tmp";
          const unique = Date.now();
          effectiveFileOutput = path.join(tmpDir, `openai_image_edit_${unique}.png`);
        }
      }

      if (effectiveOutput === "file_output") {
        if (!effectiveFileOutput) {
          throw new Error("file_output path is required when output is 'file_output'");
        }
        // Use fs/promises and path (already imported)
        const basePath = effectiveFileOutput!;
        const responses = [];
        for (let i = 0; i < images.length; i++) {
          const img = images[i];
          let filePath = basePath;
          if (images.length > 1) {
            const parsed = path.parse(basePath);
            // Append index before the original extension if it exists, otherwise just append index and .png
            const ext = parsed.ext || `.${img.ext}`;
            filePath = path.join(parsed.dir, `${parsed.name}_${i + 1}${ext}`);
          } else {
            // Ensure the extension from the path is used, or default to .png
            const parsed = path.parse(basePath);
            const ext = parsed.ext || `.${img.ext}`;
            filePath = path.join(parsed.dir, `${parsed.name}${ext}`);
          }
          await fs.promises.writeFile(filePath, Buffer.from(img.b64, "base64"));
          // Workaround: Return file path as text
          responses.push({ type: "text", text: `Image saved to: file://${filePath}` });
        }
        return { content: responses };
      } else {
        // Default: base64
        return {
          content: images.map((img) => ({
            type: "image",
            data: img.b64,
            mimeType: img.mimeType, // Should be image/png
          })),
        };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
})(); 