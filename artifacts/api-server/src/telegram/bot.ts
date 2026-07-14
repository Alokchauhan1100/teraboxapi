import { Bot, InlineKeyboard, InputFile } from "grammy";
import { logger } from "../lib/logger";
import {
  resolveShare,
  resolveDownload,
  downloadDlinkViaBrowser,
  checkCookieHealth,
  TeraboxError,
  type TeraboxNode,
} from "../lib/terabox";
import { isMtprotoConfigured, sendVideoDirect } from "../lib/telegramClient";
import {
  cleanupTempDir,
  generateThumbnail,
  isVideoFilename,
  isImageFilename,
} from "../lib/videoDownload";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TERABOX_URL_RE =
  /https?:\/\/[^\s]*(1024tera|terabox|terasharefile|1024terabox|teraboxurl|4funbox|momerybox|teraboxapp)[^\s]*/i;

const MAX_FILES_SHOWN = 20;
const SUPPORTED_DOMAINS = [
  "terabox.com",
  "1024tera.com",
  "terasharefile.com",
  "1024terabox.com",
  "teraboxurl.com",
  "4funbox.com",
  "momerybox.com",
  "teraboxapp.com",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FlatFile {
  fsId: string;
  label: string;
  size: number;
}

interface Session {
  url: string;
  title: string;
  files: FlatFile[];
}

// ---------------------------------------------------------------------------
// In-memory state
// ---------------------------------------------------------------------------

const sessions = new Map<number, Session>();
// Tracks which users currently have a download running (prevents double-tap)
const activeDownloads = new Set<number>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function flattenForDisplay(nodes: TeraboxNode[], prefix = ""): FlatFile[] {
  const out: FlatFile[] = [];
  for (const node of nodes) {
    const label = prefix ? `${prefix}/${node.name}` : node.name;
    if (node.isDir) {
      out.push(...flattenForDisplay(node.children ?? [], label));
    } else {
      out.push({ fsId: node.fsId, label, size: node.size });
    }
  }
  return out;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex++;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function progressBar(current: number, total: number, width = 10): string {
  const filled = Math.round((current / total) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function buildFileKeyboard(session: Session): InlineKeyboard {
  const kb = new InlineKeyboard();
  const shown = session.files.slice(0, MAX_FILES_SHOWN);
  shown.forEach((file, idx) => {
    const icon = isVideoFilename(file.label) ? "🎬" : isImageFilename(file.label) ? "🖼️" : "📄";
    kb.text(`${icon} ${file.label} (${formatSize(file.size)})`, `f:${idx}`).row();
  });
  if (session.files.length > 1) {
    kb.text(`📦 Download all (${session.files.length} files)`, "all").row();
  }
  return kb;
}

/**
 * Download one file via Playwright and send it to Telegram.
 * Returns "sent" if delivered directly into chat, "linked" if only a link was sent.
 */
async function downloadAndSend(
  bot: Bot,
  chatId: number,
  shareUrl: string,
  file: FlatFile,
  statusMsgId: number | null,
): Promise<"sent" | "linked"> {
  const editStatus = async (text: string) => {
    if (!statusMsgId) return;
    await bot.api.editMessageText(chatId, statusMsgId, text).catch(() => {});
  };

  let target: { url: string; isZip: boolean; filename: string };
  try {
    target = await resolveDownload(shareUrl, [file.fsId], file.label);
  } catch (err) {
    const msg = err instanceof TeraboxError ? err.message : "Could not resolve this file.";
    await editStatus(`⚠️ ${file.label}: ${msg}`);
    return "linked";
  }

  let downloaded: { filePath: string; dir: string } | null = null;
  try {
    await editStatus(`⬇️ Downloading "${target.filename}"…`);
    downloaded = await downloadDlinkViaBrowser(target.url, target.filename);

    if (isVideoFilename(target.filename) && isMtprotoConfigured()) {
      await editStatus(`⬆️ Uploading "${target.filename}" to Telegram…`);
      const thumbPath = await generateThumbnail(downloaded.filePath);
      await sendVideoDirect({
        chatId,
        filePath: downloaded.filePath,
        thumbPath,
        fileName: target.filename,
        caption: target.filename,
      });
      if (statusMsgId) await bot.api.deleteMessage(chatId, statusMsgId).catch(() => {});
      return "sent";
    }

    await editStatus(`⬆️ Uploading "${target.filename}" to Telegram…`);
    if (isImageFilename(target.filename)) {
      await bot.api.sendPhoto(chatId, new InputFile(downloaded.filePath, target.filename), {
        caption: target.filename,
      });
    } else if (isVideoFilename(target.filename)) {
      await bot.api.sendVideo(chatId, new InputFile(downloaded.filePath, target.filename), {
        caption: target.filename,
      });
    } else {
      await bot.api.sendDocument(chatId, new InputFile(downloaded.filePath, target.filename), {
        caption: target.filename,
      });
    }
    if (statusMsgId) await bot.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    return "sent";
  } catch (err) {
    logger.warn({ err, filename: target?.filename }, "Direct send failed, falling back to link");
    await bot.api
      .sendMessage(
        chatId,
        `✅ *${target.filename}*\n\n[Download link](${target.url})\n\n_Link expires shortly — download promptly._`,
        { parse_mode: "Markdown", link_preview_options: { is_disabled: true } },
      )
      .catch(() => {});
    if (statusMsgId) await bot.api.deleteMessage(chatId, statusMsgId).catch(() => {});
    return "linked";
  } finally {
    if (downloaded) await cleanupTempDir(downloaded.dir);
  }
}

// ---------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------

export function startTelegramBot(): Bot | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.warn("TELEGRAM_BOT_TOKEN not set — Telegram bot disabled.");
    return null;
  }

  const bot = new Bot(token);

  // ── /start ──────────────────────────────────────────────────────────────
  bot.command("start", async (ctx) => {
    const name = ctx.from?.first_name ?? "there";
    await ctx.reply(
      `👋 *Hi ${name}\\!*\n\n` +
        `I'm a *TeraBox Downloader Bot*\\. Send me any TeraBox share link and I'll:\n\n` +
        `🎬 Send videos directly into Telegram\n` +
        `🖼️ Send photos directly into Telegram\n` +
        `📄 Send any other files as documents\n` +
        `📦 Download all files from a share at once\n\n` +
        `*Supported domains:*\n` +
        SUPPORTED_DOMAINS.map((d) => `• \`${d}\``).join("\n") +
        `\n\n*Commands:*\n` +
        `/start \\- Show this message\n` +
        `/help \\- Usage guide\n` +
        `/status \\- Check bot & cookie health\n\n` +
        `Just paste a TeraBox link to get started\\!`,
      { parse_mode: "MarkdownV2" },
    );
  });

  // ── /help ───────────────────────────────────────────────────────────────
  bot.command("help", async (ctx) => {
    await ctx.reply(
      `*How to use this bot:*\n\n` +
        `1\\. Copy a TeraBox share link \\(any supported domain\\)\n` +
        `2\\. Paste it here\n` +
        `3\\. The bot shows all files in the share\n` +
        `4\\. Tap a file to download it directly into Telegram\n` +
        `5\\. Or tap *📦 Download all* to get every file sent one by one\n\n` +
        `*File limits:*\n` +
        `• Videos via MTProto: up to \\~1\\.9 GB\n` +
        `• Images/docs via Bot API: up to 50 MB\n` +
        `• Larger files: a direct download link is sent instead\n\n` +
        `*Troubleshooting:*\n` +
        `• Links expire quickly — download promptly after receiving them\n` +
        `• If downloads fail, use /status to check if the cookie is still valid\n` +
        `• Private shares \\(require login\\) are not supported`,
      { parse_mode: "MarkdownV2" },
    );
  });

  // ── /status ─────────────────────────────────────────────────────────────
  bot.command("status", async (ctx) => {
    const msg = await ctx.reply("🔍 Checking bot status…");
    try {
      const health = await checkCookieHealth();
      const cookieIcon = health.valid ? "✅" : "❌";
      const mtproto = isMtprotoConfigured() ? "✅ Configured" : "⚠️ Not configured \\(videos sent via Bot API\\)";
      const uptime = Math.floor(process.uptime());
      const h = Math.floor(uptime / 3600);
      const m = Math.floor((uptime % 3600) / 60);
      const s = uptime % 60;
      const uptimeStr = `${h}h ${m}m ${s}s`;

      await ctx.api.editMessageText(
        msg.chat.id,
        msg.message_id,
        `*Bot Status*\n\n` +
          `${cookieIcon} *TeraBox Cookie:* ${health.valid ? "Valid ✓" : "Invalid ✗"}\n` +
          `📋 ${health.reason.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&")}\n\n` +
          `🤖 *MTProto:* ${mtproto}\n` +
          `⏱️ *Uptime:* ${uptimeStr}`,
        { parse_mode: "MarkdownV2" },
      );
    } catch (err) {
      await ctx.api
        .editMessageText(msg.chat.id, msg.message_id, "❌ Could not check status.")
        .catch(() => {});
    }
  });

  // ── Incoming share links ─────────────────────────────────────────────────
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    const match = text.match(TERABOX_URL_RE);
    if (!match) {
      await ctx.reply(
        "❓ That doesn't look like a TeraBox link\\. Send me a share URL like:\n`https://terasharefile.com/s/xxxxx`",
        { parse_mode: "MarkdownV2" },
      );
      return;
    }
    const url = match[0];
    const status = await ctx.reply("🔍 Resolving share link…");
    try {
      const { title, tree } = await resolveShare(url);
      const files = flattenForDisplay(tree);
      if (files.length === 0) {
        await ctx.api.editMessageText(
          status.chat.id,
          status.message_id,
          "⚠️ This share doesn't contain any downloadable files.",
        );
        return;
      }
      sessions.set(ctx.chat.id, { url, title, files });
      const totalSize = files.reduce((sum, f) => sum + f.size, 0);
      const truncated = files.length > MAX_FILES_SHOWN ? `\n_Showing first ${MAX_FILES_SHOWN} of ${files.length} files_` : "";
      await ctx.api.editMessageText(
        status.chat.id,
        status.message_id,
        `📁 *${title}*\n${files.length} file(s) · ${formatSize(totalSize)} total\n\nChoose what to download:${truncated}`,
        {
          parse_mode: "Markdown",
          reply_markup: buildFileKeyboard({ url, title, files }),
        },
      );
    } catch (err) {
      const message =
        err instanceof TeraboxError ? err.message : "❌ Could not resolve this share link. Make sure it's public and not expired.";
      logger.error({ err }, "Telegram: failed to resolve share");
      await ctx.api.editMessageText(status.chat.id, status.message_id, message).catch(() => {});
    }
  });

  // ── Button callbacks ─────────────────────────────────────────────────────
  bot.on("callback_query:data", async (ctx) => {
    const chatId = ctx.chat?.id ?? -1;
    const session = sessions.get(chatId);
    if (!session) {
      await ctx.answerCallbackQuery({
        text: "⏰ Session expired — resend the share link.",
      }).catch(() => {});
      return;
    }

    // Prevent concurrent downloads per user
    if (activeDownloads.has(chatId)) {
      await ctx.answerCallbackQuery({
        text: "⏳ A download is already in progress. Please wait.",
        show_alert: true,
      }).catch(() => {});
      return;
    }

    await ctx.answerCallbackQuery({ text: "⏳ Preparing…" }).catch((err) => {
      logger.warn({ err }, "answerCallbackQuery failed (stale query)");
    });

    const data = ctx.callbackQuery.data;
    activeDownloads.add(chatId);

    try {
      // ── Download ALL files one-by-one ──────────────────────────────────
      if (data === "all") {
        const files = session.files;
        const status = await ctx.reply(
          `📦 *Downloading all ${files.length} file(s)…*\n${progressBar(0, files.length)} 0/${files.length}`,
          { parse_mode: "Markdown" },
        );
        let sent = 0;
        let linked = 0;

        for (let i = 0; i < files.length; i++) {
          const file = files[i]!;
          const progressMsg = await ctx.api
            .sendMessage(chatId, `⏳ *File ${i + 1}/${files.length}:* ${file.label}`, { parse_mode: "Markdown" })
            .catch(() => null);

          const result = await downloadAndSend(bot, chatId, session.url, file, progressMsg?.message_id ?? null);
          if (result === "sent") sent++;
          else linked++;

          // Update the top progress bar
          await ctx.api
            .editMessageText(
              chatId,
              status.message_id,
              `📦 *Downloading all ${files.length} file(s)…*\n${progressBar(i + 1, files.length)} ${i + 1}/${files.length}`,
              { parse_mode: "Markdown" },
            )
            .catch(() => {});
        }

        const summary =
          sent === files.length
            ? `✅ All ${files.length} file(s) sent directly into Telegram!`
            : sent > 0
              ? `✅ Done! ${sent} file(s) sent directly · ${linked} download link(s) sent above.`
              : `✅ Done! ${linked} download link(s) sent above _(links expire soon — download promptly)_.`;

        await ctx.api
          .editMessageText(chatId, status.message_id, summary, { parse_mode: "Markdown" })
          .catch(() => {});
        return;
      }

      // ── Download a single file ──────────────────────────────────────────
      if (data.startsWith("f:")) {
        const idx = Number(data.slice(2));
        const file = session.files[idx];
        if (!file) {
          await ctx.answerCallbackQuery({ text: "File not found — resend the share link." }).catch(() => {});
          return;
        }

        const status = await ctx.reply(`⏳ Preparing *${file.label}*…`, { parse_mode: "Markdown" });

        const target = await resolveDownload(session.url, [file.fsId], file.label).catch((err) => {
          const msg = err instanceof TeraboxError ? err.message : "❌ Could not prepare this download.";
          logger.error({ err }, "Telegram: failed to resolve download");
          ctx.api.editMessageText(chatId, status.message_id, msg).catch(() => {});
          return null;
        });
        if (!target) return;

        if (!target.isZip && (isVideoFilename(target.filename) || isImageFilename(target.filename))) {
          let downloaded: { filePath: string; dir: string } | null = null;
          try {
            await ctx.api.editMessageText(chatId, status.message_id, `⬇️ Downloading *${target.filename}*…`, { parse_mode: "Markdown" });
            downloaded = await downloadDlinkViaBrowser(target.url, target.filename);

            if (isVideoFilename(target.filename) && isMtprotoConfigured()) {
              await ctx.api.editMessageText(chatId, status.message_id, `⬆️ Uploading *${target.filename}* to Telegram…`, { parse_mode: "Markdown" });
              const thumbPath = await generateThumbnail(downloaded.filePath);
              await sendVideoDirect({
                chatId,
                filePath: downloaded.filePath,
                thumbPath,
                fileName: target.filename,
                caption: target.filename,
              });
              await ctx.api.deleteMessage(chatId, status.message_id).catch(() => {});
              return;
            }

            await ctx.api.editMessageText(chatId, status.message_id, `⬆️ Uploading *${target.filename}*…`, { parse_mode: "Markdown" });
            if (isImageFilename(target.filename)) {
              await ctx.api.sendPhoto(chatId, new InputFile(downloaded.filePath, target.filename), { caption: target.filename });
            } else {
              await ctx.api.sendVideo(chatId, new InputFile(downloaded.filePath, target.filename), { caption: target.filename });
            }
            await ctx.api.deleteMessage(chatId, status.message_id).catch(() => {});
            return;
          } catch (directErr) {
            logger.warn({ err: directErr, filename: target.filename }, "Direct send failed, falling back to link");
          } finally {
            if (downloaded) await cleanupTempDir(downloaded.dir);
          }
        }

        // Fallback: send the raw link
        await ctx.api
          .editMessageText(
            chatId,
            status.message_id,
            `✅ *${target.filename}*\n\n[Download link](${target.url})\n\n_Link expires shortly — download promptly._`,
            { parse_mode: "Markdown", link_preview_options: { is_disabled: true } },
          )
          .catch(() => {});
        return;
      }

      await ctx.answerCallbackQuery().catch(() => {});
    } finally {
      activeDownloads.delete(chatId);
    }
  });

  bot.catch((err) => {
    logger.error({ err: err.error }, "Telegram bot error");
  });

  bot.start({ onStart: () => logger.info("Telegram bot started (long polling)") });

  return bot;
}
