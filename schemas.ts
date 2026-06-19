/**
 * blog-engine — Zod schemas validating the wire DTOs from `ports.ts` at the
 * boundary. HttpSource/FileSource run external JSON through these before it
 * reaches the engine, so a malformed signal/facts payload fails loud at the
 * seam instead of corrupting the pipeline.
 */
import { z } from "zod";

const SignalItemSchema = z.object({
  title: z.string().min(1),
  summary: z.string(),
  entities: z.array(z.string()),
  date: z.string().optional(),
  url: z.string().optional(),
  weight: z.number().optional(),
  meta: z.record(z.string(), z.unknown()).optional(), // ← two-arg form (Zod 4)
});
export const DiscoverySignalSchema = z.object({
  items: z.array(SignalItemSchema),
  framing: z.string().optional(),
  corpus: z.string().optional(),
});
const FactSchema = z.object({
  claim: z.string().min(1),
  value: z.union([z.string(), z.number()]).optional(),
  source: z.string().min(1),
  url: z.string().optional(),
  entity: z.string().optional(),
});
export const GroundingFactsSchema = z.object({ facts: z.array(FactSchema) });
export const CoveredTopicsSchema = z.array(
  z.object({
    title: z.string(),
    slug: z.string().optional(),
    entities: z.array(z.string()).optional(),
    date: z.string().optional(),
  }),
);
export const parseSignal = (r: unknown) => DiscoverySignalSchema.parse(r);
export const parseFacts = (r: unknown) => GroundingFactsSchema.parse(r);
export const parseCovered = (r: unknown) => CoveredTopicsSchema.parse(r);
