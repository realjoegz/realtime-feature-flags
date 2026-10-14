import { Controller, Get, UnauthorizedException } from '@nestjs/common';
import { Access } from '../auth/access.js';
import { CurrentUser } from '../auth/request-auth.js';
import { TenantDatabase, type UserMembership } from '../database/tenant-database.js';

export interface Me {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly memberships: readonly UserMembership[];
}

@Controller()
export class MeController {
  constructor(private readonly db: TenantDatabase) {}

  /** The signed-in user and the tenants the user belongs to, with the role in each. */
  @Get('me')
  @Access('signed-in')
  async me(@CurrentUser() userId: string): Promise<Me> {
    // With no tenant set, row-level security shows only the user's own row.
    const user = await this.db.withUser(userId, async (client) => {
      const { rows } = await client.query<{ id: string; email: string; name: string }>(
        'SELECT id, email, name FROM public.users WHERE id = $1',
        [userId],
      );
      return rows[0];
    });
    // The guard found this user a moment ago; one deleted since then is signed out.
    if (user === undefined) throw new UnauthorizedException();
    return { ...user, memberships: await this.db.membershipsOf(userId) };
  }
}
