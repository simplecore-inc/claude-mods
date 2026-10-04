import type { Locale } from './shared/locale'

export { resolveLocale, WEEKDAYS } from './shared/locale'
export type { Locale } from './shared/locale'

const en = {
  addGuide: [
    'To add an account:',
    '1. The account you use now is already saved.',
    '2. Log in to the other account with `/login`.',
    '3. Within a minute of logging in, the new account is saved automatically.',
  ].join('\n'),
  paneTitle: 'SimpleCORE',
  paneOpened: 'Opened the SimpleCORE workspace.',
  noAccounts: 'No saved accounts.',
  noAccountsYet: 'No saved accounts yet. Reading the current login.',
  noMatch: (query: string) => `No saved account matches "${query}".`,
  unknownVerb: (verb: string) => `Unknown subcommand: ${verb}`,
  saved: (email: string) => `Saved the ${email} account`,
  switched: (email: string) => `Switched to ${email}. Running sessions use it from their next request.`,
  removed: (email: string) => `Removed the ${email} account.`,
  cannotRemoveLive: 'The account in use cannot be removed.',
  noStoredLogin: 'No saved login for this account. Log in to it again.',
  authExpired: 'Login expired. Log in to this account again.',
  noLogin: 'not logged in',
  active: 'active',
  activeTag: ' [active]',
  resets: (when: string) => `resets ${when}`,
  loading: 'loading',
  now: 'now',
  refreshButton: 'Refresh',
  refreshingButton: 'Refreshing',
  addButton: 'Add account',
  closeButton: 'Close',
  bandShown: 'The status band above the prompt is shown.',
  bandHidden: 'The status band above the prompt is hidden.',
  bandUsage: 'Usage: /sc:accounts band on|off',
  release: (version: string, date?: string) => (date ? `v${version} (${date})` : `v${version}`),
}

export type Messages = typeof en

const ko: Messages = {
  addGuide: [
    '계정 추가 방법:',
    '1. 지금 계정은 이미 저장되어 있습니다.',
    '2. `/login`으로 추가할 계정에 로그인해 주세요.',
    '3. 로그인을 마치면 1분 안에 새 계정을 자동으로 저장합니다.',
  ].join('\n'),
  paneTitle: 'SimpleCORE',
  paneOpened: 'SimpleCORE 작업 공간을 열었습니다.',
  noAccounts: '저장된 계정이 없습니다.',
  noAccountsYet: '저장된 계정이 없습니다. 지금 로그인 정보를 읽는 중입니다.',
  noMatch: query => `"${query}"에 해당하는 저장된 계정이 없습니다.`,
  unknownVerb: verb => `알 수 없는 명령입니다: ${verb}`,
  saved: email => `${email} 계정을 저장했습니다`,
  switched: email => `${email} 계정으로 전환했습니다. 실행 중인 세션은 다음 요청부터 이 계정을 사용합니다.`,
  removed: email => `${email} 계정을 제거했습니다.`,
  cannotRemoveLive: '사용 중인 계정은 제거할 수 없습니다.',
  noStoredLogin: '저장된 로그인이 없습니다. 이 계정으로 다시 로그인해 주세요.',
  authExpired: '인증이 만료됐습니다. 이 계정으로 다시 로그인해 주세요.',
  noLogin: '로그인 없음',
  active: '활성',
  activeTag: ' [활성]',
  resets: when => `재설정 ${when}`,
  loading: '조회 중',
  now: '곧',
  refreshButton: '새로고침',
  refreshingButton: '조회 중',
  addButton: '계정 추가',
  closeButton: '닫기',
  bandShown: '입력란 위 상태 표시를 켰습니다.',
  bandHidden: '입력란 위 상태 표시를 껐습니다.',
  bandUsage: '사용법: /sc:accounts band on|off',
  release: (version, date) => (date ? `v${version} (${date})` : `v${version}`),
}

export function messagesFor(locale: Locale): Messages {
  return locale === 'ko' ? ko : en
}
