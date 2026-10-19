/** Error that is safe to show to a client (no secrets, no upstream bodies). */
export class AddonError extends Error {
  constructor(
    message: string,
    public readonly status = 500,
    public readonly code = "internal_error",
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "AddonError";
  }
}
