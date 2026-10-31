import type { Api } from './api';
import { UserFacingError } from './errors';

type StopResult = { sessionId: string; generation: number; stopped: true };
type RequestApi = Pick<Api, 'base' | 'session' | 'request'>;
const stopFailure = 'Audio is stopped on this iPhone, but Mia may still be working. Check your connection and try Stop Mia again.';

export class AssistantControl {
  private pending?: { base: string; token?: string; sessionId: string; preserveVoice: boolean; result: Promise<StopResult> };

  stop(api: RequestApi, sessionId: string, preserveVoice = false): Promise<StopResult> {
    if (this.matches(api, sessionId) && this.pending!.preserveVoice === preserveVoice) return this.pending!.result;
    const previous = this.matches(api, sessionId) ? this.pending!.result.catch(() => undefined) : undefined;
    const request = () => api.request<StopResult>(`/v1/assistant/sessions/${sessionId}/stop`, 'POST', preserveVoice ? { preserveVoice: true } : {});
    const result = (previous ? previous.then(request) : request()).then(value => {
      if (value?.stopped !== true || value.sessionId !== sessionId || !Number.isSafeInteger(value.generation) || value.generation < 0) {
        throw new UserFacingError(stopFailure);
      }
      return value;
    }).catch(() => { throw new UserFacingError(stopFailure); }).finally(() => {
      if (this.pending?.result === result) this.pending = undefined;
    });
    this.pending = { base: api.base, token: api.session?.token, sessionId, preserveVoice, result };
    return result;
  }

  async beforeTurn(api: RequestApi, sessionId: string) {
    // A new turn must not overtake an older in-flight stop. A new request itself
    // supersedes earlier work, so it can still proceed after a failed stop.
    if (this.matches(api, sessionId)) await this.pending!.result.catch(() => undefined);
  }

  private matches(api: RequestApi, sessionId: string) {
    return this.pending?.base === api.base && this.pending.token === api.session?.token && this.pending.sessionId === sessionId;
  }
}
