// Suppress all Node.js warnings (including deprecation)
(process as any).emitWarning = () => { };

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenAI, AzureOpenAI, toFile } from "openai";
import fs from "fs";
import path from "path";
import { loadEnvFile, validateSize, absolutePathCheck, base64Check } from "./utils";
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
} from "./image-helpers";

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
      const openai = process.env.AZURE_OPENAI_API_KEY ? new AzureOpenAI() : new OpenAI();

      const {
        model = "gpt-image-1",
        background,
        output_format,
        output = "base64",
        file_output,
      } = args;

      validateCreateImageArgs({ model, background, output_format });
      validateSize(args.size, model);

      const imageParams = buildCreateImageParams({
        prompt: args.prompt,
        model,
        background,
        moderation: args.moderation,
        n: args.n,
        output_compression: args.output_compression,
        output_format,
        quality: args.quality,
        size: args.size,
        user: args.user,
      });

      const result = await openai.images.generate(imageParams as any);
      const images = mapCreateImageResponse((result.data ?? []) as any, output_format);

      const { effectiveOutput, effectiveFileOutput } = resolveOutputTarget({
        output,
        file_output: file_output as string | undefined,
        images,
        filenamePrefix: "openai_image",
        workDir: process.env.MCP_HF_WORK_DIR,
      });

      if (effectiveOutput === "file_output") {
        const filePaths = resolveFilePaths(effectiveFileOutput!, images, false);
        const responses = [];
        for (let i = 0; i < images.length; i++) {
          await fs.promises.writeFile(filePaths[i], Buffer.from(images[i].b64, "base64"));
          responses.push({ type: "text", text: `Image saved to: file://${filePaths[i]}` });
        }
        return { content: responses };
      } else {
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
    editImageBaseSchema.shape,
    async (args, _extra) => {
      const validatedArgs = editImageSchema.parse(args);

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

      async function inputToFile(input: string, idx = 0) {
        if (absolutePathCheck(input)) {
          const mime = parseMimeFromExtension(input);
          return await toFile(fs.createReadStream(input), undefined, { type: mime });
        } else {
          const { base64, mime } = parseBase64DataUrl(input);
          const buffer = Buffer.from(base64, "base64");
          return await toFile(buffer, `input_${idx}.${mime.split("/")[1] || "png"}`, { type: mime });
        }
      }

      const imageFile = await inputToFile(imageInput, 0);
      const maskFile = maskInput ? await inputToFile(maskInput, 1) : undefined;

      const editParams = buildEditImageParams({
        prompt,
        model,
        n,
        quality,
        size,
        user,
        imageFile,
        maskFile,
      });

      const result = await openai.images.edit(editParams as any);
      const images = mapEditImageResponse((result.data ?? []) as any);

      const { effectiveOutput, effectiveFileOutput } = resolveOutputTarget({
        output,
        file_output,
        images,
        filenamePrefix: "openai_image_edit",
        workDir: process.env.MCP_HF_WORK_DIR,
      });

      if (effectiveOutput === "file_output") {
        if (!effectiveFileOutput) {
          throw new Error("file_output path is required when output is 'file_output'");
        }
        const filePaths = resolveFilePaths(effectiveFileOutput, images, true);
        const responses = [];
        for (let i = 0; i < images.length; i++) {
          await fs.promises.writeFile(filePaths[i], Buffer.from(images[i].b64, "base64"));
          responses.push({ type: "text", text: `Image saved to: file://${filePaths[i]}` });
        }
        return { content: responses };
      } else {
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
