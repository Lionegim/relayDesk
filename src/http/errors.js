export class HttpError extends Error {
  constructor(status, message, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = msg => new HttpError(400, msg, 'bad_request');
export const notFound = (msg = 'Introuvable') => new HttpError(404, msg, 'not_found');
