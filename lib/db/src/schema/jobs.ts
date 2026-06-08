import { pgTable, serial, text, integer, timestamp, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobTypeEnum = pgEnum("job_type", ["extend", "transform", "evaluate", "live_extend"]);
export const jobStatusEnum = pgEnum("job_status", ["pending", "processing", "completed", "failed"]);

export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  type: jobTypeEnum("type").notNull(),
  status: jobStatusEnum("status").notNull().default("pending"),
  inputFilename: text("input_filename").notNull(),
  outputFilename: text("output_filename"),
  targetGenre: text("target_genre"),
  barsToExtend: integer("bars_to_extend"),
  evaluationResult: jsonb("evaluation_result"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, createdAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
