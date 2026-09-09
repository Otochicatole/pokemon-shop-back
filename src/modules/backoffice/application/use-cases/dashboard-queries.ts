import type { DashboardReader } from '../ports.js';
import type { DashboardDto } from '../dtos.js';

export class DashboardQueries {
  public constructor(
    private readonly reader: DashboardReader,
    private readonly integrations: DashboardDto['integrations'],
  ) {}

  async get(range: 'TODAY' | '7D' | '30D'): Promise<DashboardDto> {
    return { ...await this.reader.dashboard(range), integrations: this.integrations };
  }
}
