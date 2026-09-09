import type { DashboardReader } from '../../application/ports.js';

export class DashboardReaderAdapter implements DashboardReader {
  public constructor(private readonly source: DashboardReader) {}
  dashboard(range: 'TODAY' | '7D' | '30D') { return this.source.dashboard(range); }
}
