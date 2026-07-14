import { Router, type IRouter, type Request, type Response } from "express";
import {
  ResolveTeraboxShareBody,
  ResolveTeraboxShareResponse,
  CreateTeraboxDownloadLinkBody,
  CreateTeraboxDownloadLinkResponse,
  GetTeraboxCookieStatusResponse,
} from "@workspace/api-zod";
import { resolveShare, resolveDownload, checkCookieHealth, TeraboxError } from "../lib/terabox";

const router: IRouter = Router();

function countFiles(tree: { isDir: boolean; size: number; children?: any[] | null }[]): {
  fileCount: number;
  totalSize: number;
} {
  let fileCount = 0;
  let totalSize = 0;
  for (const node of tree) {
    if (node.isDir) {
      const nested = countFiles(node.children ?? []);
      fileCount += nested.fileCount;
      totalSize += nested.totalSize;
    } else {
      fileCount += 1;
      totalSize += node.size;
    }
  }
  return { fileCount, totalSize };
}

router.post("/terabox/resolve", async (req: Request, res: Response): Promise<void> => {
  const parsed = ResolveTeraboxShareBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const { title, tree } = await resolveShare(parsed.data.url);
    const { fileCount, totalSize } = countFiles(tree);
    req.log.info({ fileCount }, "Resolved terabox share");
    res.json(ResolveTeraboxShareResponse.parse({ title, fileCount, totalSize, tree }));
  } catch (err) {
    if (err instanceof TeraboxError) {
      req.log.warn({ err: err.message }, "Failed to resolve terabox share");
      res.status(err.status).json({ error: err.message });
      return;
    }
    req.log.error({ err }, "Unexpected error resolving terabox share");
    res.status(502).json({ error: "Could not resolve this share link." });
  }
});

router.post(
  "/terabox/download-link",
  async (req: Request, res: Response): Promise<void> => {
    const parsed = CreateTeraboxDownloadLinkBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    try {
      const target = await resolveDownload(
        parsed.data.url,
        parsed.data.fsIds,
        parsed.data.filename,
      );
      req.log.info({ isZip: target.isZip }, "Created terabox download link");
      res.json(
        CreateTeraboxDownloadLinkResponse.parse({
          downloadUrl: target.url,
          isZip: target.isZip,
        }),
      );
    } catch (err) {
      if (err instanceof TeraboxError) {
        req.log.warn({ err: err.message }, "Failed to create terabox download link");
        res.status(err.status).json({ error: err.message });
        return;
      }
      req.log.error({ err }, "Unexpected error creating terabox download link");
      res.status(502).json({ error: "Could not prepare this download." });
    }
  },
);

/**
 * GET /api/terabox/cookie-status
 *
 * Lightweight diagnostic endpoint. Returns whether the TERABOX_COOKIE
 * session is currently valid. Call this whenever users report error_code
 * 31045 on their device — a failed check confirms the cookie is the problem,
 * not an IP restriction or a bad share link.
 */
router.get("/terabox/cookie-status", async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await checkCookieHealth();
    req.log.info({ valid: result.valid }, "TeraBox cookie status check");
    res.status(result.valid ? 200 : 503).json(GetTeraboxCookieStatusResponse.parse(result));
  } catch (err) {
    req.log.error({ err }, "Unexpected error checking cookie health");
    res.status(500).json({ valid: false, reason: "Internal error while checking cookie status." });
  }
});

export default router;
