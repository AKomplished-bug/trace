import pino from "pino";

// Never log secrets, headers, card data or bank account details. Paths are matched at the top level and one level down.
const redactKeys = [
  "headers",
  "authorization",
  "cookie",
  "password",
  "passwordHash",
  "password_hash",
  "email",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "card_number",
  "cvc",
  "account_number",
  "accountNumber",
  "routing_number",
  "routingNumber",
  "DATABASE_URL",
  "SESSION_SECRET",
  "TRACE_OWNER_PASSWORD",
  "TRACE_OPS_PASSWORD",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "INCREASE_API_KEY",
  "INCREASE_WEBHOOK_SECRET",
];

/** The logger's redaction settings (exported for its test). */
export const REDACT = { paths: redactKeys.flatMap((key) => [key, `*.${key}`]), censor: "[redacted]" };

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: REDACT,
});

export type Logger = typeof logger;
