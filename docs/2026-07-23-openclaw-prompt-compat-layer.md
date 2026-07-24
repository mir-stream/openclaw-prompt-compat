# OpenClaw 시스템 프롬프트 호환 플러그인

작성: 2026-07-23
상태: **플러그인 구현·npm 0.1.0 게시·게시본 acceptance 완료, setup 배포 전**
검증 기준: OpenClaw `2026.7.1` (`v2026.7.1`, commit
`2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4`)

## 0. 결정

- OpenClaw 본체를 패치하지 않고 독립 npm 플러그인으로 구현한다.
- provider·model별 분기 없이 모든 embedded agent run에 같은 규칙을 적용한다.
- OpenClaw가 만든 system prompt를 식별할 수 있는 구조적 지문이 있을 때만 첫 문장을 바꾼다.
- 일반적인 user·assistant·tool 메시지와 tool-call 인자는 바뀌지 않도록 높은 변별력을 갖는 지문을
  사용한다.
- 공격자가 OpenClaw 내부 prompt 구조 전체를 의도적으로 복제한 경우까지 system prompt와 구별하는
  보안 경계는 목표로 하지 않는다. 현재 공개 API로는 그 보장이 불가능하다는 사실은 명시한다.
- 기존 `rota-approval-gate`의 코드와 배포 경로는 합치지 않는다.
- npm에 직접 게시하고 `npm:` source로 설치한다. ClawHub에는 게시하지 않는다.

구현 식별자는 다음과 같다.

| 구분 | 값 |
| --- | --- |
| GitHub 저장소 | `mir-stream/openclaw-prompt-compat` |
| npm 패키지 | `@mir-stream/openclaw-prompt-compat` |
| OpenClaw plugin ID | `openclaw-prompt-compat` |
| 최초 버전 | `0.1.0` |
| 최소 OpenClaw 버전 | `2026.7.1` |

## 1. 변경하는 문구

원인 문구는 여러 차례 비교 검증된 것으로 보고 추가 원인 A/B 실험은 구현 조건으로 두지 않는다.
변경은 다음 한 문장으로 제한한다.

```text
You are a personal assistant running inside OpenClaw.
→
You are a personal assistant running within OpenClaw.
```

provider payload 전체나 user prompt를 수정하지 않고, OpenClaw system prompt의 해당 identity span만
치환한다.

`0.2.0`부터 교체 문장은 `plugins.entries.openclaw-prompt-compat.config.identitySentence`로 설정한다.
설정 가능한 것은 "무엇으로 바꾸는가"뿐이고 지문은 그대로 고정이므로, 사용자 설정이 match 범위를
넓힐 수 없다. 설정이 없으면 기본값은 위의 `within` 문장 그대로이고 `0.1.0`과 동작이 같다. 값이
문자열이 아니거나 비었거나 2000자를 넘으면 경고를 남기고 기본값으로 폴백한다. 조용한 no-op은
이 플러그인에서 가장 진단하기 어려운 실패 모드이므로 모든 폴백에 경고를 남긴다.

설정값은 `to`에 넣기 전에 `$`를 `$$`로 이스케이프한다. `String.prototype.replace`의 replacement
문자열은 `$$`, `$&`, `` $` ``, `$'`, `$1`~`$9`를 치환 시퀀스로 해석하고 지문에는 capture group이
3개 있다. 이스케이프가 없으면 `$`가 든 설정 문장이 prompt 본문 구간을 그대로 주입한다. 등록
경로와 `replaceOpenClawPromptIdentity`가 같은 이스케이프 함수를 공유한다.

## 2. 식별 지문과 구현

플러그인은 `registerTextTransforms`에 input replacement 하나만 등록한다.

```ts
const identityPattern =
  "You are a personal assistant running inside OpenClaw\\.";
const toolingPreamble =
  "Available tools are policy-filtered\\. Names are case-sensitive; call exactly as listed\\.";

new RegExp(
  `^${identityPattern}(?=` +
    `\\n## Tooling\\n${toolingPreamble}\\n` +
    `(?=([\\s\\S]*?(?<![^\\n])## Workspace Files \\(injected\\)\\n))\\1` +
    `(?=([\\s\\S]*?(?<![^\\n])<!-- OPENCLAW_CACHE_BOUNDARY -->\\n))\\2` +
    `(?=([\\s\\S]*?(?<![^\\n])## Runtime\\n))\\3` +
    ")",
);
```

치환 대상 문장이 다음 조건을 모두 만족할 때만 match한다.

1. 문자열 절대 시작에 정확한 identity 문장이 있다.
2. 바로 다음 줄이 `## Tooling`이다.
3. 그 다음 줄이 OpenClaw 2026.7.1의 고정 문구
   `Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.`이다.
