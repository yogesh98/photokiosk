import nodemailer from "nodemailer";
import type { SendMailOptions, SentMessageInfo } from "nodemailer";
import {
  beginSessionEmail,
  finishSessionEmail,
  getGmailCredentials,
  readMedia,
  StudioError,
  validateEmail,
} from "./studio-store";

type MailResult = Pick<SentMessageInfo, "accepted" | "rejected">;
type MailTransport = {
  verify: () => Promise<unknown>;
  sendMail: (mail: SendMailOptions) => Promise<MailResult>;
  close: () => void;
};
type TransportFactory = (
  credentials: Awaited<ReturnType<typeof getGmailCredentials>>,
) => MailTransport;

const gmailTransport: TransportFactory = (credentials) =>
  nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user: credentials.email, pass: credentials.appPassword },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  });

function sendError(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "EAUTH")
    return "Gmail sign-in failed. Check the sender address and Google app password in Admin.";
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS"].includes(code || ""))
    return "Gmail could not be reached. Check the internet connection, then retry.";
  if (code === "EENVELOPE")
    return "Gmail did not accept this email address. Check the recipient and try again.";
  return "Gmail did not confirm sending. Check the sender's Sent folder before retrying.";
}

function ensureAccepted(result: MailResult) {
  if (
    !Array.isArray(result.accepted) ||
    result.accepted.length === 0 ||
    (Array.isArray(result.rejected) && result.rejected.length)
  ) {
    throw Object.assign(new Error("Recipient rejected"), { code: "EENVELOPE" });
  }
}

export async function sendSessionEmail(
  id: string,
  email: unknown,
  factory: TransportFactory = gmailTransport,
) {
  const session = await beginSessionEmail(id, email);
  if (session.status === "sent") return session;
  let transport: MailTransport | undefined;
  try {
    const credentials = await getGmailCredentials();
    transport = factory(credentials);
    const attachments = await Promise.all(
      session.photos.map(async (url, index) => ({
        filename: `photo-booth-${index + 1}.jpg`,
        contentType: "image/jpeg",
        content: await readMedia(url.replace("/api/media/", "").split("/")),
      })),
    );
    const result = await transport.sendMail({
      from: { name: credentials.senderName, address: credentials.email },
      to: session.email!,
      subject: credentials.subject || "Your photo booth photos",
      text: credentials.message,
      attachments,
    });
    ensureAccepted(result);
    return await finishSessionEmail(id);
  } catch (error) {
    const message = sendError(error);
    const failed = await finishSessionEmail(id, message);
    throw Object.assign(new StudioError(message, 502), { session: failed });
  } finally {
    transport?.close();
  }
}

export async function sendTestEmail(
  emailInput: unknown,
  factory: TransportFactory = gmailTransport,
) {
  const email = validateEmail(emailInput);
  const credentials = await getGmailCredentials();
  if (!credentials.configured)
    throw new StudioError(
      "Save a sender email and Gmail app password first.",
      422,
    );
  let transport: MailTransport | undefined;
  try {
    transport = factory(credentials);
    await transport.verify();
    const result = await transport.sendMail({
      from: { name: credentials.senderName, address: credentials.email },
      to: email,
      subject: "Your photo booth is connected",
      text: "Your Gmail connection is working. Your photo booth is ready to email guests their photos.",
    });
    ensureAccepted(result);
    return { success: true, message: `Test email sent to ${email}.` };
  } catch (error) {
    throw new StudioError(sendError(error), 502);
  } finally {
    transport?.close();
  }
}
