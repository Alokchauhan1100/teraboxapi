import { TelegramClient, Api } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { logger } from "./logger";

// MTProto client (GramJS) logged in as the same bot as the grammy Bot API
// instance. Bots authenticated over MTProto can upload files up to ~2GB,
// well beyond the Bot API's 50MB cap — this is what lets us send full
// videos directly instead of just handing back a link.
let clientPromise: Promise<TelegramClient> | null = null;

export function isMtprotoConfigured(): boolean {
  return Boolean(
    process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH && process.env.TELEGRAM_BOT_TOKEN,
  );
}

async function getClient(): Promise<TelegramClient> {
  if (!clientPromise) {
    const apiId = Number(process.env.TELEGRAM_API_ID);
    const apiHash = process.env.TELEGRAM_API_HASH ?? "";
    const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
    if (!apiId || !apiHash || !botToken) {
      throw new Error("TELEGRAM_API_ID, TELEGRAM_API_HASH, or TELEGRAM_BOT_TOKEN is not configured.");
    }
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 3,
    });
    clientPromise = client
      .start({ botAuthToken: botToken })
      .then(() => {
        logger.info("MTProto Telegram client connected");
        return client;
      })
      .catch((err) => {
        clientPromise = null;
        throw err;
      });
  }
  return clientPromise;
}

export interface SendVideoDirectOptions {
  chatId: number;
  filePath: string;
  thumbPath?: string | null;
  fileName: string;
  caption?: string;
}

export async function sendVideoDirect(opts: SendVideoDirectOptions): Promise<void> {
  const client = await getClient();
  await client.sendFile(opts.chatId, {
    file: opts.filePath,
    thumb: opts.thumbPath ?? undefined,
    caption: opts.caption,
    attributes: [new Api.DocumentAttributeFilename({ fileName: opts.fileName })],
    forceDocument: false,
    supportsStreaming: true,
  });
}

export async function shutdownTelegramClient(): Promise<void> {
  if (!clientPromise) return;
  try {
    const client = await clientPromise;
    await client.destroy();
  } catch (err) {
    logger.warn({ err }, "Error shutting down MTProto Telegram client");
  }
  clientPromise = null;
}
