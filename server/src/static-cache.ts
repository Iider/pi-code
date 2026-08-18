const HASHED_ASSET_CACHE = 'public, max-age=31536000, immutable';
const REVALIDATE_CACHE = 'no-cache';

export function cacheControlForWebAsset(filePath: string): string {
  const normalizedPath = filePath.replaceAll('\\', '/');
  const isFingerprintAsset = /\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(normalizedPath);
  return isFingerprintAsset ? HASHED_ASSET_CACHE : REVALIDATE_CACHE;
}
