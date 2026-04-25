#!/usr/bin/env node
// Captures the §9 evidence screenshots requested on PAP-2268 from the
// storybook-static build. Stories cover the host-rendered surfaces (markdown
// decoration, properties pill, related-work, sidebar rollup, list-row badge,
// status matrix). Live data screenshots that require a seeded dev DB still
// have to be captured against the running app — those are listed in the PAP-2277
// completion comment.

import { createRequire } from "node:module";
const localRequire = createRequire(import.meta.url);
const { chromium } = localRequire("playwright");
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const storybookRoot = path.join(repoRoot, "ui", "storybook-static");
const outDir = path.join(repoRoot, "screenshots", "pap-2277");

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

function startStaticServer(rootDir) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
        let filePath = path.join(rootDir, urlPath === "/" ? "index.html" : urlPath);
        let stat;
        try {
          stat = await fs.stat(filePath);
        } catch {
          stat = null;
        }
        if (stat?.isDirectory()) {
          filePath = path.join(filePath, "index.html");
          stat = await fs.stat(filePath).catch(() => null);
        }
        if (!stat) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const ext = path.extname(filePath).toLowerCase();
        res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
        res.setHeader("cache-control", "no-cache");
        const data = await fs.readFile(filePath);
        res.end(data);
      } catch (err) {
        res.statusCode = 500;
        res.end(err.message);
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

const SHOTS = [
  {
    storyId: "foundations-external-objects--full-surface",
    label: "external-objects-full-surface-light-desktop",
    viewport: { width: 1440, height: 1024 },
    theme: "light",
  },
  {
    storyId: "foundations-external-objects--full-surface",
    label: "external-objects-full-surface-dark-desktop",
    viewport: { width: 1440, height: 1024 },
    theme: "dark",
  },
  {
    storyId: "foundations-external-objects--full-surface",
    label: "external-objects-full-surface-light-mobile",
    viewport: { width: 414, height: 896 },
    theme: "light",
  },
  {
    storyId: "product-chat-comments--comment-threads",
    label: "comment-thread-external-light-desktop",
    viewport: { width: 1280, height: 1400 },
    theme: "light",
  },
  {
    storyId: "product-chat-comments--comment-threads",
    label: "comment-thread-external-dark-desktop",
    viewport: { width: 1280, height: 1400 },
    theme: "dark",
  },
  {
    storyId: "product-chat-comments--comment-threads",
    label: "comment-thread-external-light-mobile",
    viewport: { width: 414, height: 1100 },
    theme: "light",
  },
  {
    storyId: "product-chat-comments--issue-chat-with-timeline",
    label: "issue-chat-thread-external-light-desktop",
    viewport: { width: 1440, height: 1400 },
    theme: "light",
  },
  {
    storyId: "product-chat-comments--issue-chat-with-timeline",
    label: "issue-chat-thread-external-dark-desktop",
    viewport: { width: 1440, height: 1400 },
    theme: "dark",
  },
  {
    storyId: "product-chat-comments--issue-chat-with-timeline",
    label: "issue-chat-thread-external-light-mobile",
    viewport: { width: 414, height: 1100 },
    theme: "light",
  },
  {
    storyId: "chat-comments-issue-thread-interactions--request-confirmation-pending",
    label: "interaction-request-confirmation-light-desktop",
    viewport: { width: 1280, height: 900 },
    theme: "light",
  },
];

async function applyTheme(page, theme) {
  await page.evaluate((t) => {
    const root = document.documentElement;
    root.classList.toggle("dark", t === "dark");
    root.style.colorScheme = t;
    document.body?.style?.setProperty("background", t === "dark" ? "#0c0a09" : "#ffffff");
  }, theme);
}

async function captureStory({ baseUrl, page, storyId, label, viewport, theme }) {
  await page.setViewportSize(viewport);
  const url = `${baseUrl}/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story&globals=theme:${theme}`;
  await page.goto(url, { waitUntil: "networkidle" });
  await applyTheme(page, theme);
  await page.waitForTimeout(800);
  const dest = path.join(outDir, `${label}.png`);
  await page.screenshot({ path: dest, fullPage: true });
  return dest;
}

async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const { server, baseUrl } = await startStaticServer(storybookRoot);
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const captured = [];
  try {
    for (const shot of SHOTS) {
      const dest = await captureStory({ baseUrl, page, ...shot });
      captured.push(path.relative(repoRoot, dest));
      console.log("captured", path.relative(repoRoot, dest));
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(JSON.stringify({ captured }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
