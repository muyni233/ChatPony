export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function errorResponse(error: unknown): Response {
  const known = error instanceof AppError;
  if (!known)
    console.error(
      '[ChatPony] Request failed',
      error instanceof Error ? error.name : 'Unknown error',
    );
  return Response.json(
    {
      error: {
        code: known ? error.code : 'INTERNAL_ERROR',
        message: known ? error.message : '服务器暂时无法完成请求，请稍后重试。',
      },
    },
    {
      status: known ? error.status : 500,
      headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    },
  );
}

export function ensure(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new AppError(status, code, message);
}
