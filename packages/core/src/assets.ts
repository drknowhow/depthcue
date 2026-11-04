import type { Scene } from "./types.ts";

export interface AssetRef {
  /** JSON pointer to the field inside the scene file. */
  path: string;
  /** The deck-relative file it names, for example `assets/chart.svg`. */
  asset: string;
}

/**
 * Every asset a scene names, with where it names it: its background picture, image files, clip sources and posters,
 * and source files.
 */
export function assetRefs(scene: Scene): AssetRef[] {
  const refs: AssetRef[] = [];
  const background = scene.background?.asset;
  if (background) refs.push({ path: "/background/asset", asset: background });
  scene.blocks.forEach((block, i) => {
    if (block.type === "image") refs.push({ path: `/blocks/${i}/asset`, asset: block.asset });
    if (block.type === "clip") {
      refs.push({ path: `/blocks/${i}/source`, asset: block.source });
      if (block.poster) refs.push({ path: `/blocks/${i}/poster`, asset: block.poster });
    }
  });
  scene.sources?.forEach((source, i) => {
    if (source.asset) refs.push({ path: `/sources/${i}/asset`, asset: source.asset });
  });
  return refs;
}

/** The distinct asset files a scene names, in path order. */
export function assetsOf(scene: Scene): string[] {
  return [...new Set(assetRefs(scene).map((ref) => ref.asset))].sort();
}
