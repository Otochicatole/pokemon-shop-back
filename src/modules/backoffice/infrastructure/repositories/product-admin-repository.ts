import type { ProductAdminRepository } from '../../application/ports.js';
import type { AdminActor, ProductListQuery, ProductPatch, ProductWrite } from '../../domain/admin-cms.js';

export class ProductAdminRepositoryAdapter implements ProductAdminRepository {
  public constructor(private readonly source: ProductAdminRepository) {}
  listProducts(query: ProductListQuery) { return this.source.listProducts(query); }
  getProduct(id: string) { return this.source.getProduct(id); }
  createProduct(actor: AdminActor, input: ProductWrite) { return this.source.createProduct(actor, input); }
  updateProduct(actor: AdminActor, id: string, input: ProductPatch) { return this.source.updateProduct(actor, id, input); }
  setProductStatus(actor: AdminActor, id: string, expectedVersion: number, status: 'PUBLISHED' | 'ARCHIVED') { return this.source.setProductStatus(actor, id, expectedVersion, status); }
  addProductImages(actor: AdminActor, productId: string, expectedVersion: number, files: readonly { id: string; altText?: string }[], options?: { prepend?: boolean }) { return this.source.addProductImages(actor, productId, expectedVersion, files, options); }
  updateProductImage(actor: AdminActor, productId: string, imageId: string, expectedVersion: number, altText: string | null) { return this.source.updateProductImage(actor, productId, imageId, expectedVersion, altText); }
  reorderProductImages(actor: AdminActor, productId: string, expectedVersion: number, imageIds: readonly string[]) { return this.source.reorderProductImages(actor, productId, expectedVersion, imageIds); }
  retireProductImage(actor: AdminActor, productId: string, imageId: string, expectedVersion: number) { return this.source.retireProductImage(actor, productId, imageId, expectedVersion); }
}
