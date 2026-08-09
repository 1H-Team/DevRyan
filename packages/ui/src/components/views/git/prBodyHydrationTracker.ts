export type PrBodyHydrationRequest = {
  key: string;
  id: number;
};

export class PrBodyHydrationTracker {
  private nextId = 0;
  private active: PrBodyHydrationRequest | null = null;

  begin(key: string): PrBodyHydrationRequest {
    const request = { key, id: ++this.nextId };
    this.active = request;
    return request;
  }

  settle(request: PrBodyHydrationRequest): boolean {
    if (this.active?.id !== request.id || this.active.key !== request.key) {
      return false;
    }
    this.active = null;
    return true;
  }

  cancel(request: PrBodyHydrationRequest): boolean {
    return this.settle(request);
  }
}