4. 뒤에 `## Workspace Files (injected)`가 있다.
5. 그 뒤에 내부 cache boundary marker가 있다.
6. marker 뒤에 `## Runtime`이 있다.

정규식은 non-global이다. 절대 시작 anchor `^`가 exact identity와 고정 Tooling preamble이 prompt
root에 있는지 확인한다. 따라서 prepend된 context 안에 일반적인 `identity + ## Tooling` 인용문이나
exact 3줄 scaffold가 있어도 실제 prompt의 뒤쪽 marker를 빌릴 수 없다. 임의의 prefix와 OpenClaw
hook `prependSystemContext`가 앞에 붙은 경우는 허용하지 않고 fail closed한다.

marker 구간들은 atomic lookahead capture 뒤 backreference로 그대로 소비한다. 실제 match span은 identity
문장 하나뿐이며 replacement도 호환 identity 한 문장이다. 이 구조는 exact scaffold나 Workspace/cache
marker를 반복한 실패 입력에서 suffix를 후보마다 다시 훑는 제곱·조합 backtracking도 막는다.

각 marker는 앞쪽 newline을 gap에 강제하지 않고 line-start lookbehind로 확인한다. 따라서 Tooling,
Workspace Files, cache boundary, Runtime 사이에 내용이 하나도 없는 최소 prompt도 match한다.

다음 입력은 fail closed로 그대로 둔다.

- identity 문장만 있는 일반 메시지
- 문장 중간에 들어간 identity 문장
- 임의 텍스트나 hook `prependSystemContext`가 core prompt 앞에 붙은 문자열
- `promptMode: "none"`의 한 줄 prompt
- 고정 Tooling preamble, heading·공백·대소문자·marker 순서가 다른 prompt
- 필요한 section이나 cache marker가 빠진 prompt

## 3. 공개 API의 잔여 한계

OpenClaw `2026.7.1`의 `registerTextTransforms`는 role 정보를 주지 않는다. 등록된 input replacement는
provider-bound system prompt뿐 아니라 message content, history, tool result, tool-call argument의 문자열에도
재귀 적용될 수 있다.

따라서 이 구현의 정확한 보장은 다음과 같다.

- 일반적인 메시지에 identity 문장만 복사한 경우에는 지문이 없어 바뀌지 않는다.
- 실제 OpenClaw system prompt는 구조적 지문을 만족하므로 바뀐다.
- user/tool/history가 exact identity, 2026.7.1 고정 Tooling preamble, 뒤쪽 marker 구조를 의도적으로
  복제하면 match할 수 있다.

마지막 경우까지 차단하려면 OpenClaw가 role-scoped system prompt transform API를 새로 제공해야 한다.
이번 요구사항은 의도적으로 위조한 내부 prompt와의 적대적 구별이 아니라 실사용에서의 안정적인 변별이므로,
현재 지문 방식을 채택한다.

## 4. 패키지 구조

배포 artifact에는 실행에 필요한 파일만 포함한다.

```text
dist/index.js
dist/index.js.map
dist/index.d.ts
dist/index.d.ts.map
openclaw.plugin.json
package.json
README.md
LICENSE
```

- manifest는 `activation.onStartup: true`와 strict config schema를 선언한다. schema는
  `identitySentence` 하나만 허용하고 `additionalProperties: false`를 유지한다.
- `package.json#openclaw.extensions`는 build된 `./dist/index.js`를 가리킨다.
- `openclaw.compat.pluginApi`와 `openclaw.build.openclawVersion`은 `2026.7.1` 계약을 명시한다.
- runtime dependency는 없다. 사용자 설정은 `identitySentence` 하나이고 선택 사항이다.
- 플러그인을 끄려면 plugin 자체를 disable한다.

게시 전 검증 명령은 다음과 같다.

```sh
npm ci
npm test
npm run typecheck
npm run build
npm pack
```

게시와 설치는 다음 exact version을 사용한다.

```sh
npm publish --access public

openclaw plugins install \
  "npm:@mir-stream/openclaw-prompt-compat@0.1.0" \
  --pin
```

## 5. 검증 결과

2026-07-23에 다음 검증을 완료했다.

| 검증 | 결과 |
| --- | --- |
| identity·고정 Tooling preamble·wrapper/decoy·partial copy·최소 gap·adversarial 성능 경계 | Node test 20개 통과 |
| TypeScript | typecheck·build 통과 |
| npm artifact | 8 files, 5.5 kB, source/test 제외 |
| npm registry | `@mir-stream/openclaw-prompt-compat@0.1.0` public 게시, shasum `87cecc4885f1acc337216404dbe003f289092f25` |
| OpenClaw package install | 게시된 exact `npm:` spec의 `--pin` managed install 성공 |
| 정확한 host | OpenClaw `2026.7.1` (`2d2ddc4`) runtime load 성공 |
| 게시본 plugin 활성 mock outbound | system=`within`, 같은 원문 user 메시지=`inside` |
| plugin 비활성 mock outbound | system·user 모두=`inside`로 복원 |
| Z.AI live Gateway turn | `zai/glm-5.2`, `status: ok`, 응답 `ZAI_COMPAT_OK` |
| Z.AI provider-bound system | cache trace 첫 줄=`within` |
| 비밀정보 비영속성 | 임시 config·state·session·trace·log에서 API key 원문 없음 |

