# 코딩 원칙 — Jumper v10

이 파일은 Claude Code가 이 프로젝트에서 작업할 때 **반드시 준수해야 할 원칙**을 정의합니다.
새 파일 작성, 기존 파일 수정, 기능 추가 등 모든 작업에 적용됩니다.

---

## 1. 파일 역할 분리 원칙

각 파일은 **단 하나의 책임**만 가진다. 한 파일에 모든 기능을 몰아넣지 않는다.

| 파일 | 역할 | 포함해야 할 것 | 포함하면 안 되는 것 |
|------|------|----------------|---------------------|
| `config.js` | 상수, 경로, 설정값 | API 키, URL, 기본값, 타임아웃 | 로직, DOM 조작 |
| `state.js` | 전역 상태 관리 | 앱 상태 변수, 상태 변경 함수 | UI 갱신, 이벤트 |
| `dom.js` | DOM 참조 캐싱 | `const el = document.getElementById(...)` | 이벤트 바인딩, 로직 |
| `api.js` | 서버 통신 | Firebase 호출, fetch, httpsCallable | DOM 조작, 상태 변경 |
| `utils.js` | 공통 유틸 함수 | 포맷터, 계산, 변환 함수 | 전역 상태, DOM |
| `events.js` | 이벤트 등록 | addEventListener 호출 | 실제 동작 로직 |
| `render.js` | 화면 갱신 함수 | DOM 갱신, 섹션 전환, 마커 업데이트 | 서버 통신, 상태 직접 변경 |
| `performance.js` | 성능 유틸 | throttle, debounce, cache, profiler | 비즈니스 로직 |
| `main.js` | 초기 실행 진입점 | 초기화 호출, 인증 감시 시작 | 실제 로직 구현 |

> **기존 단일 파일 구조 (buggy.js 등)를 신규 기능 추가 시 분리 시작한다.**
> 단, 소규모 수정은 기존 파일을 유지하되 아래 원칙은 파일 내부에서도 적용한다.

---

## 2. DOM 최적화 원칙

### 2-1. DOM 캐싱 필수
```js
// BAD — 매번 조회
function update() {
  document.getElementById('status').textContent = 'OK';
  document.getElementById('status').style.color = 'green';
}

// GOOD — 초기에 캐싱, 재사용
const statusEl = document.getElementById('status');
function update() {
  statusEl.textContent = 'OK';
  statusEl.style.color = 'green';
}
```

### 2-2. 일괄 렌더링 (DocumentFragment / 문자열 누적 후 1회 삽입)
```js
// BAD — 반복 append
items.forEach(item => {
  const div = document.createElement('div');
  div.textContent = item.name;
  list.appendChild(div);       // 매번 리플로우 발생
});

// GOOD — Fragment 또는 문자열 누적 후 1회 삽입
const frag = document.createDocumentFragment();
items.forEach(item => {
  const div = document.createElement('div');
  div.textContent = item.name;
  frag.appendChild(div);
});
list.appendChild(frag);        // 1회만 DOM 변경
```

### 2-3. 스타일 변경은 class 토글 우선
```js
// BAD
el.style.display = 'none';
el.style.opacity = '0';
el.style.pointerEvents = 'none';

// GOOD
el.classList.add('hidden');    // CSS에서 통합 처리
```

### 2-4. 변경된 항목만 갱신 (전체 재생성 금지)
- 목록 데이터가 업데이트될 때 전체 innerHTML을 교체하지 않는다.
- 변경된 항목의 DOM만 찾아서 갱신하거나, 키 기반 diff를 적용한다.
- 단, 최초 렌더링 또는 전체 데이터 교체 시는 예외.

---

## 3. 이벤트 최적화 원칙

### 3-1. 고빈도 이벤트에 throttle 필수

| 이벤트 | throttle 간격 |
|--------|--------------|
| `scroll`, `resize` | 100ms |
| `mousemove`, `touchmove` | 50ms |
| GPS 위치 업데이트 (setInterval) | 3,000ms (현행 유지) |
| 지도 경로 갱신 (DirectionsService) | 8,000–10,000ms (현행 유지) |

```js
// GOOD — throttle 적용 예시
window.addEventListener('scroll', throttle(onScroll, 100), { passive: true });
```

