import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@driftmark/db';

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      // `read:org` is what lets driftmark enumerate the org's repositories.
      authorization: { params: { scope: 'read:user user:email read:org' } },
    }),
  ],
  session: { strategy: 'database' },
  pages: { signIn: '/' },
});
