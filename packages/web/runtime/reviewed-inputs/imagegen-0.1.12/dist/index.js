// src/index.ts
import { tool } from "@opencode-ai/plugin";

// src/auth.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { xdgData } from "xdg-basedir";
async function loadAuthData() {
  if (process.env.OPENCODE_AUTH_CONTENT) {
    return JSON.parse(process.env.OPENCODE_AUTH_CONTENT);
  }
  if (!xdgData) {
    throw new Error("could not determine XDG data directory");
  }
  const raw = await fs.readFile(path.join(xdgData, "opencode", "auth.json"), "utf-8");
  return JSON.parse(raw);
}
async function loadOpenAIAuth() {
  try {
    const data = await loadAuthData();
    const entry = data.openai;
    if (entry?.type === "oauth" && typeof entry.access === "string") {
      return entry;
    }
  } catch {
    return;
  }
  return;
}

// src/codex.ts
import { EventSourceParserStream } from "eventsource-parser/stream";
var CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
var SUBSCRIPTION_MODEL = "gpt-5.5";
async function parseImageGenerationResultFromSSE(stream) {
  const events = stream.pipeThrough(new TextDecoderStream).pipeThrough(new EventSourceParserStream);
  for await (const event of events) {
    if (event.data === "[DONE]")
      continue;
    try {
      const json = JSON.parse(event.data);
      if (json.type === "response.output_item.done" && json.item?.type === "image_generation_call" && typeof json.item.result === "string" && json.item.result.length > 0) {
        return json.item.result;
      }
    } catch {}
  }
  throw new Error("no image_generation result returned by codex backend");
}
async function callViaCodexResponses(auth, args, inputImageDataUrls) {
  const userContent = [{ type: "input_text", text: args.prompt }];
  for (const dataUrl of inputImageDataUrls) {
    userContent.push({ type: "input_image", image_url: dataUrl });
  }
  const body = {
    model: SUBSCRIPTION_MODEL,
    instructions: "You are an image generation assistant running inside the Codex backend. " + "Always satisfy the request by invoking the image_generation tool exactly once. " + "Do not respond with text only.",
    input: [{ role: "user", content: userContent }],
    tools: [
      {
        type: "image_generation",
        output_format: "png",
        quality: args.quality,
        ...args.size ? { size: args.size } : {}
      }
    ],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false
  };
  const res = await fetch(CODEX_RESPONSES_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${auth.access}`,
      ...auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {},
      originator: "opencode",
      Accept: "text/event-stream"
    },
    body: JSON.stringify(body)
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`codex responses request failed: ${res.status} ${detail.slice(0, 500)}`);
  }
  return parseImageGenerationResultFromSSE(res.body);
}

// src/input-image.ts
import * as fs2 from "node:fs/promises";
import * as path2 from "node:path";
import { fileTypeFromBuffer } from "file-type";
async function readImageAsDataUrl(filePath, ctxDir) {
  const abs = path2.isAbsolute(filePath) ? filePath : path2.resolve(ctxDir, filePath);
  const buf = await fs2.readFile(abs);
  const detected = await fileTypeFromBuffer(buf);
  if (!detected?.mime.startsWith("image/")) {
    throw new Error(`unsupported image file type: ${abs}`);
  }
  return `data:${detected.mime};base64,${buf.toString("base64")}`;
}
async function readReferenceImages(paths, ctxDir) {
  return Promise.all((paths ?? []).map((p) => readImageAsDataUrl(p, ctxDir)));
}

// src/output-image.ts
import * as fs3 from "node:fs/promises";
import * as path3 from "node:path";
var MAX_OUTPUT_VERSION_SUFFIX = 999;
async function pathExists(p) {
  try {
    await fs3.access(p);
    return true;
  } catch {
    return false;
  }
}
async function pickNonOverwritePath(requested, maxVersion = MAX_OUTPUT_VERSION_SUFFIX) {
  if (!await pathExists(requested))
    return requested;
  const dir = path3.dirname(requested);
  const ext = path3.extname(requested);
  const stem = path3.basename(requested, ext);
  for (let n = 2;n <= maxVersion; n++) {
    const candidate = path3.join(dir, `${stem}-v${n}${ext}`);
    if (!await pathExists(candidate))
      return candidate;
  }
  throw new Error(`could not find a non-conflicting filename under ${dir}/${stem}-vN${ext} (tried up to v${maxVersion})`);
}
function buildSavedMessage(savedPath, requestedPath) {
  const versionNote = savedPath !== requestedPath ? ` (the requested path ${requestedPath} already existed; the new image was versioned to avoid overwriting it)` : "";
  return `Generated image saved to ${savedPath}${versionNote}.`;
}
async function saveGeneratedImage(out, ctxDir, base64) {
  const requestedPath = path3.isAbsolute(out) ? out : path3.resolve(ctxDir, out);
  await fs3.mkdir(path3.dirname(requestedPath), { recursive: true });
  const savedPath = await pickNonOverwritePath(requestedPath);
  await fs3.writeFile(savedPath, Buffer.from(base64, "base64"));
  return {
    savedPath,
    versioned: savedPath !== requestedPath,
    message: buildSavedMessage(savedPath, requestedPath)
  };
}

// src/index.ts
var GptImagePlugin = async (_input) => {
  return {
    tool: {
      gpt_imagegen: tool({
        description: [
          "Generate raster images using OpenAI's hosted image_generation tool.",
          "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
          "Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.",
          "Reference images may be attached through `images`; label each image's role inline in `prompt`, for example: 'Image 1: reference image'.",
          "For many distinct assets, invoke gpt_imagegen once per requested asset rather than relying on multi-image output; gpt_imagegen returns one image per call.",
          "Requires OpenCode to be authenticated with ChatGPT OAuth. Returns the absolute path of the saved PNG."
        ].join(" "),
        args: {
          prompt: tool.schema.string().describe("Description of the image to generate."),
          out: tool.schema.string().describe("Output file path, relative to the project directory unless absolute. The plugin writes a PNG."),
          quality: tool.schema.enum(["low", "medium", "high", "auto"]).describe("Generation quality passed to the hosted image_generation tool."),
          size: tool.schema.string().optional().describe("Optional image size passed to the hosted image_generation tool. Use `auto` or `WIDTHxHEIGHT`; width and height must be multiples of 16px, max edge <= 3840px, long-to-short ratio <= 3:1, and total pixels between 655,360 and 8,294,400."),
          images: tool.schema.array(tool.schema.string()).optional().describe("Optional reference image paths, relative to the project directory unless absolute.")
        },
        async execute(args, ctx) {
          const auth = await loadOpenAIAuth();
          if (!auth) {
            throw new Error("OpenAI ChatGPT OAuth credentials not configured.");
          }
          const inputImageDataUrls = await readReferenceImages(args.images, ctx.directory);
          const base64 = await callViaCodexResponses(auth, args, inputImageDataUrls);
          const { savedPath, versioned, message } = await saveGeneratedImage(args.out, ctx.directory, base64);
          return {
            output: message,
            metadata: {
              out: savedPath,
              versioned,
              billing: "subscription"
            }
          };
        }
      })
    }
  };
};
var src_default = {
  id: "opencode-gpt-imagegen",
  server: GptImagePlugin
};
export {
  src_default as default
};
