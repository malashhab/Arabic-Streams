import { z } from "zod";

// Response shapes from the Stremio addon protocol; used to validate what we send before sending it.

export const metaPreviewSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1),
  poster: z.string().url().optional(),
  background: z.string().url().optional(),
  description: z.string().optional(),
  releaseInfo: z.string().optional(),
  genres: z.array(z.string()).optional(),
});
export const catalogResponseSchema = z.object({ metas: z.array(metaPreviewSchema), cacheMaxAge: z.number().optional() });

export const videoSchema = z.object({
  id: z.string(),
  title: z.string(),
  released: z.string(),
  season: z.number().int().optional(),
  episode: z.number().int().optional(),
  overview: z.string().optional(),
  thumbnail: z.string().url().optional(),
});
export const metaResponseSchema = z.object({
  meta: metaPreviewSchema.extend({ videos: z.array(videoSchema).optional(), links: z.array(z.object({ name: z.string(), category: z.string(), url: z.string() })).optional() }).passthrough(),
  cacheMaxAge: z.number().optional(),
});

// A stream must carry exactly one of: url, ytId, infoHash, externalUrl
export const streamSchema = z
  .object({
    url: z.string().url().optional(),
    externalUrl: z.string().url().optional(),
    ytId: z.string().optional(),
    infoHash: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    behaviorHints: z.object({ notWebReady: z.boolean().optional(), bingeGroup: z.string().optional(), filename: z.string().optional(), videoSize: z.number().optional() }).optional(),
  })
  .refine((s) => [s.url, s.externalUrl, s.ytId, s.infoHash].filter(Boolean).length === 1, "a stream needs exactly one of url/externalUrl/ytId/infoHash");
export const streamResponseSchema = z.object({ streams: z.array(streamSchema), cacheMaxAge: z.number().optional() });

export type Stream = z.infer<typeof streamSchema>;
