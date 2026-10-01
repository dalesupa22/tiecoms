/** Compatibilidad: clientes viejos cambian ownerId; los nuevos mandan toda la selección. */
export function normalizeAssignees(input: { ownerId?: string | null; assigneeIds?: string[] }, fallback: string[]): string[] {
  if (input.assigneeIds !== undefined) return [...new Set(input.assigneeIds)];
  if (input.ownerId !== undefined) return input.ownerId ? [input.ownerId] : [];
  return [...fallback];
}
