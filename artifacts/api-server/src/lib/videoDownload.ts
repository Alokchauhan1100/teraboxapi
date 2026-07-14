import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TeraboxError } from "./terabox";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);

// MTProto bots can upload up to ~2GB; leave a little headroom under that.
const MAX_DIRECT_SEND_BYTES = 1.9 * 1024 * 1024 * 1024;

export function isVideoFilename(name: string): boolean {
  return /\.(mp4|mkv|mov|avi|webm|m4v|3gp|flv|ts)$/i.test(name);
}

export function isImageFilename(name: string): boolean {
  return /\.(jpg|jpeg|png|gif|webp|bmp|tiff?)$/i.test(name);
}

function sanitizeFilename(name: string): string {
  return name.replace(/[/\\]/g, "_").slice(0, 200) || "video";
}

export interface DownloadedFile {
  filePath: string;
  dir: string;
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Fetches a TeraBox signed dlink server-side into a temp file.
 *
 * TeraBox's CDN validates both the signed URL parameters AND the session
 * cookie from the account that generated the link. A bare fetch without the
 * Cookie header returns HTTP 403 / error_code 31045 even though the URL
 * itself is correctly signed. We must pass TERABOX_COOKIE on every request.
 */
export async function downloadToTempFile(url: string, filename: string): Promise<DownloadedFile> {
  const dir = await mkdtemp(path.join(tmpdir(), "terabox-dl-"));
  const filePath = path.join(dir, sanitizeFilename(filename));

  const cookie = process.env.TERABOX_COOKIE ?? "";
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Referer: "https://www.terabox.com/",
  };
  if (cookie) headers["Cookie"] = cookie;

  let res: Response;
  try {
    res = await fetch(url, { redirect: "follow", headers });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new TeraboxError(
      `Could not reach TeraBox to download the file: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok || !res.body) {
    let bodyText = "";
    try {
      bodyText = (await res.text()).slice(0, 300);
    } catch {
      // ignore
    }
    await rm(dir, { recursive: true, force: true });
    throw new TeraboxError(
      `TeraBox refused the direct file download (HTTP ${res.status}). ${bodyText}`,
    );
  }

  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength && contentLength > MAX_DIRECT_SEND_BYTES) {
    await rm(dir, { recursive: true, force: true });
    throw new TeraboxError(
      `This file is ${(contentLength / (1024 * 1024 * 1024)).toFixed(2)}GB, too large to upload directly via Telegram (limit ~1.9GB).`,
    );
  }

  try {
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(filePath));
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new TeraboxError(
      `Download from TeraBox was interrupted: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { filePath, dir };
}

/** Grabs a single frame ~1s in as a JPEG thumbnail. Returns null if ffmpeg fails. */
export async function generateThumbnail(videoPath: string): Promise<string | null> {
  const thumbPath = `${videoPath}.thumb.jpg`;
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-ss",
      "00:00:01.000",
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=320:-1",
      thumbPath,
    ]);
    return thumbPath;
  } catch (err) {
    logger.warn({ err }, "ffmpeg thumbnail generation failed, sending without a thumbnail");
    return null;
  }
}

export async function cleanupTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
