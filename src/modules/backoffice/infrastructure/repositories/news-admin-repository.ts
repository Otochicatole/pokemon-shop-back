import type { NewsAdminRepository } from '../../application/ports.js';
import type { AdminActor, NewsListQuery, NewsPatch, NewsWrite } from '../../domain/admin-cms.js';

export class NewsAdminRepositoryAdapter implements NewsAdminRepository {
  public constructor(private readonly source: NewsAdminRepository) {}
  listNews(query: NewsListQuery) { return this.source.listNews(query); }
  getNews(id: string) { return this.source.getNews(id); }
  createNews(actor: AdminActor, input: NewsWrite) { return this.source.createNews(actor, input); }
  updateNews(actor: AdminActor, id: string, input: NewsPatch) { return this.source.updateNews(actor, id, input); }
  deleteNews(actor: AdminActor, id: string, expectedVersion: number) { return this.source.deleteNews(actor, id, expectedVersion); }
}
