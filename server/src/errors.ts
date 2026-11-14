export class ApplicationError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 503,
    message = '',
  ) {
    super(message);
  }
}
