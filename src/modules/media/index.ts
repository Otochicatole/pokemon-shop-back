/** Public media boundary. */
export { createMediaRouter, discardUnattachedFile, ensureStorage, saveImage } from './media.js';
export { CleanupRetiredProductImages } from './application/retired-product-image-cleanup.js';
export type {
  CleanupDisposition,
  RetiredImageCleanupCandidate,
  RetiredImageCleanupRepository,
  RetiredImageCleanupResult,
  RetiredImageQuarantine,
} from './application/retired-product-image-cleanup.js';
export { createRetiredImageCleanup } from './infrastructure/create-retired-image-cleanup.js';
