export class PPEError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'PPEError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
