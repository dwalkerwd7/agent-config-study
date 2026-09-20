import { Octokit } from 'octokit';
import { loadEnv } from './env.js';

const env = loadEnv();

/** Octokit instance for a PAT or a GitHub App installation token. */
export function createOctokit(token?: string): Octokit {
  const auth = token ?? env.GITHUB_TOKEN;
  if (!auth) {
    throw new Error('No GitHub token available. Set GITHUB_TOKEN or pass an installation token.');
  }
  return new Octokit({ auth });
}
