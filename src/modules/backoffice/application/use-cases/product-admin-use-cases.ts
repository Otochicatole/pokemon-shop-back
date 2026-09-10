import type { ProductAdminRepository } from '../ports.js';
import type { AdminActor, ProductListQuery, ProductPatch, ProductWrite } from '../../domain/admin-cms.js';

export class ProductAdminUseCases {
  public constructor(private readonly products: ProductAdminRepository) {}

  list(query: ProductListQuery) { return this.products.listProducts(query); }
  get(id: string) { return this.products.getProduct(id); }
  create(actor: AdminActor, input: ProductWrite) { return this.products.createProduct(actor, input); }
  update(actor: AdminActor, id: string, input: ProductPatch) { return this.products.updateProduct(actor, id, input); }
  changeStatus(actor: AdminActor, id: string, expectedVersion: number, status: 'PUBLISHED' | 'ARCHIVED') {
    return this.products.setProductStatus(actor, id, expectedVersion, status);
  }
  addImages(actor: AdminActor, id: string, expectedVersion: number, files: readonly { id: string; altText?: string }[], options?: { prepend?: boolean }) {
    return this.products.addProductImages(actor, id, expectedVersion, files, options);
  }
  updateImage(actor: AdminActor, id: string, imageId: string, expectedVersion: number, altText: string | null) {
    return this.products.updateProductImage(actor, id, imageId, expectedVersion, altText);
  }
  reorderImages(actor: AdminActor, id: string, expectedVersion: number, imageIds: readonly string[]) {
    return this.products.reorderProductImages(actor, id, expectedVersion, imageIds);
  }
  retireImage(actor: AdminActor, id: string, imageId: string, expectedVersion: number) {
    return this.products.retireProductImage(actor, id, imageId, expectedVersion);
  }
}
