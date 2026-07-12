export class AudioScheduleGate {
  private graph: object | null = null;
  private revision: number | null = null;

  shouldSchedule(graph: object, revision: number): boolean {
    if (this.graph === graph && this.revision === revision) return false;
    this.graph = graph;
    this.revision = revision;
    return true;
  }

  release(graph: object): void {
    if (this.graph !== graph) return;
    this.graph = null;
    this.revision = null;
  }
}