mock outbound 검증은 실제 OpenClaw embedded runner가 OpenAI-compatible local endpoint로 보낸 payload를
캡처했다. 이 검증으로 system 첫 줄이 바뀌면서 standalone user copy는 유지되는 것을 직접 확인했다.

Z.AI 검증은 별도 임시 `HOME`, `OPENCLAW_STATE_DIR`, `OPENCLAW_CONFIG_PATH`에서 foreground Gateway를
기동해 수행했다. API key는 process environment에만 넣었고 onboarding, auth profile, config, `.env`에는
기록하지 않았다. 검증 후 Gateway를 종료하고 환경변수를 해제했다.

## 6. `setup_openclaw` 통합 계약

`mir-stream/rota-crew`의 `setup_openclaw`는 다음과 같이 맞춘다.

- 기본 OpenClaw 버전과 도움말·배포 문서를 `2026.7.1`로 올린다.
- OpenClaw `2026.7.1`의 Node engine 범위를 검사한다.
- `--prompt-compat-version` 기본값을 `0.1.0`으로 둔다.
- 미설치 상태에서만 exact npm package를 신규 설치한다.
- 설치돼 있고 명시적으로 disabled이면 update·install·enable하지 않는다.
- 설치돼 있고 enabled이면 exact pinned npm registry record로 수렴시킨다. 같은 manifest version이어도
  local·npm-pack·unpinned record이면 `--force --pin`으로 교체하고, 이미 exact 상태일 때만 건너뛴다.
- runtime inspect의 종료코드만 믿지 않고 `status=loaded`, `imported=true`와 active module
  root가 managed install path인지 함께 확인한다. config-selected 동일 ID local copy가 shadowing하면
  성공으로 처리하지 않는다.
- setup은 검증 후 Gateway를 재시작한다. 실제 agent turn 검증은 릴리스 수용 테스트에서 별도로
  수행한다.

npm package가 게시되기 전에는 이 setup 변경을 공개 배포하지 않는다. 로컬 코드 통합과 shell 검증을
먼저 끝내고, `0.1.0` 게시 후 package install acceptance를 다시 통과시킨 뒤 배포한다.

## 7. 롤백

운영 롤백은 독립 플러그인만 disable하고 Gateway를 재시작한다.

```sh
openclaw plugins disable openclaw-prompt-compat
openclaw gateway restart
```

완전 제거는 다음과 같다.

```sh
openclaw plugins uninstall openclaw-prompt-compat
```

setup 재실행은 명시적 disable을 보존한다. 완전 제거 후 setup을 다시 실행하면 관리 대상이 없다고 판단해
플러그인을 새로 설치하므로, 장기 opt-out은 uninstall이 아니라 disable로 표현한다.

## 8. 완료 조건

- [x] 독립 plugin source·manifest·build·CI가 구현됐다.
- [x] 단위 테스트와 package dry-run이 통과했다.
- [x] packed artifact가 OpenClaw `2026.7.1` managed npm 경로에서 설치·load됐다.
- [x] 실제 outbound payload에서 system 첫 줄만 바뀌고 standalone user copy는 유지됐다.
- [x] Z.AI Coding Plan live agent turn이 성공했다.
- [x] `@mir-stream/openclaw-prompt-compat@0.1.0`을 npm에 게시한다.
- [x] 게시된 npm artifact로 package acceptance를 다시 실행한다.
- [ ] `setup_openclaw` 변경을 배포하고 새 설치·재실행·disable 보존을 확인한다.

## 9. 검토 근거

- [OpenClaw `v2026.7.1` system prompt 생성 코드](https://github.com/openclaw/openclaw/blob/v2026.7.1/src/agents/system-prompt.ts)
- [`registerTextTransforms`와 재귀 message 변환](https://github.com/openclaw/openclaw/blob/v2026.7.1/src/agents/plugin-text-transforms.ts)
- [provider system prompt transform](https://github.com/openclaw/openclaw/blob/v2026.7.1/src/plugins/provider-runtime.ts)
- [외부 plugin package 작성 계약](https://github.com/openclaw/openclaw/blob/v2026.7.1/docs/plugins/building-plugins.md)
- [Z.AI provider 설정](https://github.com/openclaw/openclaw/blob/v2026.7.1/docs/providers/zai.md)
