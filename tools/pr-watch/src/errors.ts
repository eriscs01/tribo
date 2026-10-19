/* eslint-disable max-classes-per-file -- the two ways a GitHub request fails, read together */
/** GitHub asked us to wait: nothing should be sent before `untilMs` (epoch ms). */
export class RateLimitedError extends Error {
  readonly untilMs: number;

  constructor(untilMs: number) {
    super('rate_limited');
    this.untilMs = untilMs;
  }
}

/**
 * A request that failed. `code` is the only detail kept (`http_<status>`, `network`, `timeout`,
 * `bad_json`, `graphql`): GitHub's message and the fetch error can quote the request, so
 * neither is logged or rethrown.
 */
export class GitHubError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
