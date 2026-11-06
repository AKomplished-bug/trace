import pino from "pino";

// Never log secrets, headers or card data. Paths are matched at the top level and one level down.
const redactKeys = [
  "headers",
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "apiKey",
  "api_key",
  "card_number",
  "cvc",
  "DATABASE_URL",
  "SESSION_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "INCREASE_API_KEY",
  "INCREASE_WEBHOOK_SECRET",
];

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: redactKeys.flatMap((key) => [key, `*.${key}`]),
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
