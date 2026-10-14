import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { FLAG_KEY_PATTERN, type Flag, validateContext, validateFlag } from '@rff/core';
import { Access } from '../auth/access.js';
import { CurrentMember, type MemberScope } from '../auth/request-auth.js';
import { invalid, notFound } from '../http/errors.js';
import { type EvaluationResult, type FlagWrite, FlagsService, newSalt } from './flags.service.js';

// A placeholder that passes validateFlag's salt check and has a real salt's length,
// so the size limit counts the same bytes. PUT keeps the stored salt.
const SALT_PLACEHOLDER = '0'.repeat(16);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** POST body: the flag without its salt, which the server generates. */
function newFlag(body: unknown): Flag {
  if (!isRecord(body)) throw invalid('flag', ['flag: must be an object']);
  const errors = Object.hasOwn(body, 'salt') ? ['salt: is set by the server'] : [];
  const result = validateFlag({ ...body, salt: newSalt() });
  if (!result.ok) errors.push(...result.errors);
  if (errors.length > 0 || !result.ok) throw invalid('flag', errors);
  return result.value;
}

/** PUT body: enabled, rules and rolloutBasisPoints. The key is the path's, the salt stays. */
function flagSettings(key: string, body: unknown): Flag {
  if (!isRecord(body)) throw invalid('flag', ['flag: must be an object']);
  const errors: string[] = [];
  if (Object.hasOwn(body, 'key')) errors.push('key: is set by the path');
  if (Object.hasOwn(body, 'salt')) errors.push('salt: is set by the server and never changes');
  const result = validateFlag({ ...body, key, salt: SALT_PLACEHOLDER });
  if (!result.ok) errors.push(...result.errors);
  if (errors.length > 0 || !result.ok) throw invalid('flag', errors);
  return result.value;
}

/** A path key that no flag can have names no flag, like a key that is not there. */
function flagKey(key: string): string {
  if (!FLAG_KEY_PATTERN.test(key)) throw notFound();
  return key;
}

@Controller('tenants/:tenantId')
export class FlagsController {
  constructor(private readonly flags: FlagsService) {}

  @Get('flags')
  @Access('viewer')
  list(@CurrentMember() member: MemberScope): Promise<{ version: number; flags: readonly Flag[] }> {
    return this.flags.list(member);
  }

  @Get('flags/:flagKey')
  @Access('viewer')
  get(@CurrentMember() member: MemberScope, @Param('flagKey') key: string): Promise<Flag> {
    return this.flags.get(member, flagKey(key));
  }

  @Post('flags')
  @Access('editor')
  create(@CurrentMember() member: MemberScope, @Body() body: unknown): Promise<FlagWrite> {
    return this.flags.create(member, newFlag(body));
  }

  @Put('flags/:flagKey')
  @Access('editor')
  update(
    @CurrentMember() member: MemberScope,
    @Param('flagKey') key: string,
    @Body() body: unknown,
  ): Promise<FlagWrite> {
    const settings = flagSettings(flagKey(key), body);
    return this.flags.update(member, key, settings);
  }

  @Delete('flags/:flagKey')
  @Access('editor')
  remove(
    @CurrentMember() member: MemberScope,
    @Param('flagKey') key: string,
  ): Promise<{ version: number }> {
    return this.flags.remove(member, flagKey(key));
  }

  /** Every flag evaluated for the context in the body, at the current version. */
  @Post('evaluate')
  @HttpCode(200)
  @Access('viewer')
  evaluate(
    @CurrentMember() member: MemberScope,
    @Body() body: unknown,
  ): Promise<{ version: number; results: EvaluationResult[] }> {
    const context = validateContext(body);
    if (!context.ok) throw invalid('context', context.errors);
    return this.flags.evaluate(member, context.value);
  }
}
