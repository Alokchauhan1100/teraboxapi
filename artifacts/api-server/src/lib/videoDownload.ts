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

// Must be kept in sync with the constant in terabox.ts
const TERABOX_COOKIE =
  "_rdt_em=:524749a4ef54bfc9569b86103490e345bc25098846b509d4728a7b46864a9f4b,af4f2270512779c7d8f46de16a6b0fd44cfc0819785c6f8792914d10983f0f6d;lang=en;_pin_unauth=dWlkPVl6Y3hOMlJpTURVdE5UaGhNUzAwTkdOaUxXRTVNR1F0WVRVNVlqTXpOR0l3TUROaA;_ga_06ZNKL8C2E=GS2.1.s1784002935$o8$g1$t1784002965$j30$l0$h0;ndut_fmv=e3d758df00f4676b43a4865e7f4a5809c234f3b6db47308684879dd5aad9d081d5757db57d1ce5581acec62356635376aca8cf574f00570b09206f39fb71061437bc6c3cf729c634bfe8cecc2abc7c654b0ae371b27d58798bc20095d8be2599c2d7314721e8faeafcee027056f71595;_fwb=161ObiETHjpQBKpA07C186n.1782516708294;_clck=1q3tqoc%5E2%5Eg78%5E0%5E2368;_uetvid=3a239f9071b711f1aef2e1835d3d1ad5;_rdt_uuid=1782516717699.feef0039-844f-4583-b5f6-dc616a85c23b;_gcl_au=1.1.1599871936.1782516708;wcs_bt=s_59e6f409268:1783810560;ndus=YSyjrX1peHuier_j6EedkvHg3FJN-F2c_fYlwl2a;_ga=GA1.1.1677304169.1782516708;g_state={\"i_l\":1,\"i_ll\":1784002959559,\"i_b\":\"7w6GKQYcCFXKEzT4vYyFwsY5E+NjKNxp6Od00SNVJHQ\",\"i_e\":{\"enable_itp_optimization\":24},\"i_et\":1784002959559};_fbp=fb.1.1782516719970.591720822737808937;_ga_HSVH9T016H=GS2.1.s1783810561$o5$g0$t1783810561$j60$l0$h0;_uetsid=684fb5e07cf711f1a388e19d27d7b823;browserid=husPdeybDO8r4S8p-zpmK927bw1YMuzwo_UFeCHjcSrQxO46xSJqWi6HbUU=;csrfToken=p6Qh8b3KsyPXynUzM1j1lx5a;ndut_fmt=10D8437435ABFB4DC64BBA7645F7CF6A8987992FE39CA56BE859AF7C55B874D4;PANWEB=1";

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

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Referer: "https://www.terabox.com/",
    Cookie: TERABOX_COOKIE,
  };

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
