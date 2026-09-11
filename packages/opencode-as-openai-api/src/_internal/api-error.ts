export class ApiError extends Error {
  readonly status: number;
  readonly type: string;
  readonly param: string | null;
  readonly code: string | null;

  constructor(
    status: number,
    message: string,
    type = "invalid_request_error",
    param: string | null = null,
    code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
    this.param = param;
    this.code = code;
  }
}
