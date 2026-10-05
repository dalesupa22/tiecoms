import { z } from 'zod';

const integer = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().safe());
/** Opt-in: clients without limit retain the historical response and 500-task cap. */
export const IssuePageQuery = z.object({
  limit: integer.pipe(z.number().min(1).max(200)).optional(),
  offset: integer.pipe(z.number().min(0)).optional(),
}).refine((q) => q.limit !== undefined || q.offset === undefined, {
  message: 'offset requires limit', path: ['offset'],
});

export function issuePage<T>(rows: T[], limit: number, offset: number) {
  return { issues: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
}
