import { PrismaClient } from "@prisma/news-client";
const globalForNews = globalThis as unknown as { newsDb?: PrismaClient };
const url = process.env.NEWS_DATABASE_URL || "postgresql://unconfigured:unconfigured@127.0.0.1:1/unconfigured?schema=news&connect_timeout=2&connection_limit=1";
if (!/^postgres(?:ql)?:\/\//.test(url)) throw new Error("NEWS_DATABASE_URL must point to VPS PostgreSQL");
export const newsDb = globalForNews.newsDb ?? new PrismaClient({ datasources: { db: { url } }, log: [] });
if (process.env.NODE_ENV !== "production") globalForNews.newsDb = newsDb;
