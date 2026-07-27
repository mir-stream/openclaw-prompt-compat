# OpenClaw 시스템 프롬프트 호환 플러그인

작성: 2026-07-23
상태: **`0.3.0` 지문 앵커 교체를 코드에 반영 완료, npm 게시 전. npm `latest`는 여전히 `0.2.0`이고
그 버전의 게시본 acceptance(install·mock outbound·live turn)까지는 완료돼 있다. setup 배포 전**
검증 기준: OpenClaw `2026.7.1` (`v2026.7.1`, commit
`2d2ddc43d0dcf71f31283d780f9fe9ff4cc04fe4`). 지문 자체는 `2026.7.2-beta.4`의 실제 렌더까지 실측으로
검증했으나(5.3), 이는 지문이 match하는 범위일 뿐이다. 지원 하한은 `>=2026.7.1` 그대로다.

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
5개 있다(`0.3.0`에서 3개에서 늘었다). 이스케이프가 없으면 `$`가 든 설정 문장이 prompt 본문 구간을
그대로 주입한다. 등록 경로와 `replaceOpenClawPromptIdentity`가 같은 이스케이프 함수를 공유한다.

## 2. 식별 지문과 구현

플러그인은 `registerTextTransforms`에 input replacement 하나만 등록한다.

```ts
const ORIGINAL_IDENTITY_PATTERN =
  "You are a personal assistant running inside OpenClaw\\.";

const markerSegment = (marker: string) =>
  `(?=([\\s\\S]*?(?<![^\\n])${marker}\\n))`;

new RegExp(
  `^${ORIGINAL_IDENTITY_PATTERN}(?=` +
    "\\n## Tooling\\n" +
    markerSegment("## Safety") + "\\1" +
    markerSegment("## Workspace") + "\\2" +
    markerSegment("## Workspace Files \\(injected\\)") + "\\3" +
    markerSegment("<!-- OPENCLAW_CACHE_BOUNDARY -->") + "\\4" +
    markerSegment("## Runtime") + "\\5" +
    ")",
);
```

치환 대상 문장이 다음 조건을 모두 만족할 때만 match한다.

1. 문자열 절대 시작에 정확한 identity 문장이 있다.
2. 바로 다음 줄이 `## Tooling`이다.
3. 뒤에 `## Safety`가 있다.
4. 그 뒤에 `## Workspace`가 자기 줄에 단독으로 있다.
5. 그 뒤에 `## Workspace Files (injected)`가 있다.
6. 그 뒤에 내부 cache boundary marker가 있다.
7. marker 뒤에 `## Runtime`이 있다.

`0.3.0`에서 앵커를 6개에서 7개로 늘리면서 유일한 산문 앵커였던 고정 Tooling preamble
(`Available tools are policy-filtered. …`)을 제거하고 `## Safety`·`## Workspace` 두 구조 앵커로
교체했다. 이제 identity 문장을 빼면 모든 앵커가 헤딩이거나 내부 marker다. 그 산문 앵커는
`2026.7.2`의 시스템 프롬프트 산문 일괄 축약으로 깨졌고, 릴리스 11개를 실측한 결과 산문 리터럴의
전 버전 생존율은 1.0%인 반면 헤딩·마커는 39.2%였다. 앵커 수가 늘어 변별력은 오히려 올라갔고, 신규
앵커 둘은 `promptMode: "minimal"`에서도 무조건 렌더된다. 측정 방법과 후보 심사는
[2026-07-27-openclaw-2026.7.2-fingerprint-survey.md](./2026-07-27-openclaw-2026.7.2-fingerprint-survey.md)에
있다.

`## Workspace`는 `## Workspace Files (injected)`의 접두사다. marker 패턴이 끝에 `\n`을 요구하므로
후자의 줄은 전자의 조건을 만족시키지 못하고, 렌더 순서상 `## Workspace`가 먼저 나오므로 lazy 탐색이
올바른 위치에서 멈춘다. 두 앵커는 서로를 대신하지 못한다. `## Safety`와 `## Workspace Files
(injected)`만 있고 `## Workspace`가 없는 입력은 reject된다.

정규식은 non-global이다. 절대 시작 anchor `^`가 exact identity가 prompt root에 있는지 확인하고, 그
뒤로 `## Tooling`부터 `## Runtime`까지의 순서를 확인한다. 따라서 prepend된 context 안에 일반적인
`identity + ## Tooling` 인용문이나 exact scaffold가 있어도 실제 prompt의 뒤쪽 marker를 빌릴 수 없다.
임의의 prefix와 OpenClaw hook `prependSystemContext`가 앞에 붙은 경우는 허용하지 않고 fail closed한다.

marker 구간들은 atomic lookahead capture 뒤 backreference로 그대로 소비한다. 실제 match span은 identity
문장 하나뿐이며 replacement도 호환 identity 한 문장이다. 이 구조는 exact scaffold나 Workspace/cache
marker를 반복한 실패 입력에서 suffix를 후보마다 다시 훑는 제곱·조합 backtracking도 막는다.

각 marker는 앞쪽 newline을 gap에 강제하지 않고 line-start lookbehind로 확인한다. 따라서 Tooling,
Safety, Workspace, Workspace Files, cache boundary, Runtime 사이에 내용이 하나도 없는 최소 prompt도
match한다.

다음 입력은 fail closed로 그대로 둔다.

- identity 문장만 있는 일반 메시지
- 문장 중간에 들어간 identity 문장
- 임의 텍스트나 hook `prependSystemContext`가 core prompt 앞에 붙은 문자열
- `promptMode: "none"`의 한 줄 prompt
- heading·공백·대소문자·marker 순서가 다른 prompt
- 필요한 heading이나 cache marker가 빠진 prompt. `## Workspace`가 없고 그 접두사를 공유하는
  `## Workspace Files (injected)`만 있는 prompt를 포함한다

## 3. 공개 API의 잔여 한계

OpenClaw `2026.7.1`의 `registerTextTransforms`는 role 정보를 주지 않는다. 등록된 input replacement는
provider-bound system prompt뿐 아니라 message content, history, tool result, tool-call argument의 문자열에도
재귀 적용될 수 있다.

따라서 이 구현의 정확한 보장은 다음과 같다.

- 일반적인 메시지에 identity 문장만 복사한 경우에는 지문이 없어 바뀌지 않는다.
- 실제 OpenClaw system prompt는 구조적 지문을 만족하므로 바뀐다.
- user/tool/history가 exact identity와 순서가 맞는 heading·marker 구조 전체를 의도적으로 복제하면
  match할 수 있다.

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
  상한은 두지 않는다. 지문이 깨진 host에서는 fail-closed로 무동작할 뿐 무해한 반면, 상한은 프롬프트
  구조가 그대로인 host에서도 설치를 막는다.
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
  "npm:@mir-stream/openclaw-prompt-compat@0.3.0" \
  --pin
```

## 5. 검증 결과

### 5.1 `0.1.0` (2026-07-23)

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

### 5.2 `0.2.0` (2026-07-27)

| 검증 | 결과 |
| --- | --- |
| identity 설정·`$` 치환 시퀀스·multi-line·잘못된 값 폴백·설정 시 지문 스코프 불변 | Node test 29개 통과 |
| TypeScript | typecheck·build 통과 |
| npm artifact | 8 files, 8.0 kB, unpacked 25,423 B, source/test 제외 |
| npm registry | `@mir-stream/openclaw-prompt-compat@0.2.0` public 게시, shasum `2e511ba20ab43f15d024767459c4d0ba0b18f136`, `latest` tag |
| config path 표기 | dot·bracket 양쪽 모두 `openclaw config get`으로 조회됨 |
| strict schema gate | `identitySentence`를 선언하지 않은 설치본에서는 batch `config set --dry-run`이 `must not have additional properties`로 거부 |
| OpenClaw package install | 게시된 exact `npm:` spec의 `--pin` managed install 성공, `status=loaded`·`source=npm`·`version=0.2.0` |
| 활성 module root | managed npm install 경로의 `dist/index.js`. 동일 ID local copy shadowing 아님 |
| 설정 문장 mock outbound | system 첫 줄=설정값 `You are the acceptance probe assistant.`, 원문 `inside` 부재 |
| 같은 turn user 메시지 | 원문 identity 문장을 한 줄로 포함해도 `inside` 그대로 유지 |
| 설정 없는 mock outbound | system 첫 줄=기본값 `within` (`0.1.0` 동작과 동일) |
| plugin 비활성 mock outbound | system 첫 줄=원문 `inside`로 복원 |
| Z.AI live turn | `zailive/glm-5.2`, `stopReason: stop`, 응답 `ZAI_COMPAT_OK` |
| live provider-bound system | cache trace 첫 줄=설정값 `You are the live acceptance probe assistant.`, 원문·기본 문장 모두 부재 |
| live user 메시지 | 원문 identity 한 줄을 그대로 유지 (오염 없음) |
| 비밀정보 비영속성 | 임시 config·state·log·capture에서 API key 원문 없음 |

`config set`의 value 모드 dry-run은 스키마 검증을 건너뛴다. non-interactive setup에서 잘못된 키나
미설치 버전을 조용히 기록하지 않으려면 검증이 도는 batch 모드를 쓴다.

mock outbound 검증은 임시 `HOME`·`OPENCLAW_STATE_DIR`·`OPENCLAW_CONFIG_PATH`에서 게시본을 managed
install하고, embedded runner(`agent --local`)가 local mock OpenAI-compatible endpoint로 보낸 원본
payload를 캡처해 판정했다. `agent --local`은 호출마다 새 프로세스로 플러그인을 startup 로드하므로
시나리오별 config 변경이 그대로 반영된다.

실측으로 확인된 payload 형태는 다음과 같다. system은 분할되지 않은 단일 `system` role 메시지 하나이고,
`<!-- OPENCLAW_CACHE_BOUNDARY -->`는 outbound payload에 존재하지 않는다. 캐시 경계는 전송 전에 제거되고
provider에게는 stable·dynamic이 합쳐진 하나의 system 문자열이 나간다.

live turn은 같은 격리 환경에서 provider만 실제 Z.AI로 바꿔 수행했다. API key는 process environment로만
전달했고 config에는 env를 가리키는 SecretRef만 기록했다. 검증 후 key를 unset하고 임시 파일을 지웠으며,
config·state·log·capture에 key 원문이 남지 않았음을 확인했다.

live 판정 근거는 cache trace(`OPENCLAW_CACHE_TRACE=1`)의 `stream:context` 이벤트다. `agent --json`의
`systemPromptReport`는 hash와 chars만 주고, trajectory의 `context.compiled`는 32,768자를 넘으면 통째로
버려져 첫 줄이 사라진다. cache trace의 wrapper는 모든 transform이 끝난 뒤 transport 직전에 값을 보므로
wire에 가장 가깝다. 다만 이 지점에서는 cache boundary sentinel이 아직 남아 있다(전송 직전에 제거).

`0.2.0` 게시본에 대해 미실행으로 남은 검증은 없다.

### 5.3 `0.3.0` (2026-07-27)

게시 전이다. 아래는 게시 없이 확인한 것만 기록한다.

| 검증 | 결과 |
| --- | --- |
| 신규 앵커 match·접두사 혼동·신규 앵커 순서/대소문자/줄 중간 배치 negative·기존 negative 유지 | Node test 34개 통과 (`0.2.0`은 29개) |
| TypeScript | typecheck·build 통과 |
| npm artifact | 8 files, 8.8 kB, unpacked 27,735 B, source/test 제외 |
| 실제 렌더 match | `2026.7.1`·`2026.7.2-beta.4` × {default, minimal} 네 가지 모두 새 지문에 match |
| 구 지문 대조 | `0.2.0` 지문은 `2026.7.2-beta.4` 양쪽을 reject. 파손이 재구성이 아니라 실제 렌더로 재현됨 |
| `promptMode: "none"` | 두 버전 모두 reject |
| 설정 변형 매트릭스 | 버전당 17개 변형(sandbox·provider override 전 조합·modelAlias·bootstrap·reasoningHint·tts·reactions·툴 없음·악성 marker 주입)에서 32/32 match |
| 오탐 사냥 | `contextFiles`·`workspaceNotes`·`extraSystemPrompt`·`promptContribution.stablePrefix`·`workspaceDir` 주입 경로 전부에서 치환 정상 |
| 성능 | 4.3MB 입력 0.311ms, 입력 크기에 선형 |

실제 렌더 검증은 각 OpenClaw 버전을 설치한 뒤 **프롬프트 빌더 함수를 직접 import해 렌더한 출력**을
입력으로 판정했다. 게이트웨이를 기동해 outbound 경로에서 뽑은 캡처가 아니므로, 5.1·5.2의 mock
outbound·live turn 검증과는 층위가 다르다. 빌더 렌더는 프롬프트 조립 결과를 보고, outbound 캡처는
transform 등록·적용까지 포함한 wire 값을 본다.

미실행으로 남은 검증은 다음과 같다. npm 게시, 게시본의 managed install·mock outbound acceptance,
live provider turn, `2026.7.2` GA tarball에 대한 앵커·순서 재확인.

## 6. 업스트림 지문 감시

지문이 깨지면 플러그인은 fail-closed로 무동작한다(§2). 안전하지만 조용하다. `2026.7.2`의 산문 축약은
`2026.7.2-beta.1`(07-15)에 이미 들어 있었고, 사람이 손으로 확인한 07-27에야 발견됐다. 12일이 걸렸고
`2026.7.2` CHANGELOG에는 해당 항목이 없으므로 릴리스 노트를 읽는 것으로는 감지되지 않는다
([조사 문서](./2026-07-27-openclaw-2026.7.2-fingerprint-survey.md) §3).

`.github/workflows/upstream-watch.yml`이 하루 한 번 검사한다. 대상은 npm `latest`와 `beta` 두 태그이고
`alpha`는 보지 않는다. **`beta`를 함께 보는 것이 이 장치의 핵심이다.** 위 사고에서 알 수 있었던 가장
이른 시점이 beta 게시일이었고, GA를 기다렸다면 이미 늦었다.

검사기는 `scripts/check-upstream-fingerprint.mjs`다. 순수 Node이고 의존성이 없다.
`package.json#files`에 `scripts`가 없으므로 npm 배포물에는 들어가지 않는다. 특정 버전을 인자로 주면
로컬에서도 그대로 돌아간다.

```sh
npm run build
node scripts/check-upstream-fingerprint.mjs                  # latest + beta
node scripts/check-upstream-fingerprint.mjs 2026.7.1 2026.3.24
```

**검사기가 대조하는 지문은 언제나 그 시점 리포의 지문이다.** 앵커 리터럴도 정규식도 스크립트에 다시
적지 않고 빌드된 `dist/index.js`의 export에서 읽는다 — (A)는 marker 상수
(`TOOLING_SECTION_MARKER`·`SAFETY_SECTION_MARKER`·`WORKSPACE_SECTION_MARKER`·
`WORKSPACE_FILES_SECTION_MARKER`·`SYSTEM_PROMPT_CACHE_BOUNDARY`·`RUNTIME_SECTION_MARKER`)를,
(B)는 `OPENCLAW_SYSTEM_PROMPT_FINGERPRINT`를 그대로 쓴다. 스크립트에는 앵커의 **이름 목록**만 있고
문자열 사본은 없다.

따라서 지문이 앞으로 또 바뀌어도 감시기를 함께 고칠 필요가 없다. `0.3.0`이 산문 프리앰블을
`## Safety`·`## Workspace`로 교체한 것 같은 변경은 빌드만 다시 하면 그대로 반영된다. 앵커가 추가·삭제·
개명돼 이름 목록이 맞지 않게 되면 검사기는 조용히 통과하지 않고 **오류로 멈춘다.** 과거 커밋에서
돌리면 그 커밋의 지문 기준으로 판정하므로, 지난 파손의 재현에도 그대로 쓸 수 있다(§6.1의 `0.2.0` 예).

한 가지 한계는 물려받은 것이다. `src/index.ts`는 marker 상수를 선언하면서 같은 문자열을 정규식에도
따로 적고 있고 둘 사이에 연결이 없다. 정규식만 고치면 (A)는 낡은 앵커를 검사하게 된다. 이때는 (B)가
받아낸다 — (B)는 컴파일된 정규식 자체를 실제 렌더에 돌리므로 상수와 패턴이 어긋나면 "지문이 거부한
실제 렌더"로 드러난다. 이 한계는 감시기가 만든 것이 아니고, 리터럴을 스크립트에 **세 번째로** 복사하는
것은 해법이 아니다. 사본을 늘리면 어긋남이 더 안 보이게 될 뿐이다.

이 의존 때문에 머지 순서가 정해진다. 감시기는 `0.3.0` 지문(`## Safety`·`## Workspace`)을 전제하므로
그 지문을 담은 변경이 먼저 들어가야 한다. 감시 장치 브랜치(`feat/upstream-fingerprint-watch`)는 앵커
교체 브랜치(`docs/openclaw-2026.7.2-fingerprint-survey`, PR #3) 위에 stack돼 있다. PR은 base를 후자로
잡아야 diff가 깨끗하고, **PR #3이 먼저 머지돼야 한다.** `main`(`0.2.0`) 기준으로 감시기를 돌리면
`2026.7.2-beta.4`가 정상적으로 drift로 잡힌다 — 그건 오탐이 아니라 `0.2.0` 지문의 실제 상태다(§6.1).

### 6.1 두 층으로 검사한다

강한 쪽이 못 돌아도 약한 쪽은 남도록, 바이트를 가져오는 방법부터 분리했다.

| 층 | 방법 | 잡는 것 | 실행 조건 |
| --- | --- | --- | --- |
| (A) 앵커 리터럴 존재 | `npm pack` 후 빌더 소스에서 각 앵커 문자열을 찾는다. 코드 실행 없음 | 앵커의 삭제·개작 | 항상 |
| (B) 실제 렌더 + 지문 대조 | 임시 디렉터리에 설치하고 빌더를 import해 렌더한 뒤 `OPENCLAW_SYSTEM_PROMPT_FINGERPRINT`를 돌린다 | 앵커는 다 있는데 **순서**만 바뀐 경우 | 가능할 때만 |

`2026.7.2` 사고는 (A)만으로 잡힌다. 프리앰블 리터럴이 통째로 사라졌기 때문이다. 실제로 `0.2.0` 지문으로
`2026.7.2-beta.4`를 검사하면 (A)가 다음을 보고한다.

```text
MISSING toolingPreamble "Available tools are policy-filtered. Names are case-sensitive; call exactly as listed."
          closest literal (0.538): "Tools policy-filtered. Names case-sensitive; call exact."
```

앵커가 없어졌다는 사실만으로는 대응할 수 없으므로, 빌더의 문자열 리터럴 중 사라진 앵커와 가장 닮은
것을 함께 제시한다. 위가 그 출력이고 §1의 before/after가 그대로 복원됐다.

**(B)는 반드시 격리한다.** 빌더 import에는 부작용이 있을 수 있다. `2026.2.26`·`2026.3.24`는 빌더가
monolithic CLI 번들 안에 있어 import만으로 `~/.openclaw`를 읽고 bootstrap을 돌린 뒤 throw한다
(조사 문서 §8.1). 방어는 두 겹이다. 첫째, import할 export를 `export {}` 절에서 **정적으로** 고른다.
프롬프트 빌더를 export하지 않는 번들은 애초에 import되지 않는다 — `2026.3.24`가 여기서 걸러진다.
둘째, 실제로 일어나는 import는 `HOME`을 임시 디렉터리로 바꾼 자식 프로세스에서 타임아웃과 함께 돈다.
content quorum에 맞는 파일이 여럿이면 한 후보의 import·render 실패로 멈추지 않고 뒤 후보를 계속
검사한다. 모든 후보가 실패한 경우에만, 후보별 이유를 제한된 길이로 모아 (B) 미실행으로 보고한다.
(B)의 설치가 시작되지 못하거나 timeout된 경우를 포함해, (B)가 못 돌면 "(A)만 수행됨"으로 보고하고
**drift로 취급하지 않는다.** 돌지 못한 검사는 업스트림에 대해 아무것도 말해주지 않는다.

콘솔·Markdown·Actions summary는 버전마다 어떤 검사가 실제로 돌았는지 항상 명시한다. (A)만 돌았으면
"Layer A 통과(부분 검사)"라고 쓰며 전체 지문이 일치한다고 말하지 않는다.

### 6.2 빌더 파일은 이름이 아니라 내용으로 찾는다

빌더 파일명은 조사 기간 중 세 번 바뀌었다(조사 문서 §5.1). 따라서 특정 파일명이나 개별 앵커에
의존하지 않고, 현행 앵커 리터럴 3개 이상(또는 2개와 정적으로 확인한 prompt-builder export)을 함께
가진 파일을 찾는다. identity나 `## Tooling` 자체가 사라져도 나머지 앵커로 빌더를 찾아 정상적인
drift로 보고하기 위한 조건이다. 이 quorum조차 없는 패키지만 빌더 식별 불가 오류로 취급한다.

캐시 경계 앵커에는 함정이 하나 더 있다. `2026.7.1`부터 `OPENCLAW_CACHE_BOUNDARY` 정의가
`@openclaw/ai`로 옮겨가서 **openclaw tarball만 grep하면 0건이다**(조사 문서 §8.1). 그대로 두면 정상
릴리스를 매일 drift로 신고한다. 그래서 앵커를 빌더 → 같은 패키지의 나머지 → 릴리스가 선언한
`@openclaw/*` 의존성 순으로 찾고, **어디서 찾았는지를 함께 보고한다.** 이동은 이동으로 읽혀야 한다.

```text
ok  cacheBoundary "<!-- OPENCLAW_CACHE_BOUNDARY -->"  <- @openclaw/ai@2026.7.1:dist/transform-messages-BhGF_fF4.mjs
```

### 6.3 drift는 실패가 아니다

워크플로는 drift를 발견해도 **exit 0으로 끝난다.** 스케줄 잡의 빨간 X는 결국 무시되고, 우리가 원하는
신호는 깨진 앵커가 적힌 이슈다. 반대로 **검사기 자체가 고장나면 exit 1로 실패한다** — 네트워크 실패,
tarball 손상, 빌더 식별 불가. 이때는 아무것도 검사되지 않은 것이므로 drift와는 다른, 더 나쁜 사건이다.
step summary도 "검사가 안 돌았다"와 "검사했는데 문제 없다"를 다르게 쓴다.
한 target이 실패해도 나머지 target 검사는 계속한다. 완료된 target과 실패한 target/error를 콘솔·JSON·
Markdown에 모두 남긴 뒤 전체 실행은 exit 1로 끝난다. 따라서 부분 성공의 증거는 보존되지만 publish
job은 실행되지 않는다.

권한 경계도 두 job으로 나뉜다. `check` job은 `contents: read`만 갖고 checkout credential을 남기지
않은 채 (A)/(B)를 실행해 리포트 artifact를 만든다. `issues: write`는 별도 runner의 `publish` job만
가지며, 이 job은 checkout이나 OpenClaw import를 하지 않는다. artifact의 모든 바이트는 신뢰하지
않는다. publish job이 npm `latest`·`beta`를 독립적으로 다시 조회해 정확한 버전 집합을 요구하고,
허용된 앵커 id와 render mode만 정규화한다. artifact의 title/body/digest는 버리고, 제한된 plain-text
finding에서 본문과 digest를 다시 만든 뒤 이슈 API를 호출한다. 두 조회 사이 tag가 바뀌어도 mismatch로
fail-closed한다. 같은 schedule/manual 실행이 겹쳐 중복 이슈를 만들지 않도록 workflow 전용
concurrency group도 직렬화한다.

drift가 있으면 `upstream-drift` 라벨로 이슈를 연다. 매일 도는 잡이므로 중복 방지가 필수다. 이슈 본문에
두 개의 HTML 주석 마커를 심어 상태를 이슈 자체에 보관한다. 외부 저장소도 workflow state도 쓰지 않는다.

| 마커 | 역할 |
| --- | --- |
| `version=<버전>` | 버전당 열린 이슈는 하나뿐이다. 같은 이슈가 매일 쌓이는 것을 막는다 |
| `digest=<해시>` | **어떤** 앵커가 깨졌는지를 식별한다. drift의 형태가 바뀔 때만 코멘트를 단다 |

digest는 누락된 앵커 id 집합과 match에 실패한 렌더 모드로 계산한다. 내일 같은 파손을 또 봐도 조용하고,
같은 버전에서 앵커가 하나 더 깨지면 그때 코멘트가 붙는다.

이슈 본문에는 버전, 실제로 돌아간 검사, 빌더 파일, 깨진 앵커의 before/after, 아직 살아있는 앵커 목록,
재현 명령이 들어간다. "지문이 깨졌다"만 있는 이슈는 쓸모가 없다.

### 6.4 이 장치가 덮지 않는 것

업스트림 감시는 **릴리스를 보는 것이지 사용자 환경을 보는 것이 아니다.** npm에 올라온 tarball에 대해
지문이 유효한지 판정할 뿐, 실제 설치본에서 치환이 일어났는지는 관측하지 않는다. 다음은 이 장치로
잡히지 않는다.

- 감시 대상이 아닌 버전(`alpha`, 고정된 구버전)을 쓰는 설치본
- 프롬프트 구조가 host 설정·provider override로 런타임에 달라지는 경우
- 지문은 유효한데 플러그인이 load되지 않았거나 disable된 경우

플러그인 내부에서 치환 실패를 관측하는 경로는 여전히 미해결이다. `registerTextTransforms`는 등록 시점
API이고 match 실패는 런타임 문자열마다 발생하므로 별도 설계가 필요하다(§2, 조사 문서 §10.2·§10.3).

## 7. `setup_openclaw` 통합 계약

`mir-stream/rota-crew`의 `setup_openclaw`는 다음과 같이 맞춘다.

- 기본 OpenClaw 버전과 도움말·배포 문서를 `2026.7.1`로 올린다.
- OpenClaw `2026.7.1`의 Node engine 범위를 검사한다.
- `--prompt-compat-version` 기본값은 게시된 최신 버전으로 둔다. 현재는 `0.2.0`이고, `0.3.0` 게시
  후 `0.3.0`으로 올린다. setup은 미게시 버전을 기본값으로 가리키지 않는다.
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
먼저 끝내고, 해당 version 게시 후 package install acceptance를 다시 통과시킨 뒤 배포한다. `0.2.0`은
게시와 install acceptance를 모두 마쳤고(5.2), `0.3.0`은 아직 게시 전이다(5.3).

`identitySentence`를 setup이 함께 설정한다면 순서가 중요하다. strict config schema는 해당 키를
선언한 버전이 설치되기 전에는 값을 거부하므로, `0.2.0` 이상 설치를 끝낸 뒤 config를 기록한다.

## 8. 롤백

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

## 9. 완료 조건

- [x] 독립 plugin source·manifest·build·CI가 구현됐다.
- [x] 단위 테스트와 package dry-run이 통과했다.
- [x] packed artifact가 OpenClaw `2026.7.1` managed npm 경로에서 설치·load됐다.
- [x] 실제 outbound payload에서 system 첫 줄만 바뀌고 standalone user copy는 유지됐다.
- [x] Z.AI Coding Plan live agent turn이 성공했다.
- [x] `@mir-stream/openclaw-prompt-compat@0.1.0`을 npm에 게시한다.
- [x] 게시된 npm artifact로 package acceptance를 다시 실행한다.
- [x] identity 교체 문장을 `identitySentence`로 설정 가능하게 만든다.
- [x] `@mir-stream/openclaw-prompt-compat@0.2.0`을 npm에 게시한다.
- [x] `0.2.0` 게시본으로 managed install과 mock outbound acceptance를 재실행한다.
- [x] `0.2.0` 게시본으로 live provider turn을 재확인한다.
- [x] 지문에서 산문 앵커를 제거하고 구조 앵커로 교체한다.
- [x] 업스트림 릴리스에 대한 지문 감시를 자동화한다(§6). 사용자 환경에서의 치환 실패 관측은 별건이고
      여전히 미해결이다(§6.4).
- [ ] `@mir-stream/openclaw-prompt-compat@0.3.0`을 npm에 게시한다.
- [ ] `0.3.0` 게시본으로 managed install과 mock outbound acceptance를 실행한다.
- [ ] `0.3.0` 게시본으로 live provider turn을 확인한다.
- [ ] `2026.7.2` GA tarball로 앵커·순서를 재확인한다.
- [ ] `setup_openclaw` 변경을 배포하고 새 설치·재실행·disable 보존을 확인한다.

## 10. 검토 근거

- [OpenClaw `v2026.7.1` system prompt 생성 코드](https://github.com/openclaw/openclaw/blob/v2026.7.1/src/agents/system-prompt.ts)
- [`registerTextTransforms`와 재귀 message 변환](https://github.com/openclaw/openclaw/blob/v2026.7.1/src/agents/plugin-text-transforms.ts)
- [provider system prompt transform](https://github.com/openclaw/openclaw/blob/v2026.7.1/src/plugins/provider-runtime.ts)
- [외부 plugin package 작성 계약](https://github.com/openclaw/openclaw/blob/v2026.7.1/docs/plugins/building-plugins.md)
- [Z.AI provider 설정](https://github.com/openclaw/openclaw/blob/v2026.7.1/docs/providers/zai.md)
