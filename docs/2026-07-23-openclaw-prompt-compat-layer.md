# OpenClaw 프롬프트 호환 플러그인 — 독립 배포 설계

작성: 2026-07-23
상태: **구현 전 설계안**
검증 기준: OpenClaw `2026.6.11`

## 0. 결정

- 이 기능은 기존 `rota-approval-gate`에 합치지 않는다.
- 프롬프트 호환 기능만 담은 독립 GitHub 저장소와 독립 OpenClaw 플러그인을 만든다.
- 플러그인은 **npm에 직접 게시하고 `npm:` source로 직접 설치**한다.
- ClawHub에는 게시하지 않고 설치·업데이트 경로에서도 사용하지 않는다.
- `curl -fsSL https://dl.rotacrew.kr/setup_openclaw | bash`가 npm 플러그인을 함께 설치하도록 연결한다.
- 기존 `rota-approval-gate`의 코드와 배포 경로는 그대로 둔다.

초기 구현 작업명은 다음과 같다.

| 구분 | 이름 |
| --- | --- |
| GitHub 저장소 | `mir-stream/openclaw-prompt-compat` |
| npm 패키지 | `@rotacrew/openclaw-prompt-compat` |
| OpenClaw plugin ID | `openclaw-prompt-compat` |
| 최초 버전 | `0.1.0` |

```text
독립 GitHub 저장소 → npm publish → OpenClaw npm 설치 → setup_openclaw에 포함
```

## 1. 플러그인 동작

OpenClaw `2026.6.11`의 기본 시스템 프롬프트 첫 문장은 Z.AI Coding Plan의 GLM-5.2 endpoint에서
HTTP `429`, error code `1305`를 일으키는 것으로 재현됐다. 문장의 의미를 유지한 최소 치환으로 이를
회피한다.

```text
You are a personal assistant running inside OpenClaw.
→
You are a personal assistant running within OpenClaw.
```

구현은 `registerTextTransforms`에 input 규칙 하나를 등록하는 것이 전부다.

```ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export const promptCompatibilityInput = [{
  from: /^You are a personal assistant running inside OpenClaw\.(?=\n|$)/,
  to: "You are a personal assistant running within OpenClaw.",
}];

export default definePluginEntry({
  id: "openclaw-prompt-compat",
  name: "OpenClaw Prompt Compatibility",
  description: "Rewrites a known provider-incompatible OpenClaw prompt signature",
  register(api) {
    api.registerTextTransforms({ input: promptCompatibilityInput });
  },
});
```

- 정확한 문장으로 시작하는 문자열만 바꾼다.
- provider·model 분기, 사용자 정의 정규식, output 변환, 승인 훅은 넣지 않는다.
- 별도 설정도 두지 않는다. 끄려면 독립 플러그인 자체를 disable한다.
- API가 agent·provider·message role context를 주지 않으므로 설치된 gateway 전체에 적용된다. 이 때문에
  매치 범위를 정확한 첫 줄로 제한한다.

## 2. 독립 저장소와 npm 배포

새 저장소는 플러그인 소스, manifest, 단위 테스트, 빌드 설정, GitHub Actions만 가진다.

- npm package에는 빌드된 `dist/index.js`와 `openclaw.plugin.json`을 포함한다.
- OpenClaw 호환 범위는 `>=2026.6.11`로 선언한다.
- manifest config schema는 빈 strict object로 둔다.
- CI는 `npm test`, `npm run build`, `npm pack --dry-run`을 실행한다.
- npm 게시 전 packed tgz를 OpenClaw `2026.6.11`에 설치해 runtime load를 확인한다.

릴리스는 GitHub tag와 npm version을 맞춘 뒤 public package로 게시한다.

```sh
npm ci
npm test
npm run build
npm publish --access public
```

가능하면 GitHub Actions의 npm trusted publishing을 사용한다. ClawHub metadata나 publish 단계,
`dl.rotacrew.kr`용 plugin tgz mirror는 만들지 않는다.

직접 설치 명령은 다음과 같다.

```sh
openclaw plugins install \
  "npm:@rotacrew/openclaw-prompt-compat@0.1.0" \
  --pin --force
openclaw plugins inspect openclaw-prompt-compat --runtime --json
```

## 3. `setup_openclaw` 통합

현재 저장소에서는 `openclaw-plugin/deploy/public/setup_openclaw`와 해당 배포 문서만 수정한다.
기존 approval gate 설치 단계 옆에 다음 독립 단계를 추가한다.

```sh
local PROMPT_COMPAT_VERSION="0.1.0"

openclaw plugins install \
  "npm:@rotacrew/openclaw-prompt-compat@${PROMPT_COMPAT_VERSION}" \
  --pin --force

openclaw plugins inspect openclaw-prompt-compat --runtime --json
```

- `--prompt-compat-version <ver>` 옵션으로 exact version을 바꿀 수 있게 한다.
- 기본값은 검증된 버전으로 고정하고, 재실행 시 같은 npm package/version으로 수렴시킨다.
- `dl.rotacrew.kr`는 setup 스크립트만 제공하며 플러그인 바이트는 npm에서 받는다.
- 기존 머신도 같은 setup one-liner를 다시 실행하면 플러그인이 설치된다.
- 기존 `rota-approval-gate` 설치·검증 단계는 변경하지 않는다.

## 4. 검증

단위 테스트는 다음 경계만 고정한다.

| 입력 | 기대 |
| --- | --- |
| 정확한 문장 하나 | `inside`만 `within`으로 변경 |
| 정확한 첫 줄 + 나머지 프롬프트 | 첫 줄만 변경 |
| 앞에 다른 텍스트가 있음 | 변경 없음 |
| 공백·대소문자가 다름 | 변경 없음 |
| 다른 위치의 동일 문장 | 변경 없음 |

릴리스 전에 packed npm artifact로 아래 두 번의 실제 agent turn을 확인한다.

1. Z.AI 재현 요청이 `429/1305` 없이 성공한다.
2. 다른 provider 하나에서 기존 응답과 tool call이 깨지지 않는다.

## 5. 롤백

문제가 생기면 이 플러그인만 끄고 gateway를 재시작한다.

```sh
openclaw plugins disable openclaw-prompt-compat
openclaw gateway restart
```

완전 제거는 `openclaw plugins uninstall openclaw-prompt-compat`으로 한다. 승인 플러그인과 코드·설정을
공유하지 않으므로 롤백해도 `rota-approval-gate`에는 영향이 없다.

## 6. 완료 조건

- [ ] `mir-stream/openclaw-prompt-compat` 저장소가 생성된다.
- [ ] 단위 테스트와 packed-package smoke가 통과한다.
- [ ] `@rotacrew/openclaw-prompt-compat@0.1.0`이 npm에 게시된다.
- [ ] npm 설치본으로 Z.AI와 다른 provider의 agent turn이 통과한다.
- [ ] `setup_openclaw`가 exact npm version을 설치하고 재실행해도 수렴한다.
- [ ] 플러그인 disable 후 원문이 복원되고 `rota-approval-gate`는 계속 동작한다.
