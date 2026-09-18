import type { NewsAdminRepository } from '../ports.js';
import type { AdminActor, NewsListQuery, NewsPatch, NewsSettingsWrite, NewsWrite } from '../../domain/admin-cms.js';

export class NewsAdminUseCases {
  public constructor(private readonly news: NewsAdminRepository) {}

  list(query: NewsListQuery) { return this.news.listNews(query); }
  get(id: string) { return this.news.getNews(id); }
  create(actor: AdminActor, input: NewsWrite) { return this.news.createNews(actor, input); }
  update(actor: AdminActor, id: string, input: NewsPatch) { return this.news.updateNews(actor, id, input); }
  delete(actor: AdminActor, id: string, expectedVersion: number) { return this.news.deleteNews(actor, id, expectedVersion); }
  setCover(actor: AdminActor, id: string, expectedVersion: number, coverFileId: string) { return this.news.setNewsCover(actor, id, expectedVersion, coverFileId); }
  clearCover(actor: AdminActor, id: string, expectedVersion: number) { return this.news.clearNewsCover(actor, id, expectedVersion); }
  getSettings() { return this.news.getNewsSettings(); }
  updateSettings(actor: AdminActor, input: NewsSettingsWrite) { return this.news.updateNewsSettings(actor, input); }
}
