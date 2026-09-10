import type { DashboardReader } from '../ports.js';
import type { DashboardDto } from '../dtos.js';

export class DashboardQueries {
  public constructor(
    private readonly reader: DashboardReader,
    private readonly integrations: DashboardDto['integrations'] | (() => Promise<DashboardDto['integrations']>),
  ) {}

  async get(range: 'TODAY' | '7D' | '30D'): Promise<DashboardDto> {
    const integrations = typeof this.integrations === 'function' ? await this.integrations() : this.integrations;
    return { ...await this.reader.dashboard(range), integrations };
  }
}
