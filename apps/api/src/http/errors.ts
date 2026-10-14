import { BadRequestException, NotFoundException } from '@nestjs/common';

/**
 * The one answer for anything the caller cannot see: a tenant that does not exist,
 * a tenant the caller is not a member of, and a resource that is not in the tenant.
 * Every case gets the same status, body and headers, so a refusal does not tell
 * whether the thing exists.
 */
export function notFound(): NotFoundException {
  return new NotFoundException();
}

/** 400 with every problem found in the input. */
export function invalid(what: string, errors: readonly string[]): BadRequestException {
  return new BadRequestException({ statusCode: 400, message: `invalid ${what}`, errors });
}
