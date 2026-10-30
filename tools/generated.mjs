/** Paths whose content differs between two snapshots, or that exist in only one. Both are Maps of path to text. */
export function staleFiles(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths].filter((path) => before.get(path) !== after.get(path)).sort();
}
