export const PRIMARY_SURFACE_LIMIT = 3;

export function partitionPrimary<T>(items: readonly T[]): { primary: T[]; supporting: T[] } {
  return {
    primary: items.slice(0, PRIMARY_SURFACE_LIMIT),
    supporting: items.slice(PRIMARY_SURFACE_LIMIT)
  };
}
