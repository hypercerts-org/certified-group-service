import { XRPCError } from '@atproto/xrpc-server'

export { AuthRequiredError as UnauthorizedError, ForbiddenError, UpstreamFailureError } from '@atproto/xrpc-server'

export class ConflictError extends XRPCError {
  constructor(errorMessage?: string, customErrorName?: string) {
    super(409 as never, errorMessage, customErrorName)
  }
}