### 3-2. 검색 입력에 debounce 필수
```js
input.addEventListener('input', debounce(onSearch, 350));
```

### 3-3. 중복 addEventListener 방지
- 동일 핸들러를 여러 번 등록하지 않는다.
- `onSnapshot`, `setInterval`, `watchPosition` 등은 기존 인스턴스를 **반드시 해제** 후 재등록.

```js
// GOOD
if (_rideSub) _rideSub();           // 기존 구독 해제
_rideSub = onSnapshot(...);         // 새 구독 등록
```

### 3-4. passive listener 적용
- `scroll`, `touchstart`, `touchmove`, `wheel` 이벤트는 `{ passive: true }` 옵션 추가.

### 3-5. 화면 제거 시 이벤트 해제
- 섹션이 숨겨지거나 컴포넌트가 파괴될 때 이벤트 리스너와 타이머를 정리한다.

---

## 4. 렌더링 최적화 원칙

### 4-1. 실시간 UI는 requestAnimationFrame 사용
```js
// BAD — 직접 갱신
setInterval(() => { timerEl.textContent = getTime(); }, 1000);

// GOOD — rAF 또는 1초 setInterval (1초 이상 간격은 setInterval 허용)
function tick() {
  timerEl.textContent = getTime();
  requestAnimationFrame(tick);   // 60fps 이하 작업에만 적용
}
requestAnimationFrame(tick);
```

### 4-2. 레이아웃 스래싱 방지
- 읽기(getBoundingClientRect, offsetHeight 등)와 쓰기(style 변경)를 교차하지 않는다.
- 읽기를 먼저 모아서 처리한 후, 쓰기를 일괄 처리한다.

### 4-3. Google Maps resize 트리거
- `display:none` → `display:block` 전환 후 반드시 resize 이벤트 트리거.
- 지연은 60–200ms (현행 유지).

```js
setTimeout(() => google.maps.event.trigger(map, 'resize'), 80);
```

---

## 5. 성능 유틸 구현 기준

### throttle
```js
function throttle(fn, ms) {
  let last = 0;
  return (...args) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(...args);
  };
}
```

### debounce
```js
function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
```

### 간단 캐시 (TTL)
```js
function createCache(ttlMs) {
  const store = new Map();
  return {
    get: (key) => {
      const entry = store.get(key);
      if (!entry || Date.now() - entry.ts > ttlMs) return null;
      return entry.value;
    },
    set: (key, value) => store.set(key, { value, ts: Date.now() }),
  };
}
```

---

## 6. 코드 작성 금지 사항

| 금지 | 대안 |
|------|------|
| `document.querySelector` 반복 호출 | 초기 캐싱 후 변수 사용 |
| `innerHTML` 반복 갱신 | Fragment / 누적 문자열 1회 삽입 |
| 이벤트 핸들러 내부에서 직접 DOM 쿼리 | 외부에서 캐싱된 참조 사용 |
| `console.log` 프로덕션 코드에 남기기 | 제거하거나 `// TODO` 표시 |
| 하드코딩된 수수료율, 요금, 타임아웃 값 | `config.js` 또는 Firestore 설정값 참조 |
| 전체 목록 재렌더링으로 단일 항목 업데이트 | 해당 DOM 노드만 찾아 갱신 |
| `async` 함수 내 `await` 없는 `try/catch` | 불필요한 `try/catch` 제거 |
| 해제하지 않는 `setInterval` / `onSnapshot` | 반드시 cleanup 변수 유지 |

---

## 7. 파일 크기 기준

| 파일 유형 | 권장 최대 줄 수 |
|-----------|----------------|
| 단일 기능 JS 파일 | 300줄 |
| 페이지별 JS (기존 통합 파일) | 700줄 (초과 시 분리 검토) |
| CSS 파일 | 600줄 (초과 시 컴포넌트별 분리) |

> 현재 `buggy.js`, `buggy-driver.js` 등은 통합 파일로 유지하되,
> 신규 기능 추가 시 위 원칙을 파일 내부에 적용하고 함수를 역할별로 그룹화한다.

---

## 8. 커밋 메시지 규칙

```
type: 짧은 요약 (한/영 혼용 가능)

- type: feat | fix | refactor | perf | style | docs | chore
- 본문: 변경 이유 + 변경 내용 bullet
```


